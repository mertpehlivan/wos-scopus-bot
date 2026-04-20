#Requires -RunAsAdministrator
<#
.SYNOPSIS
    WoS/Scopus Bot Windows Server 2022 Kurulum Scripti (Docker'siz)
.DESCRIPTION
    Bu script; PostgreSQL 16, Java 21, Apache Maven ve WoS/Scopus Bot'u
    Windows Server 2022 uzerinde Docker olmadan kurar.
    Uygulama Windows Servisi olarak kaydedilir.
    Port 8081 (API) ve 5433 (PostgreSQL) icin Firewall kurallari eklenir.
.NOTES
    PowerShell 5.1+ ile calistirin. Yonetici haklari gerekir.
    Varsayilan kurulum dizini: C:\Tools
    Servis adi: WosScopusBot
#>

$ErrorActionPreference = "Stop"

# ============================================================
# PARAMETRELER
# ============================================================
$InstallDir    = "C:\Tools"
$JdkDir        = Join-Path $InstallDir "jdk-21"
$MavenDir      = Join-Path $InstallDir "apache-maven-3.9.9"
$NssmDir       = Join-Path $InstallDir "nssm-2.24.4"
$ServiceName   = "WosScopusBot"
$ServiceDesc   = "WoS/Scopus Article Task Broker"
$AppPort       = 8081
$ProjectDir    = Split-Path $PSScriptRoot -Parent   # scripts klasorunun ust dizini

# PostgreSQL ayarlari (application.yml ile eslesmeli)
$PgVersion     = "16"
$PgPort        = 5433
$PgServiceName = "postgresql-x64-$PgVersion"
$PgSuperPass   = "password"
$PgDbName      = "article_broker"
$PgUser        = "postgres"
$PgBinZipUrl    = "https://get.enterprisedb.com/postgresql/postgresql-16.6-1-windows-x64-binaries.zip"
$PgDefaultDir   = "C:\Program Files\PostgreSQL\$PgVersion"
$PgBinDir       = "$PgDefaultDir\bin"
$PgDataDir      = "$PgDefaultDir\data"

# Diger URL'ler
$JdkUrl   = "https://github.com/adoptium/temurin21-binaries/releases/download/jdk-21.0.5%2B11/OpenJDK21U-jdk_x64_windows_hotspot_21.0.5_11.zip"
$MavenUrl = "https://archive.apache.org/dist/maven/maven-3/3.9.9/binaries/apache-maven-3.9.9-bin.zip"
$NssmUrl  = "https://nssm.cc/release/nssm-2.24.zip"

# ============================================================
# YARDIMCI FONKSIYONLAR
# ============================================================
function Write-Step {
    param([string]$Message)
    Write-Host "`n[+] $Message" -ForegroundColor Cyan
}

function Test-CommandExists {
    param([string]$Command)
    return [bool](Get-Command $Command -ErrorAction SilentlyContinue)
}

function Invoke-DownloadAndExtract {
    param(
        [string]$Url,
        [string]$DestDir,
        [string]$Label
    )
    if (Test-Path $DestDir) {
        Write-Host "    $Label zaten mevcut: $DestDir" -ForegroundColor Yellow
        return
    }

    $zipFile = Join-Path $env:TEMP "$Label.zip"
    Write-Host "    Indiriliyor: $Url ..."
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
    Invoke-WebRequest -Uri $Url -OutFile $zipFile -UseBasicParsing

    Write-Host "    Arsiv aciliyor..."
    Expand-Archive -Path $zipFile -DestinationPath $InstallDir -Force
    Remove-Item $zipFile -Force

    Write-Host "    $Label kuruldu: $DestDir" -ForegroundColor Green
}

function Add-ToMachinePath {
    param([string]$NewPath)
    $current = [Environment]::GetEnvironmentVariable("Path", "Machine")
    if ($current -notlike "*$NewPath*") {
        [Environment]::SetEnvironmentVariable("Path", "$current;$NewPath", "Machine")
        $env:Path = "$env:Path;$NewPath"
        Write-Host "    PATH'e eklendi: $NewPath" -ForegroundColor Green
    } else {
        Write-Host "    PATH'te zaten mevcut: $NewPath" -ForegroundColor Yellow
    }
}

function Add-FirewallRule {
    param([string]$RuleName, [int]$Port, [string]$Description)
    $existing = Get-NetFirewallRule -DisplayName $RuleName -ErrorAction SilentlyContinue
    if ($existing) {
        Write-Host "    Firewall kurali zaten mevcut: $RuleName" -ForegroundColor Yellow
    } else {
        New-NetFirewallRule `
            -DisplayName  $RuleName `
            -Direction    Inbound `
            -Protocol     TCP `
            -LocalPort    $Port `
            -Action       Allow `
            -Profile      Any `
            -Description  $Description | Out-Null
        Write-Host "    Firewall kurali eklendi: TCP $Port -> $RuleName" -ForegroundColor Green
    }
}

# ============================================================
# ADMIN KONTROLU
# ============================================================
Write-Step "Yonetici haklari kontrol ediliyor..."
$identity  = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = New-Object Security.Principal.WindowsPrincipal($identity)
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    Write-Error "Bu script Yonetici (Administrator) olarak calistirilmalidir."
    exit 1
}

# ============================================================
# KURULUM DIZINI
# ============================================================
Write-Step "Kurulum dizini hazirlaniyor: $InstallDir"
New-Item -ItemType Directory -Path $InstallDir -Force | Out-Null

# ============================================================
# POSTGRESQL 16 (NATIVE)
# ============================================================
Write-Step "PostgreSQL $PgVersion kontrol ediliyor / kuruluyor (binary zip yontemi)..."

$pgSvc = Get-Service -Name $PgServiceName -ErrorAction SilentlyContinue
if ($pgSvc) {
    Write-Host "    PostgreSQL $PgVersion servisi zaten kurulu ($PgServiceName)." -ForegroundColor Green
} else {
    # 1) Binary zip indir
    $pgZip = Join-Path $env:TEMP "pg16-binaries.zip"
    Write-Host "    Binary zip indiriliyor (~130 MB) ..."
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
    Invoke-WebRequest -Uri $PgBinZipUrl -OutFile $pgZip -UseBasicParsing

    # 2) Zip'i gecici dizine ac (pgsql/ alt klasoru olusur)
    Write-Host "    Arsiv aciliyor..."
    $pgExtractTemp = Join-Path $env:TEMP "pg16-extract"
    if (Test-Path $pgExtractTemp) { Remove-Item $pgExtractTemp -Recurse -Force }
    Expand-Archive -Path $pgZip -DestinationPath $pgExtractTemp -Force
    Remove-Item $pgZip -Force

    # 3) pgsql/ klasorunu hedef dizine tasi
    $pgSrcDir = Join-Path $pgExtractTemp "pgsql"
    $pgParent = "C:\Program Files\PostgreSQL"
    New-Item -ItemType Directory -Path $pgParent -Force | Out-Null
    if (Test-Path $PgDefaultDir) { Remove-Item $PgDefaultDir -Recurse -Force }
    Move-Item -Path $pgSrcDir -Destination $PgDefaultDir -Force
    Remove-Item $pgExtractTemp -Recurse -Force -ErrorAction SilentlyContinue
    Write-Host "    Binary dosyalar hazir: $PgDefaultDir" -ForegroundColor Green

    # 4) PATH'e ekle (initdb icin gerekli)
    Add-ToMachinePath -NewPath $PgBinDir
    $env:Path = "$env:Path;$PgBinDir"

    # 5) Veri dizinini olustur ve initdb calistir
    New-Item -ItemType Directory -Path $PgDataDir -Force | Out-Null
    $pwFile = Join-Path $env:TEMP "pgpw.tmp"
    Set-Content -Path $pwFile -Value $PgSuperPass -Encoding ASCII
    Write-Host "    initdb calistiriliyor (veritabani kumu olusturuluyor)..."
    & "$PgBinDir\initdb.exe" `
        --pgdata="$PgDataDir" `
        --username=$PgUser `
        --pwfile="$pwFile" `
        --encoding=UTF8 `
        --locale=C
    Remove-Item $pwFile -Force -ErrorAction SilentlyContinue
    if ($LASTEXITCODE -ne 0) {
        Write-Error "initdb basarisiz oldu."
        exit 1
    }

    # 6) postgresql.conf icinde portu guncelle
    $pgConf = "$PgDataDir\postgresql.conf"
    (Get-Content $pgConf) `
        -replace "^#?port\s*=\s*\d+", "port = $PgPort" `
        | Set-Content $pgConf
    Write-Host "    PostgreSQL portu $PgPort olarak ayarlandi." -ForegroundColor Green

    # 7) pg_hba.conf: md5 yerine scram-sha-256, yerel erisim
    # (varsayilan ayarlar yeterli, islem yapma)

    # 8) Windows servisi olarak kaydet
    Write-Host "    Windows servisi kaydediliyor: $PgServiceName ..."
    & "$PgBinDir\pg_ctl.exe" register `
        -N $PgServiceName `
        -D "$PgDataDir" `
        -S auto `
        -w
    if ($LASTEXITCODE -ne 0) {
        Write-Error "pg_ctl register basarisiz oldu."
        exit 1
    }
    Write-Host "    PostgreSQL $PgVersion kuruldu ve servis olarak kaydedildi." -ForegroundColor Green
}

# PgBin PATH'e ekle (zaten kurulu durumda PATH'e eklenmemis olabilir)
Add-ToMachinePath -NewPath $PgBinDir
$env:Path = "$env:Path;$PgBinDir"

# PostgreSQL servisini baslat
$pgSvcNow = Get-Service -Name $PgServiceName -ErrorAction SilentlyContinue
if ($pgSvcNow -and $pgSvcNow.Status -ne "Running") {
    Write-Host "    PostgreSQL servisi baslatiliyor..."
    Start-Service -Name $PgServiceName
    Start-Sleep -Seconds 5
}

# Veritabani olustur (yoksa)
Write-Step "Veritabani kontrol ediliyor / olusturuluyor: '$PgDbName'..."
$env:PGPASSWORD = $PgSuperPass
$dbExists = & "$PgBinDir\psql.exe" -U $PgUser -p $PgPort -tAc "SELECT 1 FROM pg_database WHERE datname='$PgDbName';" 2>$null
if ($dbExists -eq "1") {
    Write-Host "    Veritabani zaten mevcut: $PgDbName" -ForegroundColor Yellow
} else {
    & "$PgBinDir\createdb.exe" -U $PgUser -p $PgPort $PgDbName
    if ($LASTEXITCODE -eq 0) {
        Write-Host "    Veritabani olusturuldu: $PgDbName" -ForegroundColor Green
    } else {
        Write-Error "Veritabani olusturulamadi."
        exit 1
    }
}
Remove-Item Env:\PGPASSWORD -ErrorAction SilentlyContinue

# ============================================================
# JAVA 21
# ============================================================
Write-Step "Java 21 kontrol ediliyor / kuruluyor..."

$javaRaw = $null
try { $javaRaw = (& java -version 2>&1) | Out-String } catch {}
$javaVersion = $null
if ($javaRaw -match '"(\d+)') { $javaVersion = $Matches[1] }

if ($javaVersion -eq "21") {
    Write-Host "    Java 21 zaten kurulu." -ForegroundColor Green
} else {
    Invoke-DownloadAndExtract -Url $JdkUrl -DestDir $JdkDir -Label "jdk-21"

    $extractedJdk = Get-ChildItem -Path $InstallDir -Directory |
                    Where-Object { $_.Name -like "jdk-21*" -and $_.FullName -ne $JdkDir } |
                    Select-Object -First 1
    if ($extractedJdk) {
        Rename-Item -Path $extractedJdk.FullName -NewName (Split-Path $JdkDir -Leaf) -Force
    }

    [Environment]::SetEnvironmentVariable("JAVA_HOME", $JdkDir, "Machine")
    $env:JAVA_HOME = $JdkDir
    Add-ToMachinePath -NewPath "$JdkDir\bin"
}

# ============================================================
# MAVEN
# ============================================================
Write-Step "Apache Maven kontrol ediliyor / kuruluyor..."
if (Test-CommandExists "mvn") {
    $mvnRaw = (& mvn -version 2>&1 | Out-String)
    if ($mvnRaw -match "Apache Maven (\d+\.\d+\.\d+)") {
        Write-Host "    Maven $($Matches[1]) zaten kurulu." -ForegroundColor Green
    }
} else {
    Invoke-DownloadAndExtract -Url $MavenUrl -DestDir $MavenDir -Label "apache-maven"

    $extractedMvn = Get-ChildItem -Path $InstallDir -Directory |
                    Where-Object { $_.Name -like "apache-maven-*" -and $_.FullName -ne $MavenDir } |
                    Select-Object -First 1
    if ($extractedMvn) {
        Rename-Item -Path $extractedMvn.FullName -NewName (Split-Path $MavenDir -Leaf) -Force
    }

    [Environment]::SetEnvironmentVariable("MAVEN_HOME", $MavenDir, "Machine")
    $env:MAVEN_HOME = $MavenDir
    Add-ToMachinePath -NewPath "$MavenDir\bin"
}

# Oturum PATH'ini yenile
$env:Path = [Environment]::GetEnvironmentVariable("Path", "Machine")

# ============================================================
# PROJEYI BUILD ET
# ============================================================
Write-Step "WoS/Scopus Bot build ediliyor..."
if (-not (Test-Path $ProjectDir)) {
    Write-Error "Proje dizini bulunamadi: $ProjectDir"
    exit 1
}

Write-Host "    Proje dizini: $ProjectDir"
Push-Location $ProjectDir
try {
    & "$MavenDir\bin\mvn.cmd" clean package -DskipTests
    if ($LASTEXITCODE -ne 0) { throw "Maven build basarisiz oldu (exit code: $LASTEXITCODE)." }
} finally {
    Pop-Location
}

$jarFile = Get-ChildItem -Path "$ProjectDir\target" -Filter "article-task-broker-*.jar" |
           Where-Object { $_.Name -notlike "*sources*" -and $_.Name -notlike "*javadoc*" } |
           Select-Object -First 1
if (-not $jarFile) {
    Write-Error "JAR dosyasi bulunamadi. Build basarisiz olmus olabilir."
    exit 1
}
Write-Host "    Build basarili: $($jarFile.FullName)" -ForegroundColor Green

# ============================================================
# NSSM
# ============================================================
Write-Step "NSSM (Servis Yoneticisi) kontrol ediliyor / kuruluyor..."
$nssmExe = Join-Path $NssmDir "win64\nssm.exe"
$useNssm = $true

if (Test-Path $nssmExe) {
    Write-Host "    NSSM zaten mevcut." -ForegroundColor Green
} else {
    $nssmUrls = @(
        "https://nssm.cc/release/nssm-2.24.zip",
        "https://github.com/kirillkovalenko/nssm/releases/download/nssm-2.24/nssm-2.24.zip",
        "https://github.com/lehungio/nssm/releases/download/2.24/nssm-2.24.zip"
    )
    $nssmOk = $false
    foreach ($url in $nssmUrls) {
        try {
            Write-Host "    NSSM deneniyor: $url"
            $nssmZip = Join-Path $env:TEMP "nssm.zip"
            [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
            Invoke-WebRequest -Uri $url -OutFile $nssmZip -UseBasicParsing -TimeoutSec 45
            Expand-Archive -Path $nssmZip -DestinationPath $InstallDir -Force
            Remove-Item $nssmZip -Force -ErrorAction SilentlyContinue
            $extractedNssm = Get-ChildItem -Path $InstallDir -Directory |
                             Where-Object { $_.Name -like "nssm*" -and $_.FullName -ne $NssmDir } |
                             Select-Object -First 1
            if ($extractedNssm) {
                if (Test-Path $NssmDir) { Remove-Item $NssmDir -Recurse -Force }
                Rename-Item -Path $extractedNssm.FullName -NewName (Split-Path $NssmDir -Leaf) -Force
            }
            # nssm-2.24 zip'i win64/ altinda degil, dogrudan nssm.exe icerebilir
            if (-not (Test-Path $nssmExe)) {
                $altExe = Get-ChildItem -Path $NssmDir -Filter "nssm.exe" -Recurse -ErrorAction SilentlyContinue | Select-Object -First 1
                if ($altExe) {
                    $nssmWin64 = Join-Path $NssmDir "win64"
                    New-Item -ItemType Directory -Path $nssmWin64 -Force | Out-Null
                    Copy-Item -Path $altExe.FullName -Destination $nssmExe -Force
                }
            }
            if (Test-Path $nssmExe) { $nssmOk = $true; Write-Host "    NSSM indirildi." -ForegroundColor Green; break }
        } catch {
            Write-Host "    Basarisiz: $_" -ForegroundColor Yellow
        }
    }
    if (-not $nssmOk) {
        Write-Warning "NSSM indirilemedi. New-Service ile servis kurulacak."
        $useNssm = $false
    }
}

# ============================================================
# MEVCUT SERVISI KALDIR (varsa)
# ============================================================
Write-Step "Mevcut '$ServiceName' servisi kontrol ediliyor..."
$existing = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
if ($existing) {
    Write-Host "    Eski servis kaldiriliyor..." -ForegroundColor Yellow
    Stop-Service -Name $ServiceName -Force -ErrorAction SilentlyContinue
    Start-Sleep -Seconds 2
    if ($useNssm -and (Test-Path $nssmExe)) {
        & $nssmExe remove $ServiceName confirm 2>$null
    } else {
        cmd /c "sc.exe delete $ServiceName" | Out-Null
    }
    Start-Sleep -Seconds 2
}

# ============================================================
# WINDOWS SERVISI OLUSTUR
# ============================================================
Write-Step "Windows Servisi olusturuluyor: $ServiceName"
$javaExe = Join-Path $JdkDir "bin\java.exe"
$logDir  = Join-Path $ProjectDir "logs"
New-Item -ItemType Directory -Path $logDir -Force | Out-Null

if ($useNssm -and (Test-Path $nssmExe)) {
    & $nssmExe install $ServiceName $javaExe "-jar `"$($jarFile.FullName)`""
    & $nssmExe set $ServiceName Description    $ServiceDesc
    & $nssmExe set $ServiceName DisplayName    $ServiceName
    & $nssmExe set $ServiceName Start          SERVICE_AUTO_START
    & $nssmExe set $ServiceName AppStdout      "$logDir\stdout.log"
    & $nssmExe set $ServiceName AppStderr      "$logDir\stderr.log"
    & $nssmExe set $ServiceName AppRotateFiles  1
    & $nssmExe set $ServiceName AppRotateOnline 0
    & $nssmExe set $ServiceName AppRotateBytes  10485760
    & $nssmExe set $ServiceName AppDirectory   $ProjectDir
    & $nssmExe set $ServiceName DependOnService $PgServiceName
    Write-Host "    NSSM ile servis olusturuldu." -ForegroundColor Green
} else {
    # NSSM yok: PowerShell New-Service ile kur (quoting sorunsuz)
    $svcBinPath = "`"$javaExe`" -jar `"$($jarFile.FullName)`""
    try {
        New-Service `
            -Name        $ServiceName `
            -BinaryPathName $svcBinPath `
            -DisplayName $ServiceName `
            -StartupType Automatic `
            -Description $ServiceDesc `
            -ErrorAction Stop | Out-Null
        # PostgreSQL bagimliligi ekle
        sc.exe config $ServiceName depend= $PgServiceName | Out-Null
        Write-Host "    New-Service ile servis olusturuldu." -ForegroundColor Green
    } catch {
        Write-Error "Servis olusturulamadi: $_"
        exit 1
    }
}

# ============================================================
# FIREWALL KURALLARI
# ============================================================
Write-Step "Windows Firewall kurallari ekleniyor..."
Add-FirewallRule -RuleName "WosScopusBot-API-$AppPort"      -Port $AppPort -Description "WoS/Scopus Bot HTTP API portu"
Add-FirewallRule -RuleName "WosScopusBot-PostgreSQL-$PgPort" -Port $PgPort  -Description "WoS/Scopus Bot PostgreSQL portu"

# ============================================================
# SCM TIMEOUT ARTIR (Spring Boot ~33sn'de basliyor, varsayilan 30sn)
# ============================================================
Write-Step "Windows SCM servis baslama timeout'u artiriliyor (120 sn)..."
$scmKey = "HKLM:\SYSTEM\CurrentControlSet\Control"
$currentTimeout = (Get-ItemProperty -Path $scmKey -Name "ServicesPipeTimeout" -ErrorAction SilentlyContinue).ServicesPipeTimeout
if (-not $currentTimeout -or $currentTimeout -lt 120000) {
    Set-ItemProperty -Path $scmKey -Name "ServicesPipeTimeout" -Value 120000 -Type DWord
    Write-Host "    ServicesPipeTimeout 120000 ms (120 sn) olarak ayarlandi." -ForegroundColor Green
} else {
    Write-Host "    ServicesPipeTimeout zaten yeterli: $currentTimeout ms" -ForegroundColor Yellow
}

# ============================================================
# SERVISI BASLAT
# ============================================================
Write-Step "Servis baslatiliyor: $ServiceName"
Start-Service -Name $ServiceName -ErrorAction SilentlyContinue
Write-Host "    Baslamasini bekleniyor (60 sn maks)..."
for ($i = 0; $i -lt 12; $i++) {
    Start-Sleep -Seconds 5
    $svc = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
    if ($svc -and $svc.Status -eq "Running") {
        Write-Host "    Servis calisiyor! ($($i*5+5) sn)" -ForegroundColor Green
        break
    }
    Write-Host "    Bekleniyor... $($i*5+5) sn" -ForegroundColor Yellow
}
$svc = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
if (-not ($svc -and $svc.Status -eq "Running")) {
    Write-Warning "Servis $ServiceName baslamadi. Durum: $($svc.Status)"
    Write-Warning "Event Log icin: Get-EventLog -LogName Application -Source '*java*' -Newest 10"
}

# ============================================================
# OZET
# ============================================================
Write-Host "`n========================================" -ForegroundColor Green
Write-Host "  KURULUM TAMAMLANDI" -ForegroundColor Green
Write-Host "========================================" -ForegroundColor Green
Write-Host " Servis Adi         : $ServiceName"
Write-Host " JAR Dosyasi        : $($jarFile.FullName)"
Write-Host " Log Dizini         : $logDir"
Write-Host " Uygulama Portu     : $AppPort  (Firewall: acik)"
Write-Host " PostgreSQL Portu   : $PgPort   (Firewall: acik)"
Write-Host " PostgreSQL DB      : $PgDbName"
Write-Host " PostgreSQL Kullanici: $PgUser"
Write-Host "`n DIKKAT:"
Write-Host " - application.yml'deki sifre gonderildiginde degistirin."
Write-Host " - BROKER_API_KEY ortam degiskenini mutlaka ayarlayin:"
Write-Host "   [Environment]::SetEnvironmentVariable('BROKER_API_KEY','<key>','Machine')"
Write-Host " - Servis yonetimi:"
Write-Host "     Start-Service -Name $ServiceName"
Write-Host "     Stop-Service  -Name $ServiceName"
if ($useNssm -and (Test-Path $nssmExe)) {
    Write-Host "     & '$nssmExe' edit $ServiceName"
}
Write-Host "`n========================================"

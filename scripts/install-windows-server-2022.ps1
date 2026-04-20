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
$PgInstallerUrl = "https://get.enterprisedb.com/postgresql/postgresql-16.6-1-windows-x64.exe"
$PgInstaller    = Join-Path $env:TEMP "pg16-installer.exe"
$PgDefaultDir   = "C:\Program Files\PostgreSQL\$PgVersion"
$PgBinDir       = "$PgDefaultDir\bin"

# Diger URL'ler
$JdkUrl   = "https://github.com/adoptium/temurin21-binaries/releases/download/jdk-21.0.5%2B11/OpenJDK21U-jdk_x64_windows_hotspot_21.0.5_11.zip"
$MavenUrl = "https://archive.apache.org/dist/maven/maven-3/3.9.9/binaries/apache-maven-3.9.9-bin.zip"
$NssmUrl  = "https://github.com/puppetlabs/nssm/releases/download/2.24.4/nssm-2.24.4.zip"

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
Write-Step "PostgreSQL $PgVersion kontrol ediliyor / kuruluyor..."

$pgSvc = Get-Service -Name $PgServiceName -ErrorAction SilentlyContinue
if ($pgSvc) {
    Write-Host "    PostgreSQL $PgVersion servisi zaten kurulu ($PgServiceName)." -ForegroundColor Green
} else {
    Write-Host "    PostgreSQL $PgVersion indiriliyor: $PgInstallerUrl ..."
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
    Invoke-WebRequest -Uri $PgInstallerUrl -OutFile $PgInstaller -UseBasicParsing

    Write-Host "    PostgreSQL sessiz kurulum basliyor (birkaç dakika surebilir)..."
    $pgArgs = @(
        "--mode", "unattended",
        "--unattendedmodeui", "none",
        "--superpassword", $PgSuperPass,
        "--servicename", $PgServiceName,
        "--serverport", $PgPort,
        "--datadir", "$PgDefaultDir\data",
        "--prefix", $PgDefaultDir,
        "--install_runtimes", "1",
        "--debuglevel", "2"
    )
    $proc = Start-Process -FilePath $PgInstaller -ArgumentList $pgArgs -Wait -PassThru -WindowStyle Hidden
    Remove-Item $PgInstaller -Force -ErrorAction SilentlyContinue

    if ($proc.ExitCode -ne 0) {
        Write-Host "    HATA: PostgreSQL kurulumu basarisiz oldu. Exit code: $($proc.ExitCode)" -ForegroundColor Red
        Write-Host "    Log icin: Get-ChildItem `$env:TEMP -Filter 'postgresql-*.log' | Sort LastWriteTime | Select -Last 1 | Get-Content | Select -Last 50" -ForegroundColor Yellow
        Write-Error "PostgreSQL kurulumu basarisiz oldu. Exit code: $($proc.ExitCode)"
        exit 1
    }
    Write-Host "    PostgreSQL $PgVersion kuruldu." -ForegroundColor Green
}

# PgBin PATH'e ekle
Add-ToMachinePath -NewPath $PgBinDir
$env:Path = "$env:Path;$PgBinDir"

# PostgreSQL servisini baslat
$pgSvcNow = Get-Service -Name $PgServiceName -ErrorAction SilentlyContinue
if ($pgSvcNow -and $pgSvcNow.Status -ne "Running") {
    Write-Host "    PostgreSQL servisi baslatiliyor..."
    Start-Service -Name $PgServiceName
    Start-Sleep -Seconds 4
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
    try {
        Invoke-DownloadAndExtract -Url $NssmUrl -DestDir $NssmDir -Label "nssm"
        $extractedNssm = Get-ChildItem -Path $InstallDir -Directory |
                         Where-Object { $_.Name -like "nssm-*" -and $_.FullName -ne $NssmDir } |
                         Select-Object -First 1
        if ($extractedNssm) {
            Rename-Item -Path $extractedNssm.FullName -NewName (Split-Path $NssmDir -Leaf) -Force
        }
    } catch {
        Write-Warning "NSSM indirilemedi: $_"
        Write-Warning "Windows'un yerel sc.exe araci ile servis kurulacak."
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
    & $nssmExe set $ServiceName AppRotateBytes  10485760   # 10 MB
    & $nssmExe set $ServiceName AppDirectory   $ProjectDir
    # PostgreSQL servisi hazir olmadan baslamasin
    & $nssmExe set $ServiceName DependOnService $PgServiceName
    Write-Host "    NSSM ile servis olusturuldu." -ForegroundColor Green
} else {
    $binPath = "`"$javaExe`" -jar `"$($jarFile.FullName)`""
    $scArgs  = "create $ServiceName binPath= `"$binPath`" start= auto DisplayName= `"$ServiceName`""
    cmd /c "sc.exe $scArgs"
    cmd /c "sc.exe description $ServiceName `"$ServiceDesc`""
    # Bagimliligi ekle
    cmd /c "sc.exe config $ServiceName depend= $PgServiceName"
    Write-Host "    sc.exe ile servis olusturuldu." -ForegroundColor Green
    Write-Warning "Log rotasyonu ve calisma dizini ayarlari sc.exe ile sinirlidir."
}

# ============================================================
# FIREWALL KURALLARI
# ============================================================
Write-Step "Windows Firewall kurallari ekleniyor..."
Add-FirewallRule -RuleName "WosScopusBot-API-$AppPort"      -Port $AppPort -Description "WoS/Scopus Bot HTTP API portu"
Add-FirewallRule -RuleName "WosScopusBot-PostgreSQL-$PgPort" -Port $PgPort  -Description "WoS/Scopus Bot PostgreSQL portu"

# ============================================================
# SERVISI BASLAT
# ============================================================
Write-Step "Servis baslatiliyor: $ServiceName"
Start-Service -Name $ServiceName -ErrorAction SilentlyContinue
Start-Sleep -Seconds 5
$svc = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
if ($svc -and $svc.Status -eq "Running") {
    Write-Host "    Servis calisiyor!" -ForegroundColor Green
} else {
    Write-Warning "Servis hemen calismaya baslamadi. Loglari kontrol edin: $logDir"
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

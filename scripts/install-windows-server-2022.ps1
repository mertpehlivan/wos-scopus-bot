#Requires -RunAsAdministrator
<#
.SYNOPSIS
    WoS/Scopus Bot Windows Server 2022 Kurulum Scripti
.DESCRIPTION
    Bu script; Java 21, Apache Maven ve WoS/Scopus Bot'u Windows Server 2022
    uzerinde Windows Servisi olarak kurar.
.NOTES
    PowerShell 5.1+ ile calistirin. Yonetici haklari gerekir.
    Varsayilan kurulum dizini: C:\Tools
    Servis adi: WosScopusBot
#>

$ErrorActionPreference = "Stop"

# ---------- Parametreler ----------
$InstallDir    = "C:\Tools"
$JdkDir        = Join-Path $InstallDir "jdk-21"
$MavenDir      = Join-Path $InstallDir "apache-maven-3.9.9"
$NssmDir       = Join-Path $InstallDir "nssm-2.24.4"
$ServiceName   = "WosScopusBot"
$ServiceDesc   = "WoS/Scopus Article Task Broker"
$ProjectDir    = Split-Path $PSScriptRoot -Parent   # scripts klasorunun ust dizini

# URL'ler
$JdkUrl   = "https://github.com/adoptium/temurin21-binaries/releases/download/jdk-21.0.5%2B11/OpenJDK21U-jdk_x64_windows_hotspot_21.0.5_11.zip"
$MavenUrl = "https://archive.apache.org/dist/maven/maven-3/3.9.9/binaries/apache-maven-3.9.9-bin.zip"
$NssmUrl  = "https://github.com/puppetlabs/nssm/releases/download/2.24.4/nssm-2.24.4.zip"

# ---------- Yardimci Fonksiyonlar ----------
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

# ---------- Admin Kontrolu ----------
Write-Step "Yonetici haklari kontrol ediliyor..."
$identity  = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = New-Object Security.Principal.WindowsPrincipal($identity)
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    Write-Error "Bu script Yonetici (Administrator) olarak calistirilmalidir."
    exit 1
}

# ---------- Kurulum Dizini ----------
Write-Step "Kurulum dizini hazirlaniyor: $InstallDir"
New-Item -ItemType Directory -Path $InstallDir -Force | Out-Null

# ---------- Java 21 ----------
Write-Step "Java 21 kontrol ediliyor / kuruluyor..."
$javaVersion = $null
try { $javaVersion = & java -version 2>&1 | Select-String -Pattern '"(\d+)' | ForEach-Object { $_.Matches.Groups[1].Value } } catch {}

if ($javaVersion -eq "21") {
    Write-Host "    Java 21 zaten kurulu." -ForegroundColor Green
} else {
    Invoke-DownloadAndExtract -Url $JdkUrl -DestDir $JdkDir -Label "jdk-21"

    # JDK icindeki alt klasoru bul (ornegin: jdk-21.0.5+11)
    $extractedJdk = Get-ChildItem -Path $InstallDir -Directory | Where-Object { $_.Name -like "jdk-21*" } | Select-Object -First 1
    if ($extractedJdk -and ($extractedJdk.FullName -ne $JdkDir)) {
        Rename-Item -Path $extractedJdk.FullName -NewName $JdkDir -Force
    }

    [Environment]::SetEnvironmentVariable("JAVA_HOME", $JdkDir, "Machine")
    $env:JAVA_HOME = $JdkDir
    Add-ToMachinePath -NewPath "$JdkDir\bin"
}

# ---------- Maven ----------
Write-Step "Apache Maven kontrol ediliyor / kuruluyor..."
if (Test-CommandExists "mvn") {
    $mvnVer = (& mvn -version 2>$null | Select-String -Pattern "Apache Maven (\d+\.\d+\.\d+)" | ForEach-Object { $_.Matches.Groups[1].Value })
    Write-Host "    Maven $mvnVer zaten kurulu." -ForegroundColor Green
} else {
    Invoke-DownloadAndExtract -Url $MavenUrl -DestDir $MavenDir -Label "apache-maven"

    [Environment]::SetEnvironmentVariable("MAVEN_HOME", $MavenDir, "Machine")
    $env:MAVEN_HOME = $MavenDir
    Add-ToMachinePath -NewPath "$MavenDir\bin"
}

# Refresh environment variables in current session
$env:Path = [Environment]::GetEnvironmentVariable("Path", "Machine")

# ---------- Projeyi Build Et ----------
Write-Step "WoS/Scopus Bot build ediliyor..."
if (-not (Test-Path $ProjectDir)) {
    Write-Error "Proje dizini bulunamadi: $ProjectDir"
    exit 1
}

Write-Host "    Proje dizini: $ProjectDir"
Push-Location $ProjectDir
try {
    & "$MavenDir\bin\mvn.cmd" clean package -DskipTests
    if ($LASTEXITCODE -ne 0) { throw "Maven build basarisiz oldu." }
} finally {
    Pop-Location
}

$jarFile = Get-ChildItem -Path "$ProjectDir\target" -Filter "article-task-broker-*.jar" | Where-Object { $_.Name -notlike "*sources*" -and $_.Name -notlike "*javadoc*" } | Select-Object -First 1
if (-not $jarFile) {
    Write-Error "JAR dosyasi bulunamadi. Build basarisiz olmus olabilir."
    exit 1
}
Write-Host "    Build basarili: $($jarFile.FullName)" -ForegroundColor Green

# ---------- NSSM (Non-Sucking Service Manager) ----------
Write-Step "NSSM (Servis Yoneticisi) kontrol ediliyor / kuruluyor..."
$nssmExe = Join-Path $NssmDir "win64\nssm.exe"
if (Test-Path $nssmExe) {
    Write-Host "    NSSM zaten mevcut." -ForegroundColor Green
} else {
    Invoke-DownloadAndExtract -Url $NssmUrl -DestDir $NssmDir -Label "nssm"
    # NSSM icindeki alt klasor ismini duzelt
    $extractedNssm = Get-ChildItem -Path $InstallDir -Directory | Where-Object { $_.Name -like "nssm-*" } | Select-Object -First 1
    if ($extractedNssm -and ($extractedNssm.FullName -ne $NssmDir)) {
        Rename-Item -Path $extractedNssm.FullName -NewName $NssmDir -Force
    }
}

# ---------- Mevcut Servisi Kaldir (varsa) ----------
Write-Step "Mevcut servis kontrol ediliyor..."
$existing = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
if ($existing) {
    Write-Host "    Eski servis kaldiriliyor..." -ForegroundColor Yellow
    Stop-Service -Name $ServiceName -Force -ErrorAction SilentlyContinue
    & $nssmExe remove $ServiceName confirm 2>$null
    sc.exe delete $ServiceName 2>$null | Out-Null
    Start-Sleep -Seconds 2
}

# ---------- Windows Servisi Olustur ----------
Write-Step "Windows Servisi olusturuluyor: $ServiceName"
$javaExe = Join-Path $JdkDir "bin\java.exe"
$logDir  = Join-Path $ProjectDir "logs"
New-Item -ItemType Directory -Path $logDir -Force | Out-Null

& $nssmExe install $ServiceName $javaExe "-jar `"$($jarFile.FullName)`""
& $nssmExe set $ServiceName Description $ServiceDesc
& $nssmExe set $ServiceName DisplayName $ServiceName
& $nssmExe set $ServiceName Start SERVICE_AUTO_START
& $nssmExe set $ServiceName AppStdout "$logDir\stdout.log"
& $nssmExe set $ServiceName AppStderr "$logDir\stderr.log"
& $nssmExe set $ServiceName AppRotateFiles 1
& $nssmExe set $ServiceName AppRotateOnline 0
& $nssmExe set $ServiceName AppRotateBytes 10485760   # 10 MB

# Calisma dizinini proje dizini yap
& $nssmExe set $ServiceName AppDirectory $ProjectDir

Write-Host "    Servis olusturuldu." -ForegroundColor Green

# ---------- Servisi Baslat ----------
Write-Step "Servis baslatiliyor: $ServiceName"
Start-Service -Name $ServiceName -ErrorAction SilentlyContinue
Start-Sleep -Seconds 3
$svc = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
if ($svc -and $svc.Status -eq "Running") {
    Write-Host "    Servis calisiyor!" -ForegroundColor Green
} else {
    Write-Warning "Servis hemen calismaya baslamadi. Loglari kontrol edin: $logDir"
}

# ---------- Ozet ----------
Write-Host "`n========================================" -ForegroundColor Green
Write-Host "  KURULUM TAMAMLANDI" -ForegroundColor Green
Write-Host "========================================" -ForegroundColor Green
Write-Host " Servis Adi      : $ServiceName"
Write-Host " JAR Dosyasi     : $($jarFile.FullName)"
Write-Host " Log Dizini      : $logDir"
Write-Host " Port            : 8081 (varsayilan)"
Write-Host "`n DIKKAT:"
Write-Host " - application.yml icindeki DB baglanti bilgileri (PostgreSQL)"
Write-Host "   ve BROKER_API_KEY ortam degiskenini ayarlamayi unutmayin."
Write-Host " - Servis yonetimi:"
Write-Host "     Start-Service -Name $ServiceName"
Write-Host "     Stop-Service  -Name $ServiceName"
Write-Host "     & '$nssmExe' edit $ServiceName"
Write-Host "`n========================================"

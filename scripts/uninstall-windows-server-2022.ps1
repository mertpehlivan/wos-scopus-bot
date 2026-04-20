#Requires -RunAsAdministrator
<#
.SYNOPSIS
    WoS/Scopus Bot - Tam Temizleme / Sifirdan Baslama Scripti
.DESCRIPTION
    Bu script, install-windows-server-2022.ps1 tarafindan kurulan tum bilesenleri
    (WosScopusBot servisi, NSSM, JDK 21, Maven, PostgreSQL 16 ve veritabani) siler.
    Calistirdiktan sonra kurulum scriptini tekrar calistirabilirsiniz.
.NOTES
    PowerShell 5.1+ ile calistirin. Yonetici haklari gerekir.
    DIKKAT: PostgreSQL veritabani ve tum veriler kalici olarak silinir!
#>

$ErrorActionPreference = "SilentlyContinue"

# ============================================================
# PARAMETRELER (install scripti ile ayni olmali)
# ============================================================
$InstallDir    = "C:\Tools"
$JdkDir        = Join-Path $InstallDir "jdk-21"
$MavenDir      = Join-Path $InstallDir "apache-maven-3.9.9"
$NssmDir       = Join-Path $InstallDir "nssm-2.24.4"
$ServiceName   = "WosScopusBot"
$PgVersion     = "16"
$PgServiceName = "postgresql-x64-$PgVersion"
$PgDefaultDir  = "C:\Program Files\PostgreSQL\$PgVersion"
$AppPort       = 8081
$PgPort        = 5433
$NssmExe       = Join-Path $NssmDir "win64\nssm.exe"

# ============================================================
# YARDIMCI
# ============================================================
function Write-Step { param([string]$M); Write-Host "`n[~] $M" -ForegroundColor Magenta }
function Write-OK   { param([string]$M); Write-Host "    OK: $M"   -ForegroundColor Green  }
function Write-Skip { param([string]$M); Write-Host "    --: $M"   -ForegroundColor Yellow }

# ============================================================
# ONAY
# ============================================================
Write-Host "`n========================================" -ForegroundColor Red
Write-Host "  UYARI: TAM TEMIZLEME / SIFIRDAN BASLAMA" -ForegroundColor Red
Write-Host "========================================" -ForegroundColor Red
Write-Host " Silinecekler:"
Write-Host "   - Windows Servisi  : $ServiceName"
Write-Host "   - NSSM             : $NssmDir"
Write-Host "   - JDK 21           : $JdkDir"
Write-Host "   - Maven            : $MavenDir"
Write-Host "   - PostgreSQL $PgVersion   : $PgDefaultDir (+ TUM VERILER)"
Write-Host "   - Firewall kurallari: TCP $AppPort, TCP $PgPort"
Write-Host "   - PATH kayitlari"
Write-Host ""
$confirm = Read-Host "Devam etmek istiyor musunuz? (evet / hayir)"
if ($confirm -ne "evet") {
    Write-Host "Iptal edildi." -ForegroundColor Yellow
    exit 0
}

# ============================================================
# 1. WosScopusBot SERVISINI DURDUR VE SIL
# ============================================================
Write-Step "WosScopusBot servisi kaldiriliyor..."
$svc = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
if ($svc) {
    Stop-Service -Name $ServiceName -Force -ErrorAction SilentlyContinue
    Start-Sleep -Seconds 3
    if (Test-Path $NssmExe) {
        & $NssmExe remove $ServiceName confirm 2>$null
        Start-Sleep -Seconds 2
    }
    # Hala kaliyorsa sc ile sil
    $svc2 = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
    if ($svc2) {
        cmd /c "sc.exe delete $ServiceName" | Out-Null
        Start-Sleep -Seconds 2
    }
    Write-OK "Servis kaldirildi: $ServiceName"
} else {
    Write-Skip "Servis bulunamadi: $ServiceName"
}

# ============================================================
# 2. POSTGRESQL 16 KALDIRMA
# ============================================================
Write-Step "PostgreSQL $PgVersion kaldiriliyor (binary zip yontemi)..."

$pgSvc = Get-Service -Name $PgServiceName -ErrorAction SilentlyContinue
if ($pgSvc) {
    Stop-Service -Name $PgServiceName -Force -ErrorAction SilentlyContinue
    Start-Sleep -Seconds 3
}

# pg_ctl ile servisi kayit defterinden kaldir (binary zip ile kurulduysa)
$pgCtl = "C:\Program Files\PostgreSQL\$PgVersion\bin\pg_ctl.exe"
if (Test-Path $pgCtl) {
    & $pgCtl unregister -N $PgServiceName 2>$null
    Start-Sleep -Seconds 2
    Write-OK "pg_ctl unregister tamamlandi."
}

# Hala varsa sc.exe ile zorla sil
$pgSvc2 = Get-Service -Name $PgServiceName -ErrorAction SilentlyContinue
if ($pgSvc2) {
    cmd /c "sc.exe delete $PgServiceName" | Out-Null
    Start-Sleep -Seconds 2
    Write-OK "sc.exe ile servis kaydi silindi."
}

# Tum PostgreSQL dizinini sil (veri dahil)
if (Test-Path $PgDefaultDir) {
    Remove-Item -Path $PgDefaultDir -Recurse -Force -ErrorAction SilentlyContinue
    Write-OK "PostgreSQL dizini silindi: $PgDefaultDir"
} else {
    Write-Skip "PostgreSQL dizini bulunamadi: $PgDefaultDir"
}

# ============================================================
# 3. NSSM KALDIR
# ============================================================
Write-Step "NSSM kaldiriliyor..."
if (Test-Path $NssmDir) {
    Remove-Item -Path $NssmDir -Recurse -Force -ErrorAction SilentlyContinue
    Write-OK "NSSM dizini silindi: $NssmDir"
} else {
    Write-Skip "NSSM dizini bulunamadi."
}

# ============================================================
# 4. JDK 21 KALDIR
# ============================================================
Write-Step "JDK 21 kaldiriliyor..."
if (Test-Path $JdkDir) {
    Remove-Item -Path $JdkDir -Recurse -Force -ErrorAction SilentlyContinue
    Write-OK "JDK 21 dizini silindi: $JdkDir"
} else {
    Write-Skip "JDK 21 dizini bulunamadi."
}

# ============================================================
# 5. MAVEN KALDIR
# ============================================================
Write-Step "Apache Maven kaldiriliyor..."
if (Test-Path $MavenDir) {
    Remove-Item -Path $MavenDir -Recurse -Force -ErrorAction SilentlyContinue
    Write-OK "Maven dizini silindi: $MavenDir"
} else {
    Write-Skip "Maven dizini bulunamadi."
}

# ============================================================
# 6. ORTAM DEGISKENLERI VE PATH TEMIZLIGI
# ============================================================
Write-Step "Ortam degiskenleri ve PATH temizleniyor..."

# Degiskenleri sil
foreach ($var in @("JAVA_HOME","MAVEN_HOME")) {
    $val = [Environment]::GetEnvironmentVariable($var, "Machine")
    if ($val) {
        [Environment]::SetEnvironmentVariable($var, $null, "Machine")
        Write-OK "Ortam degiskeni silindi: $var"
    }
}

# PATH'ten ilgili girisleri temizle
$pathEntriesToRemove = @(
    "$JdkDir\bin",
    "$MavenDir\bin",
    "$PgDefaultDir\bin",
    "C:\Program Files\PostgreSQL\$PgVersion\bin"
)
$currentPath = [Environment]::GetEnvironmentVariable("Path", "Machine")
$newPath = ($currentPath -split ";") | Where-Object {
    $entry = $_.TrimEnd("\")
    $keep = $true
    foreach ($rem in $pathEntriesToRemove) {
        if ($entry -ieq $rem.TrimEnd("\")) { $keep = $false; break }
    }
    $keep
} | Where-Object { $_ -ne "" }
[Environment]::SetEnvironmentVariable("Path", ($newPath -join ";"), "Machine")
$env:Path = [Environment]::GetEnvironmentVariable("Path", "Machine")
Write-OK "PATH temizlendi."

# ============================================================
# 7. FIREWALL KURALLARI SIL
# ============================================================
Write-Step "Firewall kurallari kaldiriliyor..."
foreach ($ruleName in @("WosScopusBot-API-$AppPort", "WosScopusBot-PostgreSQL-$PgPort")) {
    $rule = Get-NetFirewallRule -DisplayName $ruleName -ErrorAction SilentlyContinue
    if ($rule) {
        Remove-NetFirewallRule -DisplayName $ruleName -ErrorAction SilentlyContinue
        Write-OK "Firewall kurali silindi: $ruleName"
    } else {
        Write-Skip "Firewall kurali bulunamadi: $ruleName"
    }
}

# ============================================================
# 8. MAVEN BUILD CIKTILARINI TEMIZLE (opsiyonel)
# ============================================================
Write-Step "Maven build ciktilari temizleniyor (target klasoru)..."
$projectDir = Split-Path $PSScriptRoot -Parent
$targetDir  = Join-Path $projectDir "target"
if (Test-Path $targetDir) {
    Remove-Item -Path $targetDir -Recurse -Force -ErrorAction SilentlyContinue
    Write-OK "Target dizini silindi: $targetDir"
} else {
    Write-Skip "Target dizini bulunamadi."
}

# ============================================================
# OZET
# ============================================================
Write-Host "`n========================================" -ForegroundColor Green
Write-Host "  TEMIZLEME TAMAMLANDI" -ForegroundColor Green
Write-Host "========================================" -ForegroundColor Green
Write-Host " Artik kurulum scriptini sifirdan calistiabilirsiniz:"
Write-Host ""
Write-Host "   Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass"
Write-Host "   .\scripts\install-windows-server-2022.ps1"
Write-Host ""
Write-Host "========================================`n"

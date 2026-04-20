#Requires -RunAsAdministrator
<#
.SYNOPSIS
    WoS/Scopus Bot servis yonetim scripti.
.DESCRIPTION
    Servisi baslat, durdur, yeniden baslat, durumunu gor veya kaldir.
.PARAMETER Action
    Yapilacak islem: start, stop, restart, status, remove, logs
.EXAMPLE
    .\manage-service.ps1 -Action start
    .\manage-service.ps1 -Action status
    .\manage-service.ps1 -Action logs
#>
param(
    [Parameter(Mandatory=$true)]
    [ValidateSet("start","stop","restart","status","remove","logs")]
    [string]$Action
)

$ServiceName = "WosScopusBot"
$NssmDir     = "C:\Tools\nssm-2.24"
$NssmExe     = Join-Path $NssmDir "win64\nssm.exe"
$LogDir      = "..\logs"

switch ($Action) {
    "start" {
        Write-Host "Servis baslatiliyor..." -ForegroundColor Green
        Start-Service -Name $ServiceName
    }
    "stop" {
        Write-Host "Servis durduruluyor..." -ForegroundColor Yellow
        Stop-Service -Name $ServiceName -Force
    }
    "restart" {
        Write-Host "Servis yeniden baslatiliyor..." -ForegroundColor Cyan
        Restart-Service -Name $ServiceName -Force
    }
    "status" {
        $svc = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
        if ($svc) {
            Write-Host "Servis Durumu : $($svc.Status)" -ForegroundColor $(if($svc.Status -eq "Running"){"Green"}else{"Red"})
            Write-Host "Baslangic Turu: $($svc.StartType)"
        } else {
            Write-Warning "$ServiceName servisi bulunamadi."
        }
    }
    "remove" {
        $confirm = Read-Host "$ServiceName servisini kaldirmak istediginize emin misiniz? (E/H)"
        if ($confirm -eq 'E') {
            Stop-Service -Name $ServiceName -Force -ErrorAction SilentlyContinue
            if (Test-Path $NssmExe) {
                & $NssmExe remove $ServiceName confirm
            } else {
                sc.exe delete $ServiceName | Out-Null
            }
            Write-Host "Servis kaldirildi." -ForegroundColor Green
        }
    }
    "logs" {
        $stdout = Join-Path $LogDir "stdout.log"
        $stderr = Join-Path $LogDir "stderr.log"
        if (Test-Path $stderr) {
            Write-Host "--- STDERR (son 50 satir) ---" -ForegroundColor Red
            Get-Content $stderr -Tail 50
        }
        if (Test-Path $stdout) {
            Write-Host "`n--- STDOUT (son 50 satir) ---" -ForegroundColor Green
            Get-Content $stdout -Tail 50
        }
    }
}

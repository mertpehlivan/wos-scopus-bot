# WoS/Scopus Bot — Windows Server 2022 Kurulum

Bu dizin, `wos-scopus-bot` uygulamasını Windows Server 2022 üzerinde
Windows Servisi olarak çalıştırmak için gerekli PowerShell scriptlerini içerir.

## Gereksinimler

- Windows Server 2022 (veya Windows 10/11)
- PowerShell 5.1+
- İnternet bağlantısı (JDK, Maven ve NSSM indirme için)
- **Yönetici (Administrator) hakları**

## Hızlı Başlangıç

```powershell
# PowerShell'i Yönetici olarak açın
# scripts dizinine gidin
cd wos-scopus-bot\scripts

# Kurulum scriptini çalıştırın
.\install-windows-server-2022.ps1
```

Script otomatik olarak şunları yapar:

1. **Eclipse Temurin JDK 21** indirir ve kurar (`C:\Tools\jdk-21`)
2. **Apache Maven 3.9.9** indirir ve kurar (`C:\Tools\apache-maven-3.9.9`)
3. Ortam değişkenlerini (`JAVA_HOME`, `MAVEN_HOME`, `PATH`) ayarlar
4. Projeyi **Maven** ile build eder (`mvn clean package -DskipTests`)
5. **NSSM** ile `WosScopusBot` adında Windows Servisi oluşturur
6. Servisi **otomatik başlangıç** olarak ayarlar ve başlatır

## Yapılandırma (Önemli!)

Kurulum tamamlandıktan sonra aşağıdaki ayarları gözden geçirin:

### 1. Veritabanı (PostgreSQL)
`application.yml` içindeki veritabanı bağlantı bilgilerini güncelleyin:

```yaml
spring:
  datasource:
    url: jdbc:postgresql://localhost:5433/article_broker
    username: postgres
    password: password
```

### 2. API Anahtarı
`BROKER_API_KEY` ortam değişkenini sistem ortam değişkenleri olarak ekleyin:

```powershell
[Environment]::SetEnvironmentVariable("BROKER_API_KEY", "cok-gizli-anahtar", "Machine")
```

> Servis bu değişkeni okumak için yeniden başlatılmalıdır.

## Servis Yönetimi

```powershell
# Durum kontrolü
.\manage-service.ps1 -Action status

# Başlat / Durdur / Yeniden başlat
.\manage-service.ps1 -Action start
.\manage-service.ps1 -Action stop
.\manage-service.ps1 -Action restart

# Logları görüntüle
.\manage-service.ps1 -Action logs

# Servisi kaldır
.\manage-service.ps1 -Action remove
```

## Dosya Yapısı

```
C:\Tools
├── jdk-21\                  # Java 21
├── apache-maven-3.9.9\      # Maven
└── nssm-2.24\               # NSSM (Non-Sucking Service Manager)
```

## Manuel Yeniden Build

Projeyi güncelledikten sonra servisi yeniden build etmek için:

```powershell
cd wos-scopus-bot
C:\Tools\apache-maven-3.9.9\bin\mvn.cmd clean package -DskipTests
Restart-Service -Name WosScopusBot
```

## Sorun Giderme

| Sorun | Çözüm |
|-------|-------|
| "Bu script Yönetici olarak çalıştırılmalıdır" | PowerShell'i Sağ Tık → "Run as administrator" ile açın |
| Servis başlamıyor | Logları kontrol edin: `manage-service.ps1 -Action logs` |
| `java` komutu bulunamıyor | Yeni bir PowerShell penceresi açın (PATH yenilensin) |
| Port çakışması (8081) | `application.yml` içinde `server.port` değerini değiştirin |

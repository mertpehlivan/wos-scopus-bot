# WoS/Scopus Bot — Windows Server 2022 Kurulum Rehberi

Bu rehber, `wos-scopus-bot` (Article Task Broker) uygulamasının Windows Server 2022 ortamına adım adım kurulumunu ve Windows Servisi olarak yapılandırılmasını anlatır.

---

## 📋 İçindekiler

1. [Ön Hazırlık](#1-ön-hazırlık)
2. [Hızlı Kurulum (Otomatik)](#2-hızlı-kurulum-otomatik)
3. [Manuel Kurulum](#3-manuel-kurulum)
4. [Yapılandırma](#4-yapılandırma)
5. [Servis Yönetimi](#5-servis-yönetimi)
6. [Güncelleme / Yeniden Build](#6-güncelleme--yeniden-build)
7. [Sorun Giderme](#7-sorun-giderme)

---

## 1. Ön Hazırlık

### Gereksinimler

| Bileşen | Minimum Gereksinim |
|---------|-------------------|
| İşletim Sistemi | Windows Server 2022 (veya Windows 10/11) |
| PowerShell | 5.1 veya üzeri |
| RAM | 4 GB |
| Disk | 2 GB boş alan |
| Ağ | İnternet erişimi (ilk kurulum için) |
| Yetki | **Yönetici (Administrator)** hakları |

### Bağımlılıklar

Bot çalışmadan önce aşağıdaki hizmetlerin ayakta olması gerekir:

- **PostgreSQL** — `article_broker` veritabanı erişilebilir olmalı
- **RDL-SIS Backend** — Bot, ana uygulama ile entegre çalışır (varsayılan API adresi: `http://localhost:8080`)

> **Not:** PostgreSQL portunu `application.yml` içinde görebilirsiniz. Varsayılan değer: `5433`.

---

## 2. Hızlı Kurulum (Otomatik)

PowerShell'i **Yönetici (Run as Administrator)** olarak açın ve şu komutları çalıştırın:

```powershell
cd wos-scopus-bot\scripts
.\install-windows-server-2022.ps1
```

### Script ne yapar?

| Adım | Açıklama | Hedef Dizin |
|------|----------|-------------|
| 1 | Eclipse Temurin **JDK 21** indirir ve kurar | `C:\Tools\jdk-21` |
| 2 | **Apache Maven 3.9.9** indirir ve kurar | `C:\Tools\apache-maven-3.9.9` |
| 3 | Ortam değişkenlerini (`JAVA_HOME`, `MAVEN_HOME`, `PATH`) tanımlar | Sistem ortam değişkenleri |
| 4 | Projeyi **Maven** ile derler (`mvn clean package -DskipTests`) | `wos-scopus-bot\target` |
| 5 | **NSSM** (Non-Sucking Service Manager) indirir ve kurar. İndirilemezse `sc.exe` ile devam eder. | `C:\Tools\nssm-2.24.4` |
| 6 | `WosScopusBot` adında **Windows Servisi** oluşturur | Windows Services (services.msc) |
| 7 | Servisi **Otomatik Başlangıç** olarak ayarlar ve çalıştırır | — |

Kurulum başarılı olursa aşağıdaki mesajı görürsünüz:

```
========================================
  KURULUM TAMAMLANDI
========================================
 Servis Adi      : WosScopusBot
 Port            : 8081 (varsayilan)
```

---

## 3. Manuel Kurulum

Otomatik script kullanmak istemiyorsanız adım adım manuel kurulum yapabilirsiniz.

### 3.1 Java 21 Kurulumu

1. [Eclipse Temurin JDK 21](https://adoptium.net/temurin/releases/?version=21) indirin (`x64 Windows .zip`)
2. `C:\Tools\jdk-21` dizinine çıkarın
3. Ortam değişkenlerini ekleyin:

```powershell
[Environment]::SetEnvironmentVariable("JAVA_HOME", "C:\Tools\jdk-21", "Machine")
# PATH'e ekle: C:\Tools\jdk-21\bin
```

Doğrulama:
```powershell
java -version
# openjdk version "21.0.5" ...
```

### 3.2 Maven Kurulumu

1. [Apache Maven 3.9.9](https://archive.apache.org/dist/maven/maven-3/3.9.9/binaries/apache-maven-3.9.9-bin.zip) indirin
2. `C:\Tools\apache-maven-3.9.9` dizinine çıkarın
3. Ortam değişkenlerini ekleyin:

```powershell
[Environment]::SetEnvironmentVariable("MAVEN_HOME", "C:\Tools\apache-maven-3.9.9", "Machine")
# PATH'e ekle: C:\Tools\apache-maven-3.9.9\bin
```

Doğrulama:
```powershell
mvn -version
# Apache Maven 3.9.9 ...
```

### 3.3 Projeyi Derleme

```powershell
cd wos-scopus-bot
mvn clean package -DskipTests
```

Başarılı derleme sonrası `target\article-task-broker-*.jar` dosyası oluşur.

### 3.4 Windows Servisi Oluşturma

**NSSM ile (önerilen):**

1. [NSSM 2.24](https://nssm.cc/download) indirin ve `C:\Tools\nssm-2.24` içine çıkarın
2. Servisi kurun:

```powershell
$nssm = "C:\Tools\nssm-2.24\win64\nssm.exe"
$jar  = "C:\rdl-sis\wos-scopus-bot\target\article-task-broker-1.0.0-SNAPSHOT.jar"

& $nssm install WosScopusBot "C:\Tools\jdk-21\bin\java.exe" "-jar `"$jar`""
& $nssm set WosScopusBot DisplayName "WoS/Scopus Article Task Broker"
& $nssm set WosScopusBot Description "Task Queue & Worker broker for WoS/Scopus article data"
& $nssm set WosScopusBot Start SERVICE_AUTO_START
& $nssm set WosScopusBot AppDirectory "C:\rdl-sis\wos-scopus-bot"
& $nssm set WosScopusBot AppStdout "C:\rdl-sis\wos-scopus-bot\logs\stdout.log"
& $nssm set WosScopusBot AppStderr "C:\rdl-sis\wos-scopus-bot\logs\stderr.log"

Start-Service -Name WosScopusBot
```

**sc.exe ile (NSSM yoksa):**

```powershell
$jar = "C:\rdl-sis\wos-scopus-bot\target\article-task-broker-1.0.0-SNAPSHOT.jar"
sc.exe create WosScopusBot binPath= "`"C:\Tools\jdk-21\bin\java.exe`" -jar `"$jar`"" start= auto DisplayName= "WosScopusBot"
sc.exe description WosScopusBot "WoS/Scopus Article Task Broker"
```

---

## 4. Yapılandırma

Kurulum sonrası **mutlaka** aşağıdaki ayarları kontrol edin.

### 4.1 Veritabanı Bağlantısı (`application.yml`)

```yaml
spring:
  datasource:
    url: jdbc:postgresql://localhost:5433/article_broker
    username: postgres
    password: PAROLANIZ
```

> **Önemli:** Varsayılan parola (`password`) üretim ortamında kesinlikle değiştirilmelidir.

### 4.2 API Anahtarı (`BROKER_API_KEY`)

Bot, ana RDL-SIS backend ile iletişim kurarken bu anahtarı kullanır. Sistem ortam değişkeni olarak tanımlayın:

```powershell
[Environment]::SetEnvironmentVariable("BROKER_API_KEY", "cok-gizli-anahtar-degeri", "Machine")
```

Değişikliğin geçerli olması için servisi yeniden başlatın:

```powershell
Restart-Service -Name WosScopusBot
```

### 4.3 Port Değişikliği

`8081` portu başka bir uygulama tarafından kullanılıyorsa `application.yml` içinde değiştirebilirsiniz:

```yaml
server:
  port: 8082
```

---

## 5. Servis Yönetimi

`manage-service.ps1` scripti ile servisi kolayca yönetebilirsiniz:

```powershell
cd wos-scopus-bot\scripts

# Servis durumunu gör
.\manage-service.ps1 -Action status

# Başlat
.\manage-service.ps1 -Action start

# Durdur
.\manage-service.ps1 -Action stop

# Yeniden başlat
.\manage-service.ps1 -Action restart

# Logları gör (son 50 satır)
.\manage-service.ps1 -Action logs

# Servisi tamamen kaldır
.\manage-service.ps1 -Action remove
```

Alternatif olarak Windows'un yerel komutlarını da kullanabilirsiniz:

```powershell
# GUI üzerinden yönetmek için
services.msc

# Komut satırından
Start-Service -Name WosScopusBot
Stop-Service  -Name WosScopusBot
Restart-Service -Name WosScopusBot
```

### Log Konumları

| Dosya | Açıklama |
|-------|----------|
| `wos-scopus-bot\logs\stdout.log` | Standart çıktı (INFO seviyesi loglar) |
| `wos-scopus-bot\logs\stderr.log` | Hata ve WARN seviyesi loglar |

> **Not:** `sc.exe` ile kurulum yapıldıysa log dosyaları otomatik oluşmayabilir. Bu durumda olay görüntüleyicisini (Event Viewer) kullanın.

---

## 6. Güncelleme / Yeniden Build

Kodda değişiklik yaptığınızda veya yeni sürüm aldığınızda:

```powershell
cd wos-scopus-bot

# 1. Servisi durdur
Stop-Service -Name WosScopusBot

# 2. Yeniden derle
C:\Tools\apache-maven-3.9.9\bin\mvn.cmd clean package -DskipTests

# 3. Servisi başlat
Start-Service -Name WosScopusBot
```

**Tek satırda:**

```powershell
Stop-Service -Name WosScopusBot; C:\Tools\apache-maven-3.9.9\bin\mvn.cmd -f C:\Users\Administrator\wos-scopus-bot\pom.xml clean package -DskipTests; Start-Service -Name WosScopusBot
```

> **Not:** Servis her başlatıldığında `target` klasöründeki **en güncel JAR** dosyasını otomatik olarak bulur. Yeni build aldığınızda servis yapılandırmasını değiştirmenize gerek yoktur.

---

## 7. Sorun Giderme

### 7.1 Kurulum Scripti Çalışmıyor

| Hata Mesajı | Çözüm |
|-------------|-------|
| `Bu script Yonetici olarak calistirilmalidir` | PowerShell'i **Sağ Tık → Run as administrator** ile açın |
| `Maven build basarisiz oldu` | İnternet bağlantısını kontrol edin; Maven bağımlılıkları ilk seferde indirir |
| `JAR dosyasi bulunamadi` | `mvn clean package` komutunun hatasız tamamlandığından emin olun |

### 7.2 Servis Başlamıyor

```powershell
# Logları kontrol edin
.\manage-service.ps1 -Action logs
```

Olası nedenler:

1. **PostgreSQL erişilemiyor** — `application.yml` içindeki DB URL/port/kullanıcı adı/parola yanlış olabilir
2. **Port çakışması** — `8081` portu başka bir uygulama tarafından kullanılıyor olabilir. `application.yml` içinde `server.port` değiştirin.
3. **JAVA_HOME eksik** — Yeni bir PowerShell penceresi açarak ortam değişkenlerinin yüklenmesini sağlayın.
4. **BROKER_API_KEY tanımlı değil** — Uygulama çalışabilir ancak bazı API çağrıları başarısız olabilir.

### 7.3 Java / Maven Komutu Bulunamıyor

Yeni bir **Yönetici PowerShell** penceresi açın. Mevcut pencerede PATH değişkenleri yenilenmemiş olabilir.

Doğrulama:
```powershell
$env:JAVA_HOME
$env:MAVEN_HOME
java -version
mvn -version
```

### 7.4 Servisi Tamamen Elle Kaldırma

Eğer `manage-service.ps1 -Action remove` çalışmazsa:

```powershell
# 1. Servisi durdur
Stop-Service -Name WosScopusBot -Force -ErrorAction SilentlyContinue

# 2. sc.exe ile kaldır
sc.exe delete WosScopusBot
```

---

## 📁 Dosya Yapısı Özeti

```
C:\Tools
├── jdk-21\                       # Java 21 (Eclipse Temurin)
├── apache-maven-3.9.9\            # Maven build aracı
└── nssm-2.24.4\                   # NSSM (Windows Servis yoneticisi) — istege bagli
    └── win64\nssm.exe

C:\...\wos-scopus-bot\            # Proje kök dizini
├── scripts\
│   ├── install-windows-server-2022.ps1
│   ├── manage-service.ps1
│   └── README.md                  # Bu dosya
├── src\                          # Kaynak kodlar
├── target\                        # Build çıktıları (JAR)
├── logs\                          # Servis logları
└── application.yml                # Ana yapılandırma dosyası
```

---

## 🔗 Faydalı Bağlantılar

- [Eclipse Temurin İndir](https://adoptium.net/temurin/releases/?version=21)
- [Apache Maven İndir](https://archive.apache.org/dist/maven/maven-3/3.9.9/binaries/apache-maven-3.9.9-bin.zip)
- [NSSM İndir](https://nssm.cc/download)
- [Spring Boot Servis Oluşturma](https://docs.spring.io/spring-boot/docs/current/reference/html/deployment.html#deployment.installing.windows-services)

---

**Son Güncelleme:** 2026-04-20

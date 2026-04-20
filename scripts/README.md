# WoS/Scopus Bot — Windows Server 2022 Kurulum Rehberi

Bu rehber, `wos-scopus-bot` (Article Task Broker) uygulamasının Windows Server 2022 ortamına **Docker olmadan**, tek bir script ile kurulumunu anlatır.

---

## 📋 İçindekiler

1. [Ön Hazırlık](#1-ön-hazırlık)
2. [Hızlı Kurulum (Otomatik)](#2-hızlı-kurulum-otomatik)
3. [Temizleme / Sıfırdan Başlama](#3-temizleme--sıfırdan-başlama)
4. [Yapılandırma](#4-yapılandırma)
5. [Servis Yönetimi](#5-servis-yönetimi)
6. [Güncelleme / Yeniden Build](#6-güncelleme--yeniden-build)
7. [Sorun Giderme](#7-sorun-giderme)

---

## 1. Ön Hazırlık

### Gereksinimler

| Bileşen | Minimum Gereksinim |
|---------|-------------------|
| İşletim Sistemi | Windows Server 2022 |
| PowerShell | 5.1 veya üzeri |
| RAM | 4 GB |
| Disk | 5 GB boş alan |
| Ağ | İnternet erişimi (ilk kurulum için) |
| Yetki | **Yönetici (Administrator)** hakları |

> **Not:** PostgreSQL, JDK 21, Maven ve NSSM kurulum scripti tarafından otomatik olarak indirilip kurulur. Önceden hiçbir şey kurmanıza gerek yoktur.

---

## 2. Hızlı Kurulum (Otomatik)

PowerShell'i **Yönetici (Run as Administrator)** olarak açın ve şu komutları çalıştırın:

```powershell
Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass
cd wos-scopus-bot\scripts
.\install-windows-server-2022.ps1
```

### Script ne yapar?

| Adım | Açıklama | Hedef |
|------|----------|-------|
| 1 | **PostgreSQL 16** indirir, sessiz kurar, `article_broker` veritabanını oluşturur | `C:\Program Files\PostgreSQL\16` |
| 2 | Eclipse Temurin **JDK 21** indirir ve kurar | `C:\Tools\jdk-21` |
| 3 | **Apache Maven 3.9.9** indirir ve kurar | `C:\Tools\apache-maven-3.9.9` |
| 4 | `JAVA_HOME`, `MAVEN_HOME`, `PATH` ortam değişkenlerini tanımlar | Sistem ortam değişkenleri |
| 5 | Projeyi **Maven** ile derler (`mvn clean package -DskipTests`) | `wos-scopus-bot\target` |
| 6 | **NSSM** indirir ve kurar | `C:\Tools\nssm-2.24.4` |
| 7 | `WosScopusBot` adında Windows Servisi oluşturur, PostgreSQL servisine bağımlı yapar | `services.msc` |
| 8 | **Windows Firewall** kuralı ekler: TCP `8081` (API) ve TCP `5433` (PostgreSQL) | Windows Defender Firewall |
| 9 | Servisi başlatır | — |

### Başarılı kurulum çıktısı

```
========================================
  KURULUM TAMAMLANDI
========================================
 Servis Adi          : WosScopusBot
 Uygulama Portu      : 8081  (Firewall: acik)
 PostgreSQL Portu    : 5433  (Firewall: acik)
 PostgreSQL DB       : article_broker
========================================
```

---

## 3. Temizleme / Sıfırdan Başlama

Tüm bileşenleri kaldırıp kurulumu sıfırlamak için:

```powershell
Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass
cd wos-scopus-bot\scripts
.\uninstall-windows-server-2022.ps1
```

> ⚠️ **Dikkat:** Bu script PostgreSQL veritabanını ve tüm verileri kalıcı olarak siler. Script çalışmadan önce **"evet"** yazarak onay ister.

### Uninstall script ne siler?

| Bileşen | Yapılan İşlem |
|---------|--------------|
| `WosScopusBot` servisi | Durdurulur ve kaldırılır |
| PostgreSQL 16 | Uninstaller ile kaldırılır + veri dizini silinir |
| JDK 21 | `C:\Tools\jdk-21` silinir |
| Maven 3.9.9 | `C:\Tools\apache-maven-3.9.9` silinir |
| NSSM | `C:\Tools\nssm-2.24.4` silinir |
| Ortam değişkenleri | `JAVA_HOME`, `MAVEN_HOME`, PATH kayıtları temizlenir |
| Firewall kuralları | TCP 8081 ve 5433 kuralları kaldırılır |
| `target/` dizini | Build çıktıları silinir |

Temizleme sonrası kurulumu yeniden başlatmak için:

```powershell
.\install-windows-server-2022.ps1
```

---

## 4. Yapılandırma

Kurulum tamamlandıktan sonra aşağıdaki ayarları kontrol edin.

### 4.1 API Anahtarı (`BROKER_API_KEY`) — Zorunlu

```powershell
[Environment]::SetEnvironmentVariable("BROKER_API_KEY", "gizli-anahtar", "Machine")
Restart-Service -Name WosScopusBot
```

### 4.2 Veritabanı Bağlantısı (`src\main\resources\application.yml`)

Script varsayılan değerlerle veritabanını oluşturur. Üretim ortamında parolayı değiştirin:

```yaml
spring:
  datasource:
    url: jdbc:postgresql://localhost:5433/article_broker
    username: postgres
    password: GUCLU_PAROLA_GIRINIZ   # varsayılan: password
```

> Parolayı değiştirirseniz PostgreSQL'deki kullanıcı parolasını da güncellemeniz gerekir:
> ```sql
> ALTER USER postgres WITH PASSWORD 'GUCLU_PAROLA_GIRINIZ';
> ```

### 4.3 Port Değişikliği

`8081` portu kullanımda ise:

```yaml
server:
  port: 8082
```

Değişiklikten sonra yeni port için de firewall kuralı ekleyin ve servisi yeniden başlatın.

---

## 5. Servis Yönetimi

```powershell
cd wos-scopus-bot\scripts

.\manage-service.ps1 -Action status   # Durum
.\manage-service.ps1 -Action start    # Başlat
.\manage-service.ps1 -Action stop     # Durdur
.\manage-service.ps1 -Action restart  # Yeniden başlat
.\manage-service.ps1 -Action logs     # Son 50 satır log
.\manage-service.ps1 -Action remove   # Kaldır
```

Veya doğrudan PowerShell ile:

```powershell
Start-Service   -Name WosScopusBot
Stop-Service    -Name WosScopusBot
Restart-Service -Name WosScopusBot
Get-Service     -Name WosScopusBot
```

### Log Konumları

| Dosya | Açıklama |
|-------|----------|
| `wos-scopus-bot\logs\stdout.log` | Uygulama çıktıları (INFO logları) |
| `wos-scopus-bot\logs\stderr.log` | Hata ve WARN logları |

---

## 6. Güncelleme / Yeniden Build

```powershell
# 1. Servisi durdur
Stop-Service -Name WosScopusBot

# 2. Yeniden derle
cd wos-scopus-bot
C:\Tools\apache-maven-3.9.9\bin\mvn.cmd clean package -DskipTests

# 3. Servisi başlat
Start-Service -Name WosScopusBot
```

---

## 7. Sorun Giderme

### 7.1 Kurulum Scripti Hatası

| Hata | Çözüm |
|------|-------|
| `Bu script Yonetici olarak calistirilmalidir` | PowerShell → **Sağ Tık → Run as Administrator** |
| `PostgreSQL kurulumu basarisiz oldu` | Disk alanı yeterliliğini ve internet bağlantısını kontrol edin |
| `Maven build basarisiz oldu` | Maven loguna bakın; bağımlılık indirme sorunu olabilir |
| `JAR dosyasi bulunamadi` | `mvn clean package` komutunun hatasız tamamlandığını doğrulayın |

### 7.2 Servis Başlamıyor

```powershell
.\manage-service.ps1 -Action logs
```

Olası nedenler:

1. **PostgreSQL hazır değil** — `Get-Service postgresql-x64-16` komutu ile servis durumunu kontrol edin
2. **Port çakışması** — `netstat -ano | findstr :8081` ile 8081 portunu kontrol edin
3. **BROKER_API_KEY tanımlı değil** — Bölüm 4.1'e bakın
4. **JAVA_HOME eksik** — Yeni bir Yönetici PowerShell penceresi açın

### 7.3 Ortam Değişkenleri Tanınmıyor

```powershell
# Doğrulama
$env:JAVA_HOME
$env:MAVEN_HOME
java -version
mvn -version
```

Tanınmıyorsa yeni bir Yönetici PowerShell penceresi açın (PATH değişikliği mevcut oturuma yansımayabilir).

### 7.4 PostgreSQL'e Bağlanılamıyor

```powershell
# Servis durumu
Get-Service postgresql-x64-16

# Bağlantı testi
& "C:\Program Files\PostgreSQL\16\bin\psql.exe" -U postgres -p 5433 -c "\l"
```

---

## 📁 Dosya ve Dizin Yapısı

```
C:\Program Files\PostgreSQL\16\     # PostgreSQL 16 (native)
C:\Tools\
├── jdk-21\                         # Java 21 (Eclipse Temurin)
├── apache-maven-3.9.9\             # Maven build aracı
└── nssm-2.24.4\win64\nssm.exe      # Windows Servis yöneticisi

wos-scopus-bot\
├── scripts\
│   ├── install-windows-server-2022.ps1    # Tam kurulum (bu script)
│   ├── uninstall-windows-server-2022.ps1  # Tam temizleme / sıfırlama
│   ├── manage-service.ps1                 # Servis yönetimi
│   └── README.md                          # Bu dosya
├── src\                             # Kaynak kodlar
├── target\                          # Build çıktıları (JAR)
├── logs\                            # Servis logları
└── src\main\resources\application.yml  # Ana yapılandırma
```

---

## 🔗 Faydalı Bağlantılar

- [Eclipse Temurin JDK 21](https://adoptium.net/temurin/releases/?version=21)
- [Apache Maven 3.9.9](https://archive.apache.org/dist/maven/maven-3/3.9.9/binaries/)
- [PostgreSQL Windows İndirme](https://www.enterprisedb.com/downloads/postgres-postgresql-downloads)
- [NSSM](https://nssm.cc/download)

---

**Son Güncelleme:** 2026-04-20

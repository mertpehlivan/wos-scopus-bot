# AGENTS.md — Article Task Broker

> This file is written for AI coding agents. It assumes zero prior knowledge of the project.
> Note: While this file is in English, many inline comments and operational docs (especially in `scripts/` and controller implementations) are in **Turkish**.

---

## 1. Project Overview

**Article Task Broker** is a Spring Boot task-queue microservice that sits between a main backend system and a Chrome browser extension.

- The **backend** queues scraping jobs (WoS/Scopus author profiles, DOI enrichments, PlumX citation lookups).
- The **broker** stores these jobs in PostgreSQL and exposes a REST API.
- The **Chrome extension** polls the broker, performs the actual browser scraping on external academic sites, and sends the raw results back.

The broker then forwards completed results to the main backend and deletes the tasks (ephemeral storage).

| Component | Role |
|-----------|------|
| `article-task-broker` (this repo) | Task queue, state machine, API gateway |
| Chrome Extension (`chrome-extension/`) | Head-less worker that scrapes web pages |
| Main Backend (external) | Consumes completed tasks via `consume` endpoints |

---

## 2. Technology Stack

| Layer | Technology | Version |
|-------|------------|---------|
| Language | Java | 21 |
| Framework | Spring Boot | 3.2.5 |
| ORM / Data | Spring Data JPA, Hibernate | 6.x |
| Database | PostgreSQL | 16+ |
| JSONB support | Hibernate `SqlTypes.JSON` | — |
| Build tool | Apache Maven | 3.9.x |
| Security | Spring Security (stateless, API key) | — |
| Utilities | Lombok, Jakarta Validation | — |
| Frontend / Worker | Chrome Extension (Manifest V3) | — |

---

## 3. Project Structure

```
wos-scopus-bot/
├── pom.xml                          # Maven build descriptor (Spring Boot parent)
├── docker-compose.yml               # LOCAL DEV ONLY: PostgreSQL 16 on port 5433
├── src/main/java/com/academic/broker/
│   ├── ArticleTaskBrokerApplication.java   # @EnableScheduling, entry point
│   ├── api/                         # REST controllers + DTOs
│   │   ├── ArticleTaskController.java      # /api/tasks      (WOS/SCOPUS/SCHOLAR profile scraping)
│   │   ├── CitationReportController.java   # /api/wos/citation-report/sync
│   │   ├── DoiEnrichTaskController.java    # /api/doi-enrich-tasks (WOS & SCHOLAR DOI lookup)
│   │   ├── PlumxTaskController.java        # /api/plumx-tasks (PlumX citation sync)
│   │   └── dto/                     # Request/response POJOs (Lombok @Data/@Builder)
│   ├── config/
│   │   ├── SecurityConfig.java      # CORS, CSRF off, API key filter
│   │   └── ApiKeyAuthFilter.java    # X-Api-Key header validation
│   ├── domain/                      # JPA entities & enums
│   │   ├── ArticleTask.java         # article_tasks table (profile scraping)
│   │   ├── DoiEnrichTask.java       # doi_enrich_tasks table (DOI enrichment)
│   │   ├── PlumxTask.java           # plumx_tasks table (citation lookups)
│   │   ├── TargetSource.java        # Enum: WOS, SCOPUS, PLUMX, SCHOLAR
│   │   ├── TaskStatus.java          # Enum: PENDING, PROCESSING, COMPLETED, FAILED
│   │   └── TaskType.java            # Enum: METRICS_ONLY, FULL_SCRAPE, CITATION_SYNC
│   ├── repository/                  # Spring Data JPA interfaces
│   │   ├── ArticleTaskRepository.java
│   │   ├── DoiEnrichTaskRepository.java   # Uses native SKIP LOCKED query
│   │   └── PlumxTaskRepository.java
│   ├── service/
│   │   └── ArticleTaskService.java  # Business logic, scheduling, timeouts
│   └── exception/                   # Global exception handling (@RestControllerAdvice)
├── src/main/resources/
│   └── application.yml              # All configuration (see §7)
├── chrome-extension/                # Manifest V3 Chrome extension
│   ├── manifest.json
│   ├── background.js                # Service worker: polling orchestrator, tab lifecycle
│   ├── content.js                   # WoS author-page scraper
│   ├── article_detail.js            # WoS full-record page scraper
│   ├── scopus_content.js            # Scopus author-page scraper
│   ├── scholar_content.js           # Google Scholar profile scraper
│   ├── plumx_content.js             # PlumX metrics scraper
│   ├── wos_doi_content.js           # WoS DOI enrichment scraper
│   ├── scholar_doi_content.js       # Scholar DOI enrichment scraper
│   ├── wos_citation_report_content.js # WoS citation report scraper
│   ├── wos_session_handler.js       # Auto-login session helper
│   ├── stealth-utils.js             # Anti-detection utilities injected in MAIN world
│   ├── popup.html / popup.js / popup.css   # Extension dashboard UI
│   └── diagnostics.html / diagnostics.js   # Task diagnostics page
├── scripts/                         # Windows Server 2022 deployment scripts (Turkish)
│   ├── install-windows-server-2022.ps1
│   ├── uninstall-windows-server-2022.ps1
│   ├── manage-service.ps1
│   └── README.md
├── postman/
│   └── Article-Task-Broker-API.postman_collection.json
└── .vscode/
    └── settings.json
```

---

## 4. Build & Test Commands

### Prerequisites
- Java 21 (`JAVA_HOME` set)
- Apache Maven 3.9+
- PostgreSQL 16 (local dev uses `docker-compose.yml` on port **5433**)

### Build
```bash
mvn clean package
```

> The production install script uses `mvn clean package -DskipTests` because **there are currently no unit tests** in `src/test`.

### Run locally
```bash
# 1. Start PostgreSQL
docker-compose up -d

# 2. Run the application
mvn spring-boot:run
# or
java -jar target/article-task-broker-*.jar
```

Default local URL: `http://localhost:8081`

### Re-build after changes (Windows Server production)
```powershell
Stop-Service -Name WosScopusBot
cd wos-scopus-bot
mvn clean package -DskipTests
Start-Service -Name WosScopusBot
```

---

## 5. Code Style & Conventions

### Java
- **Package**: `com.academic.broker`
- **Lombok** is mandatory: use `@Data`, `@Builder`, `@RequiredArgsConstructor`, `@Slf4j`
- **JPA**: All entities use `@Builder`, `@NoArgsConstructor`, `@AllArgsConstructor(access = AccessLevel.PRIVATE)`
- **JSONB columns**: Annotated with `@JdbcTypeCode(SqlTypes.JSON)` and `columnDefinition = "jsonb"`
- **Timestamps**: `Instant` (not `LocalDateTime`)
- **Versioning**: `@Version` field on every entity for optimistic locking
- **Touch pattern**: Entities have a `touch()` method that sets `updatedAt = Instant.now()`
- **Turkish comments**: Controller implementations and some service methods contain Turkish inline comments (`Eklenti`, `Ana sistem`, etc.). Keep this style consistent when editing those layers.

### Controllers
- Use `@RestController` + `@RequestMapping` with explicit `consumes/produces = MediaType.APPLICATION_JSON_VALUE`
- DTOs live in `api.dto` package, validated with Jakarta Validation (`@Valid`, `@NotNull`, `@NotEmpty`)
- Return `ResponseEntity<T>` explicitly

### Repositories
- Extend `JpaRepository<Entity, Long>`
- Use `@Lock(LockModeType.PESSIMISTIC_WRITE)` on poll/consume queries to prevent race conditions
- `DoiEnrichTaskRepository` uses a **native query** with `FOR UPDATE SKIP LOCKED` for PostgreSQL-specific row-level locking

---

## 6. Architecture & Module Divisions

### Task Types & Tables
The broker manages **three independent task queues**, each with its own table:

| Table | Entity | Controller Prefix | Purpose |
|-------|--------|-------------------|---------|
| `article_tasks` | `ArticleTask` | `/api/tasks` | Scrape author profiles (WOS, SCOPUS, SCHOLAR) |
| `doi_enrich_tasks` | `DoiEnrichTask` | `/api/doi-enrich-tasks` | Enrich articles by DOI (WOS Smart-Search + Google Scholar) |
| `plumx_tasks` | `PlumxTask` | `/api/plumx-tasks` | Fetch citation counts from PlumX |

### State Machine
All tasks follow the same lifecycle:

```
PENDING → PROCESSING → COMPLETED
   ↑___________|
   └── (timeout or fail) → FAILED
```

- **PENDING**: Queued, waiting for Chrome extension worker.
- **PROCESSING**: Claimed by worker; row is locked (`PESSIMISTIC_WRITE` or `SKIP LOCKED`).
- **COMPLETED**: Worker finished; raw JSON stored in `raw_data` (JSONB).
- **FAILED**: Worker reported failure or timed out.

### Timeout & Recovery
`ArticleTaskService` runs two `@Scheduled` jobs:
- `resetStuckProcessingTasks()`: Every 60s, reverts `PROCESSING` tasks older than `broker.processing-timeout-minutes` (default 120 min) back to `PENDING`.
- `resetStuckPlumxTasks()`: Same for PlumX tasks.

### Ephemeral Storage
Completed tasks are **deleted** from the broker immediately after the backend consumes them (`consume` endpoints). The broker is not a long-term data store.

### Chrome Extension Orchestration
The extension (`background.js`) uses a **strict priority scheduler**:

1. Finish any active profile scrape (WOS/SCOPUS/SCHOLAR) — only **one** profile task at a time.
2. Process WOS DOI enrichment tasks.
3. Process Scholar DOI & PlumX citation tasks (slower polling to avoid IP bans).
4. Poll for a new profile task.

Adaptive pooling, human-like delays, and backoff mechanisms are built into the extension to reduce bot-detection risk.

---

## 7. Configuration (`application.yml`)

```yaml
spring:
  datasource:
    url: ${DB_URL:jdbc:postgresql://localhost:5433/article_broker}
    username: ${DB_USER:postgres}
    password: ${DB_PASSWORD:password}
  jpa:
    hibernate:
      ddl-auto: update   # Auto-creates tables in dev; consider validate/migrate in prod

broker:
  processing-timeout-minutes: 120
  api-key: ${BROKER_API_KEY:change-me-in-production}
  backend-url: ${BACKEND_URL:http://localhost:8080}
  extension-origin: ${BROKER_EXTENSION_ORIGIN:chrome-extension://*}

server:
  port: 8081
```

### Required Environment Variables (Production)
| Variable | Purpose |
|----------|---------|
| `BROKER_API_KEY` | Shared secret; extension and backend must send `X-Api-Key` header. **Change from default.** |
| `DB_URL`, `DB_USER`, `DB_PASSWORD` | PostgreSQL connection |
| `BACKEND_URL` | URL of the main backend that receives forwarded results |
| `BROKER_EXTENSION_ORIGIN` | Exact `chrome-extension://<id>` for CORS in production |

---

## 8. API & Security

### Authentication
Every request must include the header:
```
X-Api-Key: <broker.api-key>
```

There are **no user accounts / JWT / sessions**. It is a single shared API key model.

### CORS
Configured in `SecurityConfig.java`:
- `chrome-extension://*` (development)
- `http://localhost:*`
- Exact extension ID from `broker.extension-origin` (production override)

### Key Endpoints

#### Article Tasks (`/api/tasks`)
| Method | Endpoint | Caller | Description |
|--------|----------|--------|-------------|
| POST | `/api/tasks?force=false` | Backend | Queue new WOS/SCOPUS/SCHOLAR profile tasks |
| GET | `/api/tasks/poll?source=WOS` | Extension | Claim one PENDING task |
| POST | `/api/tasks/{id}/complete` | Extension | Submit scraped raw data |
| POST | `/api/tasks/{id}/author-metrics` | Extension | Submit author metrics (h-index, etc.) |
| POST | `/api/tasks/{id}/fail` | Extension | Mark task failed |
| GET | `/api/tasks/consume` | Backend | Fetch & delete all COMPLETED tasks |
| GET | `/api/tasks/status` | Backend | Check latest task status by source+externalId |

#### DOI Enrichment (`/api/doi-enrich-tasks`)
| Method | Endpoint | Caller | Description |
|--------|----------|--------|-------------|
| POST | `/batch` | Backend | Queue WOS + SCHOLAR tasks for a list of DOIs |
| GET | `/poll?source=WOS` | Extension | Claim pending DOI tasks (batch up to 5) |
| POST | `/{id}/complete` | Extension | WOS DOI enrichment complete |
| POST | `/{id}/scholar-complete` | Extension | Scholar DOI enrichment complete |
| POST | `/{id}/fail` | Extension | Report failure |

Results are **forwarded asynchronously** to `BACKEND_URL` via `java.net.http.HttpClient`.

#### PlumX Tasks (`/api/plumx-tasks`)
Similar pattern: `add` → `poll` → `complete/fail` → `consume`.

#### Citation Report (`/api/wos/citation-report/sync`)
Direct pass-through endpoint: extension sends data, broker validates and forwards asynchronously to the main backend.

---

## 9. Chrome Extension

- **Manifest V3** with `service_worker` background script.
- **Host permissions**: `webofscience.com`, `scopus.com`, `scholar.google.com`, `plu.mx`, `localhost:8081`.
- **Content scripts** run at `document_idle` (and `document_start` for stealth injection).
- **Stealth utilities** (`stealth-utils.js`) are injected into the page's `MAIN` world to evade bot detection.
- **Popup** (`popup.html`) provides a dashboard with logs, stats, sync progress, and manual controls (Force Poll, Reset All).
- **Diagnostics** (`diagnostics.html`) shows per-task scraping history and PlumX results.

The extension stores its API key in `chrome.storage.local` under key `brokerApiKey`.

---

## 10. Deployment

### Production: Windows Server 2022 (Native)
The project is **not containerized** in production.

Use `scripts/install-windows-server-2022.ps1` (requires Administrator PowerShell):

1. Downloads & installs PostgreSQL 16 (binary zip) on port **5433**.
2. Downloads & installs Eclipse Temurin JDK 21 to `C:\Tools\jdk-21`.
3. Downloads & installs Apache Maven 3.9.9 to `C:\Tools\apache-maven-3.9.9`.
4. Builds the project with Maven.
5. Downloads NSSM and creates a Windows Service named `WosScopusBot`.
6. Adds firewall rules for ports 8081 (API) and 5433 (PostgreSQL).
7. Sets service dependency: `WosScopusBot` depends on `postgresql-x64-16`.

### Uninstall
```powershell
.\scripts\uninstall-windows-server-2022.ps1
```
This permanently removes PostgreSQL, the service, JDK, Maven, NSSM, and all data.

### Service Management
```powershell
.\scripts\manage-service.ps1 -Action status   # or start, stop, restart, logs, remove
```

### Local Development
Use `docker-compose.yml` strictly for spinning up a local PostgreSQL instance. Do not use it for production.

---

## 11. Testing

> **Current state: There are no automated tests.**
> `src/test` does not contain any test classes.
> The build scripts explicitly use `-DskipTests`.

If you add tests, use:
- **JUnit 5** (already on classpath via `spring-boot-starter-test`)
- **Spring Boot Test** (`@SpringBootTest`) for integration tests against a test database.

Recommended test structure to create:
```
src/test/java/com/academic/broker/
├── ArticleTaskBrokerApplicationTests.java
├── api/ArticleTaskControllerTest.java
├── service/ArticleTaskServiceTest.java
└── repository/ArticleTaskRepositoryTest.java
```

---

## 12. Security Considerations

1. **Default API Key**: The default key is `change-me-in-production`. The application logs a **WARN** on startup if this is not changed. Always set `BROKER_API_KEY` before deploying.
2. **CORS Wildcard**: In development, `chrome-extension://*` is allowed. In production, set `BROKER_EXTENSION_ORIGIN` to the exact extension ID.
3. **No HTTPS in local config**: The broker runs plain HTTP on `8081`. Use a reverse proxy (IIS, nginx, etc.) for TLS in production.
4. **Database credentials**: `application.yml` uses weak defaults (`postgres`/`password`). Override with environment variables in production.
5. **SQL Injection**: Controllers use Spring Data JPA; native query in `DoiEnrichTaskRepository` uses parameterized `:source` and `:batchSize` — do not concatenate user input into native queries.
6. **Row locking**: Poll and consume endpoints use pessimistic locking (`PESSIMISTIC_WRITE` / `SKIP LOCKED`) to prevent double-processing under concurrent extension workers.

---

## 13. Common Pitfalls for Agents

- **Do not assume Docker for production** — production is a native Windows Service.
- **Do not change `ddl-auto` to `create-drop` in production** — it would wipe the task queue.
- **Do not remove `@Lock` annotations** from repository poll/consume methods — race conditions will cause duplicate task processing.
- **Extension timeout vs. broker timeout**: `SCRAPE_TIMEOUT_MS` in `background.js` (60 min) must be **shorter** than `broker.processing-timeout-minutes` (120 min) so the extension fails gracefully before the broker resets the task.
- **Three separate controllers**: When adding a new task type, follow the existing pattern (controller → service method → repository → entity). Do not mix DOI enrichment logic into `ArticleTaskController`.
- **Native query portability**: `DoiEnrichTaskRepository.claimPending()` uses PostgreSQL-specific `FOR UPDATE SKIP LOCKED`. This will not work on H2 or MySQL without modification.

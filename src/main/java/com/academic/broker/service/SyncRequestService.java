package com.academic.broker.service;

import com.academic.broker.config.TenantRegistry;
import com.academic.broker.domain.ArticleTask;
import com.academic.broker.domain.SyncAuditLog;
import com.academic.broker.domain.SyncRequest;
import com.academic.broker.domain.SyncRequestOrigin;
import com.academic.broker.domain.SyncRequestStatus;
import com.academic.broker.domain.TaskStatus;
import com.academic.broker.exception.TaskNotFoundException;
import com.academic.broker.exception.TaskNotProcessableException;
import com.academic.broker.repository.ArticleTaskRepository;
import com.academic.broker.repository.PlumxTaskRepository;
import com.academic.broker.repository.SyncAuditLogRepository;
import com.academic.broker.repository.SyncRequestRepository;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.data.domain.Page;
import org.springframework.data.domain.Pageable;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.time.Duration;
import java.time.Instant;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.UUID;

/**
 * Owns the {@link SyncRequest} lifecycle in the broker (staging area).
 *
 * <p>Two creation paths:
 * <ul>
 *   <li>{@link #createFromBackend} — researcher hit "Senkronize Et"; the main
 *       backend forwards the request here. Worker will scrape.</li>
 *   <li>{@link #createManual} — operator manually creates a request from the
 *       panel. No worker involved.</li>
 * </ul>
 *
 * <p>Both converge on {@code READY_FOR_REVIEW}, where the operator can edit,
 * approve, or reject. A scheduled sweeper marks anything that overstays the
 * 24-hour SLA as {@code EXPIRED}.
 */
@Slf4j
@Service
@RequiredArgsConstructor
public class SyncRequestService {

    /** Hard SLA — operator must approve/reject within this window. */
    public static final Duration REVIEW_WINDOW = Duration.ofHours(24);

    /** Max attempts for the apply-to-backend webhook on transient failures. */
    public static final int MAX_APPLY_ATTEMPTS = 5;

    private final SyncRequestRepository repository;
    private final SyncAuditLogRepository auditRepository;
    private final ArticleTaskRepository articleTaskRepository;
    private final PlumxTaskRepository plumxTaskRepository;
    private final TenantRegistry tenantRegistry;

    @Value("${broker.sla-review-hours:24}")
    private int slaReviewHours;

    /**
     * Multi-tenant allowlist: comma-separated base URLs of the main backends
     * permitted to open sync requests (e.g. {@code https://rdlsis.sisli.edu.tr,
     * https://rawdatalibrary.net}). Empty = no restriction (single-tenant /
     * back-compat). Guards against the broker being coerced into POSTing
     * approved data + a token to an arbitrary attacker URL (SSRF).
     */
    @Value("${broker.allowed-backend-urls:}")
    private String allowedBackendUrls;

    private Duration reviewWindow() {
        return Duration.ofHours(slaReviewHours);
    }

    /**
     * Validates a backend callback URL against {@link #allowedBackendUrls} and
     * returns it trailing-slash-normalised, or {@code null} if none supplied
     * (→ apply falls back to the global target). Throws
     * {@link IllegalArgumentException} when an allowlist is configured and the
     * URL is not on it.
     */
    private String validateBackendUrl(String raw) {
        if (raw == null || raw.isBlank()) return null;
        String url = trimSlash(raw.trim());
        // Registered tenants are implicitly allowed (registry is the source of truth).
        if (tenantRegistry.byUrl(url).isPresent()) return url;
        if (allowedBackendUrls == null || allowedBackendUrls.isBlank()) {
            return url; // no allowlist configured → accept (back-compat)
        }
        for (String allowed : allowedBackendUrls.split(",")) {
            String a = trimSlash(allowed.trim());
            if (!a.isEmpty() && a.equalsIgnoreCase(url)) return url;
        }
        throw new IllegalArgumentException("Backend URL not in broker allowlist: " + url);
    }

    private static String trimSlash(String s) {
        return s.endsWith("/") ? s.substring(0, s.length() - 1) : s;
    }

    // ──────────────────────────────────────────────────────────────────
    //  Creation
    // ──────────────────────────────────────────────────────────────────

    /**
     * Backend forwards a researcher's "senkronize et" request here. We open
     * a new SyncRequest in PENDING_SCRAPE state and the worker pipeline
     * picks up tasks for the configured external ids.
     */
    @Transactional
    public SyncRequest createFromBackend(UUID requesterUserId,
                                         Map<String, Object> profileSnapshot,
                                         String backendBaseUrl,
                                         String callbackToken) {
        // Validate (and normalise) the per-tenant callback URL up front so a
        // disallowed backend fails fast with 400 before any state changes.
        String validatedBackendUrl = validateBackendUrl(backendBaseUrl);
        ensureNoActive(requesterUserId);
        // Critical pre-flight: clear out any worker tasks tied to closed
        // sync requests (or to nothing). Without this, a leftover Scholar
        // task from a previously-rejected sync would prevent addTasks from
        // queuing a fresh Scholar task for THIS request — the dedupe check
        // in addTasks treats the old PENDING row as "already in-flight" and
        // skips. Worker would then complete the old task into the closed
        // sync, and the new one would never see Scholar data.
        wipeOrphanWorkerTasks();

        Instant now = Instant.now();
        // SLA countdown starts AT REQUEST TIME — not when scrape finishes.
        // The full 24h window covers worker scrape + operator review, so
        // a slow scrape eats into the operator's review budget. This
        // matches the researcher's UX expectation (countdown begins
        // visible the moment they hit "Senkronize Et") and lets the
        // worker prioritize requests by remaining time when picking
        // tasks off its queue.
        SyncRequest req = SyncRequest.builder()
                .requesterUserId(requesterUserId)
                .requesterProfileSnapshot(profileSnapshot)
                .backendBaseUrl(validatedBackendUrl)
                .backendCallbackToken(validatedBackendUrl == null ? null : callbackToken)
                .origin(SyncRequestOrigin.WORKER)
                .status(SyncRequestStatus.PENDING_SCRAPE)
                .expiresAt(now.plus(reviewWindow()))
                .updatedAt(now)
                .build();
        SyncRequest saved = repository.save(req);
        audit(saved.getId(), null, "WORKER", "CREATE",
                Map.of("origin", "WORKER", "requester", requesterUserId.toString(),
                        "expiresAt", saved.getExpiresAt().toString()));
        log.info("[SyncRequest] {} created (WORKER) for user {} — expires {}",
                saved.getId(), requesterUserId, saved.getExpiresAt());
        return saved;
    }

    /** Operator hand-creates an entry from the panel. */
    @Transactional
    public SyncRequest createManual(UUID requesterUserId,
                                    UUID operatorUserId,
                                    Map<String, Object> profileSnapshot,
                                    Map<String, Object> stagedData,
                                    String operatorNote,
                                    String backendBaseUrl) {
        // Multi-tenant: if the operator chose a target backend, resolve its
        // callback token from the registry so the approved sync routes there.
        // Unknown URL → IllegalArgumentException (caller maps to 400). Blank →
        // null → apply falls back to the global broker.backend-url (single-tenant).
        String tenantUrl = null;
        String tenantToken = null;
        if (backendBaseUrl != null && !backendBaseUrl.isBlank()) {
            TenantRegistry.Tenant t = tenantRegistry.byUrl(backendBaseUrl)
                    .orElseThrow(() -> new IllegalArgumentException("Unknown tenant URL: " + backendBaseUrl));
            tenantUrl = t.url;
            tenantToken = t.callbackToken;
        }
        ensureNoActive(requesterUserId);
        Instant now = Instant.now();
        SyncRequest req = SyncRequest.builder()
                .requesterUserId(requesterUserId)
                .requesterProfileSnapshot(profileSnapshot)
                .backendBaseUrl(tenantUrl)
                .backendCallbackToken(tenantToken)
                .origin(SyncRequestOrigin.MANUAL)
                .status(SyncRequestStatus.READY_FOR_REVIEW)
                .expiresAt(now.plus(reviewWindow()))
                .stagedData(stagedData)
                .operatorNote(operatorNote)
                .updatedAt(now)
                .build();
        SyncRequest saved = repository.save(req);
        audit(saved.getId(), operatorUserId, "OPERATOR", "CREATE",
                Map.of("origin", "MANUAL"));
        log.info("[SyncRequest] {} created (MANUAL) by operator {}", saved.getId(), operatorUserId);
        return saved;
    }

    // ──────────────────────────────────────────────────────────────────
    //  Reads
    // ──────────────────────────────────────────────────────────────────

    @Transactional(readOnly = true)
    public Optional<SyncRequest> findActive(UUID userId) {
        return repository.findActiveForUser(userId);
    }

    @Transactional(readOnly = true)
    public SyncRequest get(UUID id) {
        return repository.findById(id)
                .orElseThrow(() -> new TaskNotFoundException(0L));
    }

    @Transactional(readOnly = true)
    public Page<SyncRequest> findOperatorQueue(Pageable pageable) {
        return repository.findByStatusIn(
                List.of(SyncRequestStatus.PENDING_SCRAPE,
                        SyncRequestStatus.READY_FOR_REVIEW,
                        SyncRequestStatus.FAILED),
                pageable);
    }

    @Transactional(readOnly = true)
    public Page<SyncRequest> findByStatus(SyncRequestStatus status, Pageable pageable) {
        return repository.findByStatusOrderByRequestedAtDesc(status, pageable);
    }

    @Transactional(readOnly = true)
    public Page<SyncRequest> findAll(Pageable pageable) {
        return repository.findAllByOrderByRequestedAtDesc(pageable);
    }

    @Transactional(readOnly = true)
    public Map<SyncRequestStatus, Long> getStatusCounts() {
        Map<SyncRequestStatus, Long> result = new HashMap<>();
        for (SyncRequestStatus s : SyncRequestStatus.values()) {
            result.put(s, repository.countByStatus(s));
        }
        return result;
    }

    /**
     * Operator performance widgets — counts + average response time over a
     * recent window. Cheap; no group-by aggregation, just iterates the rows
     * reviewed since the cutoff (typically &lt; 1000 / week in practice).
     */
    @Transactional(readOnly = true)
    public Map<String, Object> getPerformanceMetrics(Duration window) {
        Instant cutoff = Instant.now().minus(window);
        List<SyncRequest> reviewed = repository.findReviewedSince(cutoff);

        long approved = 0, rejected = 0, expired = 0;
        long totalResponseSec = 0;
        int responseSamples = 0;
        Map<UUID, Long> perOperator = new HashMap<>();

        for (SyncRequest r : reviewed) {
            switch (r.getStatus()) {
                case APPROVED -> approved++;
                case REJECTED -> rejected++;
                case EXPIRED  -> expired++;
                default -> { /* still in flight; reviewedAt may be from a prior cycle */ }
            }
            if (r.getReviewedAt() != null && r.getRequestedAt() != null
                    && r.getStatus() != SyncRequestStatus.EXPIRED) {
                long secs = Duration.between(r.getRequestedAt(), r.getReviewedAt()).toSeconds();
                if (secs >= 0) {
                    totalResponseSec += secs;
                    responseSamples++;
                }
            }
            if (r.getReviewedByUserId() != null) {
                perOperator.merge(r.getReviewedByUserId(), 1L, Long::sum);
            }
        }

        long avgResponseSec = responseSamples > 0 ? totalResponseSec / responseSamples : 0;

        Map<String, Object> out = new java.util.LinkedHashMap<>();
        out.put("windowHours", window.toHours());
        out.put("totalReviewed", (long) reviewed.size());
        out.put("approved", approved);
        out.put("rejected", rejected);
        out.put("expired", expired);
        out.put("avgResponseSec", avgResponseSec);
        out.put("avgResponseMin", avgResponseSec / 60);
        out.put("perOperatorCounts", perOperator);
        return out;
    }

    // ──────────────────────────────────────────────────────────────────
    //  Worker pipeline transitions
    // ──────────────────────────────────────────────────────────────────

    /** Updates per-source progress while scraping is in flight. */
    @Transactional
    public void updateSourceProgress(UUID id, Map<String, Object> sourceProgress) {
        SyncRequest req = get(id);
        req.setSourceProgress(sourceProgress);
        req.touch();
        repository.save(req);
    }

    /**
     * Folds a single source's payload into the request's stagedData. Used by
     * non-worker fetchers (backend OpenAlex caller, operator manual fills,
     * external API integrations) so they all converge on the same
     * approve-pipeline as the Chrome extension.
     *
     * <p>Also merges per-publication entries into the unified
     * {@code stagedData.publications} list, the same way the worker bridge
     * does, so the operator panel renders them uniformly.
     */
    @Transactional
    public void writeSourceData(UUID id, String source, Map<String, Object> sourceBlob) {
        if (source == null || source.isBlank()) {
            throw new IllegalArgumentException("source is required");
        }
        String sourceKey = source.trim().toUpperCase(java.util.Locale.ROOT);
        SyncRequest req = get(id);

        Map<String, Object> staged = req.getStagedData() != null
                ? new HashMap<>(req.getStagedData()) : new HashMap<>();
        Map<String, Object> blob = sourceBlob != null ? new HashMap<>(sourceBlob) : new HashMap<>();
        if (!blob.containsKey("provenance")) blob.put("provenance", "BACKEND");
        if (!blob.containsKey("scrapedAt")) blob.put("scrapedAt", java.time.Instant.now().toString());
        staged.put(sourceKey, blob);

        // Lift any per-publication entries onto stagedData.publications,
        // mirroring the worker bridge's behaviour. Source labels accumulate.
        Object pubsObj = blob.get("publications");
        if (pubsObj == null) {
            Object raw = blob.get("rawData");
            if (raw instanceof Map<?, ?> rm) pubsObj = ((Map<String, Object>) rm).get("publications");
        }
        if (pubsObj instanceof java.util.List<?> rawList && !rawList.isEmpty()) {
            mergePublicationsInto(staged, sourceKey, rawList);
        }

        req.setStagedData(staged);

        Map<String, Object> progress = req.getSourceProgress() != null
                ? new HashMap<>(req.getSourceProgress()) : new HashMap<>();
        progress.put(sourceKey, "OK");
        req.setSourceProgress(progress);

        // If we're past PENDING_SCRAPE we don't change status; if we're still
        // there and this completes the picture, the worker bridge will flip
        // us to READY_FOR_REVIEW from its own callback. Calling this method
        // before the worker even fires is fine — status stays PENDING_SCRAPE.
        req.touch();
        repository.save(req);
        audit(id, null, "BACKEND", "SOURCE_DATA_WRITTEN",
                Map.of("source", sourceKey,
                        "publicationsAdded", pubsObj instanceof java.util.List<?> l ? l.size() : 0));
    }

    /**
     * Same DOI-keyed merge logic as the worker bridge — kept here so backend
     * fetchers don't need to depend on the bridge bean.
     */
    @SuppressWarnings("unchecked")
    private static void mergePublicationsInto(Map<String, Object> staged, String sourceKey, java.util.List<?> rawList) {
        java.util.List<Map<String, Object>> existing = new java.util.ArrayList<>();
        Object existingObj = staged.get("publications");
        if (existingObj instanceof java.util.List<?>) {
            for (Object o : (java.util.List<?>) existingObj) {
                if (o instanceof Map<?, ?> m) existing.add(new HashMap<>((Map<String, Object>) m));
            }
        }
        java.util.LinkedHashMap<String, Map<String, Object>> byKey = new java.util.LinkedHashMap<>();
        for (Map<String, Object> e : existing) {
            String k = pubKey(e);
            if (k != null) byKey.put(k, e);
        }
        for (Object raw : rawList) {
            if (!(raw instanceof Map<?, ?> m)) continue;
            Map<String, Object> incoming = (Map<String, Object>) m;
            // Tag this incoming row with the source so badges line up
            java.util.LinkedHashSet<String> srcSet = new java.util.LinkedHashSet<>();
            Object existingSrc = incoming.get("sources");
            if (existingSrc instanceof java.util.List<?> sl) {
                for (Object s : sl) if (s != null) srcSet.add(String.valueOf(s));
            }
            srcSet.add(sourceKey);
            Map<String, Object> normalized = new HashMap<>(incoming);
            normalized.put("sources", new java.util.ArrayList<>(srcSet));
            if (!normalized.containsKey("provenance")) normalized.put("provenance", "BACKEND");

            String key = pubKey(normalized);
            if (key == null) continue;
            Map<String, Object> merged = byKey.get(key);
            if (merged == null) {
                byKey.put(key, normalized);
            } else {
                // Backfill missing scalar fields
                for (var e : normalized.entrySet()) {
                    Object cur = merged.get(e.getKey());
                    if (cur == null || (cur instanceof String s && s.isBlank())) {
                        merged.put(e.getKey(), e.getValue());
                    }
                }
                // Merge citations + sources
                Object curCit = merged.get("citations");
                Object newCit = normalized.get("citations");
                if (newCit instanceof Map<?, ?> nm) {
                    Map<String, Object> cit = curCit instanceof Map<?, ?> cm
                            ? new HashMap<>((Map<String, Object>) cm) : new HashMap<>();
                    for (var e : ((Map<String, Object>) nm).entrySet()) {
                        if (e.getValue() instanceof Number n) cit.put(e.getKey(), n.intValue());
                    }
                    if (!cit.isEmpty()) merged.put("citations", cit);
                }
                Object curSrc = merged.get("sources");
                java.util.LinkedHashSet<String> ms = new java.util.LinkedHashSet<>();
                if (curSrc instanceof java.util.List<?> ls) {
                    for (Object s : ls) if (s != null) ms.add(String.valueOf(s));
                }
                ms.addAll(srcSet);
                merged.put("sources", new java.util.ArrayList<>(ms));
            }
        }
        staged.put("publications", new java.util.ArrayList<>(byKey.values()));
    }

    private static String pubKey(Map<String, Object> p) {
        Object doi = p.get("doi");
        if (doi instanceof String d && !d.isBlank()) return "doi:" + d.trim().toLowerCase();
        Object title = p.get("title");
        if (title instanceof String t && !t.isBlank()) return "title:" + t.trim().toLowerCase();
        return null;
    }

    /**
     * Worker pipeline finished — flip to READY_FOR_REVIEW and start the
     * 24-hour clock now (not at request time, so operator gets a fair window).
     */
    @Transactional
    public void markScrapeComplete(UUID id, Map<String, Object> stagedData,
                                   Map<String, Object> sourceProgress) {
        SyncRequest req = get(id);
        if (req.getStatus() != SyncRequestStatus.PENDING_SCRAPE) {
            log.warn("[SyncRequest] markScrapeComplete on {} in unexpected status {}",
                    id, req.getStatus());
            req.setStagedData(stagedData);
            if (sourceProgress != null) req.setSourceProgress(sourceProgress);
            req.touch();
            repository.save(req);
            return;
        }
        req.setStagedData(stagedData);
        if (sourceProgress != null) req.setSourceProgress(sourceProgress);
        req.setStatus(SyncRequestStatus.READY_FOR_REVIEW);
        // Preserve expiresAt — it was set at request creation so the
        // SLA covers scrape + review combined. Overwriting here would
        // give the operator a fresh 24h window every time the worker
        // happened to finish, masking slow scrapes.
        if (req.getExpiresAt() == null) {
            // Defensive fallback for legacy rows created before the
            // create-time expiresAt change.
            req.setExpiresAt(Instant.now().plus(reviewWindow()));
        }
        req.touch();
        repository.save(req);
        audit(id, null, "WORKER", "SCRAPE_COMPLETE",
                Map.of("expiresAt", req.getExpiresAt().toString()));
        log.info("[SyncRequest] {} → READY_FOR_REVIEW (expires {})", id, req.getExpiresAt());
    }

    /** Worker fully failed (no source produced data). Operator can still recover manually. */
    @Transactional
    public void markScrapeFailed(UUID id, String reason, Map<String, Object> sourceProgress) {
        SyncRequest req = get(id);
        if (sourceProgress != null) req.setSourceProgress(sourceProgress);
        req.setStatus(SyncRequestStatus.FAILED);
        req.setRejectionReason(reason);
        // Preserve original expiresAt for the same reason as
        // markScrapeComplete — operator's review SLA isn't extended just
        // because the scrape failed.
        if (req.getExpiresAt() == null) {
            req.setExpiresAt(Instant.now().plus(reviewWindow()));
        }
        req.touch();
        repository.save(req);
        audit(id, null, "WORKER", "SCRAPE_FAILED", Map.of("reason", reason == null ? "" : reason));
        log.warn("[SyncRequest] {} → FAILED ({})", id, reason);
    }

    // ──────────────────────────────────────────────────────────────────
    //  Operator transitions
    // ──────────────────────────────────────────────────────────────────

    /** Operator edits the staged data — saves overrides into editedData. */
    @Transactional
    public SyncRequest applyEdits(UUID id, UUID operatorUserId,
                                  Map<String, Object> editedData,
                                  Map<String, Object> approvedFields,
                                  String operatorNote) {
        SyncRequest req = get(id);
        if (isTerminal(req.getStatus())) {
            throw new TaskNotProcessableException(0L, null, "edit (already terminal: " + req.getStatus() + ")");
        }
        req.setEditedData(editedData);
        if (approvedFields != null) req.setApprovedFields(approvedFields);
        if (operatorNote != null) req.setOperatorNote(operatorNote);
        // WORKER → HYBRID once operator touches it
        if (req.getOrigin() == SyncRequestOrigin.WORKER) {
            req.setOrigin(SyncRequestOrigin.HYBRID);
        }
        req.touch();
        repository.save(req);
        audit(id, operatorUserId, "OPERATOR", "EDIT",
                Map.of("hasEdits", editedData != null));
        // Promote operator-entered identifiers onto the snapshot on SAVE, so the
        // panel's top IDs (MEVCUT links) flip to the typed values immediately and
        // a subsequent re-scrape resolves the external id from them.
        return promoteEditedIdentifiers(id, operatorUserId);
    }

    /**
     * Promotes operator-entered external identifiers (from
     * {@code editedData.identifiers}) onto the {@code requesterProfileSnapshot}
     * so re-scrapes can use a freshly-typed WoS/Scopus/Scholar/ORCID id, the id
     * survives a {@code resetForRescrape}, and it shows as MEVCUT in the panel.
     *
     * <p>Non-blank values only (never wipes a known id with a blank field).
     * Idempotent — a no-op when nothing changed. Leaves {@code editedData}
     * untouched so the approve → apply-sync path still writes the id onto the
     * researcher's ResearcherProfile.
     */
    @Transactional
    public SyncRequest promoteEditedIdentifiers(UUID id, UUID operatorUserId) {
        SyncRequest req = get(id);
        Object idsObj = req.getEditedData() == null ? null : req.getEditedData().get("identifiers");
        if (!(idsObj instanceof Map<?, ?> im)) return req;
        @SuppressWarnings("unchecked")
        Map<String, Object> ids = (Map<String, Object>) im;

        Map<String, Object> snap = req.getRequesterProfileSnapshot();
        Map<String, Object> newSnap = (snap == null)
                ? new java.util.HashMap<>() : new java.util.HashMap<>(snap);

        boolean changed = false;
        for (String key : new String[]{"orcid", "publonsId", "scopusId", "googleScholarId"}) {
            Object v = ids.get(key);
            if (v == null) continue;
            String s = v.toString().trim();
            if (s.isEmpty()) continue;
            String current = newSnap.get(key) == null ? null : newSnap.get(key).toString();
            if (!s.equals(current)) {
                newSnap.put(key, s);
                changed = true;
            }
        }
        if (!changed) return req;

        req.setRequesterProfileSnapshot(newSnap);
        req.touch();
        repository.save(req);
        audit(id, operatorUserId, "OPERATOR", "PROMOTE_IDENTIFIERS",
                Map.of("fields", new java.util.ArrayList<>(ids.keySet())));
        return req;
    }

    /** "Onayla ve Gönder" — flips to APPROVED. Apply-to-backend webhook runs separately. */
    @Transactional
    public SyncRequest approve(UUID id, UUID operatorUserId, String notes) {
        SyncRequest req = get(id);
        boolean reviewable = req.getStatus() == SyncRequestStatus.READY_FOR_REVIEW
                || req.getStatus() == SyncRequestStatus.FAILED;
        // Stuck-PlumX escape hatch. A request normally waits for the PlumX /
        // citation-report enrichment to land before auto-flipping to
        // READY_FOR_REVIEW (so the operator sees Scopus citations on first
        // review). But PlumX can stall indefinitely when no worker picks the
        // task up — which used to pin the request in PENDING_SCRAPE forever, so
        // every "Onayla ve Gönder" returned 409 Conflict. Allow approval
        // straight from PENDING_SCRAPE once the CORE scrapes (WoS/Scopus/
        // Scholar/OpenAlex article tasks) are all terminal; only the enrichment
        // overlay is outstanding and the operator has chosen to send what landed.
        if (!reviewable && req.getStatus() == SyncRequestStatus.PENDING_SCRAPE
                && coreScrapeTasksDone(id)) {
            reviewable = true;
            log.info("[SyncRequest] {} approved from PENDING_SCRAPE — core scrape done, enrichment (PlumX) still pending", id);
        }
        if (!reviewable) {
            throw new TaskNotProcessableException(0L, null,
                    "approve (status: " + req.getStatus() + ")");
        }
        Instant now = Instant.now();
        req.setStatus(SyncRequestStatus.APPROVED);
        req.setReviewedByUserId(operatorUserId);
        req.setReviewedAt(now);
        if (notes != null && !notes.isBlank()) req.setReviewerNotes(notes);
        req.touch();
        repository.save(req);
        cleanupWorkerTasks(id, "APPROVED");
        long elapsedSec = Duration.between(req.getRequestedAt(), now).toSeconds();
        audit(id, operatorUserId, "OPERATOR", "APPROVE",
                Map.of("elapsedSec", elapsedSec));
        log.info("[SyncRequest] {} APPROVED by operator {} (took {}s)", id, operatorUserId, elapsedSec);
        return req;
    }

    /**
     * True when every WoS/Scopus/Scholar/OpenAlex article task for this request
     * has reached a terminal status (COMPLETED/FAILED) — i.e., the real source
     * scrape is finished and only the PlumX / citation-report enrichment overlay
     * (separate task pools) may still be outstanding. Backs the approval escape
     * hatch so a stalled enrichment task can't lock a request forever.
     */
    private boolean coreScrapeTasksDone(UUID syncRequestId) {
        List<ArticleTask> linked = articleTaskRepository.findBySyncRequestId(syncRequestId);
        if (linked.isEmpty()) return false;
        for (ArticleTask t : linked) {
            TaskStatus s = t.getStatus();
            if (s == TaskStatus.PENDING || s == TaskStatus.PROCESSING) return false;
        }
        return true;
    }

    @Transactional
    public SyncRequest reject(UUID id, UUID operatorUserId, String reason) {
        if (reason == null || reason.isBlank()) {
            throw new IllegalArgumentException("Reddetme sebebi zorunludur");
        }
        SyncRequest req = get(id);
        if (isTerminal(req.getStatus())) {
            throw new TaskNotProcessableException(0L, null, "reject (already terminal: " + req.getStatus() + ")");
        }
        Instant now = Instant.now();
        req.setStatus(SyncRequestStatus.REJECTED);
        req.setReviewedByUserId(operatorUserId);
        req.setReviewedAt(now);
        req.setRejectionReason(reason);
        req.touch();
        repository.save(req);
        cleanupWorkerTasks(id, "REJECTED");
        audit(id, operatorUserId, "OPERATOR", "REJECT", Map.of("reason", reason));
        log.info("[SyncRequest] {} REJECTED by operator {}", id, operatorUserId);
        return req;
    }

    @Transactional
    public List<SyncRequest> bulkApprove(List<UUID> ids, UUID operatorUserId, String notes) {
        return ids.stream().map(id -> approve(id, operatorUserId, notes)).toList();
    }

    @Transactional
    public List<SyncRequest> bulkReject(List<UUID> ids, UUID operatorUserId, String reason) {
        return ids.stream().map(id -> reject(id, operatorUserId, reason)).toList();
    }

    /** Marks the request as successfully applied to the main backend. */
    @Transactional
    public void markApplied(UUID id) {
        SyncRequest req = get(id);
        req.setAppliedToBackend(true);
        req.setAppliedAt(Instant.now());
        req.touch();
        repository.save(req);
        audit(id, null, "SYSTEM", "APPLY_TO_BACKEND", Map.of("attempts", req.getApplyAttempts()));
    }

    @Transactional
    public void recordApplyAttempt(UUID id, String error) {
        SyncRequest req = get(id);
        req.setApplyAttempts(req.getApplyAttempts() + 1);
        req.touch();
        repository.save(req);
        audit(id, null, "SYSTEM", "APPLY_RETRY",
                Map.of("attempt", req.getApplyAttempts(), "error", error == null ? "" : error));
        // Once attempts reach the cap, the request drops out of
        // findUnappliedApprovals (applyAttempts < MAX) and would otherwise be
        // silently abandoned in APPROVED+appliedToBackend=false forever. Make
        // that loud + auditable so the data loss can't go unnoticed.
        if (req.getApplyAttempts() >= MAX_APPLY_ATTEMPTS) {
            log.error("[Apply] PARKED sync {} after {} failed apply attempts — backend never received it; "
                    + "needs manual attention (last error: {})", id, req.getApplyAttempts(), error);
            audit(id, null, "SYSTEM", "APPLY_PARKED",
                    Map.of("attempts", req.getApplyAttempts(), "error", error == null ? "" : error));
        }
    }

    /**
     * Immediately parks an approval that failed with a NON-retryable error
     * (4xx: wrong internal key, malformed payload, too large). Bumps
     * applyAttempts to the cap so the retry loop won't keep burning identical
     * attempts (~20s of futile retries) before parking, and records a distinct
     * APPLY_REJECTED audit action so a config error is never mistaken for a
     * transient outage.
     */
    @Transactional
    public void parkApplyNonRetryable(UUID id, String error) {
        SyncRequest req = get(id);
        req.setApplyAttempts(MAX_APPLY_ATTEMPTS);
        req.touch();
        repository.save(req);
        log.error("[Apply] PARKED sync {} — non-retryable backend rejection: {}", id, error);
        audit(id, null, "SYSTEM", "APPLY_REJECTED",
                Map.of("attempts", req.getApplyAttempts(), "error", error == null ? "" : error));
    }

    /** Approved requests whose backend apply permanently failed — needs manual attention. */
    @Transactional(readOnly = true)
    public List<SyncRequest> findParkedApprovals() {
        return repository.findParkedApprovals(MAX_APPLY_ATTEMPTS);
    }

    // ──────────────────────────────────────────────────────────────────
    //  Audit log helpers
    // ──────────────────────────────────────────────────────────────────

    public void audit(UUID syncRequestId, UUID actorUserId, String actorKind, String action,
                      Map<String, Object> details) {
        SyncAuditLog entry = SyncAuditLog.builder()
                .syncRequestId(syncRequestId)
                .actorUserId(actorUserId)
                .actorKind(actorKind)
                .action(action)
                .details(details)
                .build();
        auditRepository.save(entry);
    }

    @Transactional(readOnly = true)
    public List<SyncAuditLog> getAuditTrail(UUID syncRequestId) {
        return auditRepository.findBySyncRequestIdOrderByCreatedAtAsc(syncRequestId);
    }

    // ──────────────────────────────────────────────────────────────────
    //  Helpers
    // ──────────────────────────────────────────────────────────────────

    private void ensureNoActive(UUID userId) {
        repository.findActiveForUser(userId).ifPresent(existing -> {
            throw new IllegalStateException("Bu kullanıcının aktif bir senkronizasyon isteği zaten var: "
                    + existing.getId());
        });
    }

    /**
     * Resets a SyncRequest back to its newly-created state: wipes
     * {@code stagedData}, {@code editedData}, {@code approvedFields},
     * {@code sourceProgress}, and any PENDING / PROCESSING worker rows
     * tied to it. Status flips to {@code PENDING_SCRAPE} regardless of
     * what it was (READY_FOR_REVIEW / FAILED / PENDING_SCRAPE), so the
     * operator panel countdown / queue chips reset too.
     *
     * <p>Used by the panel's "Tümünü Yeniden Çek" — the operator wants a
     * full re-scrape exactly as if the researcher had just hit
     * "Senkronize Et" again, but without losing the request id (audit
     * trail + history pages still link to the same id). Per-source
     * "Tekrar Çek" does NOT call this; it's intentionally a lighter
     * METRICS_ONLY refresh that preserves operator edits.
     */
    @Transactional
    public SyncRequest resetForRescrape(UUID syncRequestId, UUID operatorUserId) {
        SyncRequest req = get(syncRequestId);
        if (isTerminal(req.getStatus())) {
            throw new TaskNotProcessableException(0L, null,
                    "rescrape (already terminal: " + req.getStatus() + ")");
        }
        // Clear staging blobs + per-source progress + reviewed fields.
        Instant now = Instant.now();
        req.setStagedData(null);
        req.setEditedData(null);
        req.setApprovedFields(null);
        req.setSourceProgress(null);
        req.setStatus(SyncRequestStatus.PENDING_SCRAPE);
        // Reset SLA — a re-scrape gets a fresh 24h window starting now,
        // exactly like the user had hit "Senkronize Et" again. Worker
        // priority queue immediately sees this request with the full
        // window remaining.
        req.setExpiresAt(now.plus(reviewWindow()));
        req.setReviewedByUserId(null);
        req.setReviewedAt(null);
        req.setReviewerNotes(null);
        req.setRejectionReason(null);
        req.touch();
        repository.save(req);

        // Wipe leftover article + plumx tasks for this request.
        cleanupWorkerTasks(syncRequestId, "RESCRAPE");

        audit(syncRequestId, operatorUserId, "OPERATOR", "RESCRAPE",
                Map.of("note", "stagedData / editedData / progress wiped, status → PENDING_SCRAPE"));
        log.info("[SyncRequest] {} reset for full re-scrape by operator {}", syncRequestId, operatorUserId);
        return req;
    }

    /**
     * Wipes worker tasks (article + plumx) tied to a closed sync request
     * that are still PENDING / PROCESSING. Called from every state
     * transition that takes a request out of {@code PENDING_SCRAPE}:
     * approve, reject, expire, mark-applied. Without this, an old WoS
     * profile tab can finish scraping a minute after the operator approved
     * the request and pollute closed sync data — exactly the leftover
     * Scholar bug the operator reported.
     *
     * <p>Best-effort: failures are logged but never block the state
     * transition.
     */
    private void cleanupWorkerTasks(UUID syncRequestId, String reason) {
        try {
            List<TaskStatus> active = List.of(TaskStatus.PENDING, TaskStatus.PROCESSING);
            int articles = articleTaskRepository.deleteBySyncRequestIdAndStatusIn(syncRequestId, active);
            int plumx = plumxTaskRepository.deleteBySyncRequestIdAndStatusIn(syncRequestId, active);
            if (articles + plumx > 0) {
                log.info("[SyncRequest] {} {} — wiped {} article + {} plumx pending/processing tasks",
                        syncRequestId, reason, articles, plumx);
            }
        } catch (Exception e) {
            log.warn("[SyncRequest] {} task cleanup after {} failed: {}",
                    syncRequestId, reason, e.getMessage());
        }
    }

    /**
     * Removes any PENDING / PROCESSING worker tasks that aren't tied to a
     * sync request still in {@code PENDING_SCRAPE}. Called at the start of
     * every new sync creation so the worker doesn't keep churning on
     * leftovers from previously-closed requests, AND so {@code addTasks}
     * doesn't skip-create new tasks because an externalId already shows up
     * as active in the task table (the historical bug: an old Scholar task
     * from a rejected sync blocks the new sync from ever getting Scholar
     * data).
     *
     * <p>Returns the number of rows deleted across both task tables.
     */
    @Transactional
    public int wipeOrphanWorkerTasks() {
        try {
            List<TaskStatus> active = List.of(TaskStatus.PENDING, TaskStatus.PROCESSING);
            // Article-tasks
            List<com.academic.broker.domain.ArticleTask> orphanArticles =
                    articleTaskRepository.findOrphans(active);
            int a = orphanArticles.size();
            if (!orphanArticles.isEmpty()) {
                articleTaskRepository.deleteAll(orphanArticles);
            }
            // PlumX-tasks
            List<com.academic.broker.domain.PlumxTask> orphanPlumx =
                    plumxTaskRepository.findOrphans(active);
            int p = orphanPlumx.size();
            if (!orphanPlumx.isEmpty()) {
                plumxTaskRepository.deleteAll(orphanPlumx);
            }
            int total = a + p;
            if (total > 0) {
                log.info("[SyncRequest] Wiped {} orphan worker tasks ({} article, {} plumx)",
                        total, a, p);
            }
            return total;
        } catch (Exception e) {
            log.warn("[SyncRequest] orphan task wipe failed: {}", e.getMessage());
            return 0;
        }
    }

    public static boolean isTerminal(SyncRequestStatus status) {
        return status == SyncRequestStatus.APPROVED
                || status == SyncRequestStatus.REJECTED
                || status == SyncRequestStatus.EXPIRED;
    }

    @Transactional(readOnly = true)
    public List<SyncRequest> findUnappliedApprovals() {
        return repository.findUnappliedApprovals(MAX_APPLY_ATTEMPTS);
    }
}

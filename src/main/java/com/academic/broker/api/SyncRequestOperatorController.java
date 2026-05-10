package com.academic.broker.api;

import com.academic.broker.api.dto.SyncRequestDtos;
import com.academic.broker.config.OperatorAuthFilter;
import com.academic.broker.domain.SyncAuditLog;
import com.academic.broker.domain.SyncRequest;
import com.academic.broker.domain.SyncRequestStatus;
import com.academic.broker.domain.TargetSource;
import com.academic.broker.domain.TaskType;
import com.academic.broker.domain.CitationReportTask;
import com.academic.broker.domain.TaskStatus;
import com.academic.broker.repository.CitationReportTaskRepository;
import com.academic.broker.service.ArticleTaskService;
import com.academic.broker.service.BackendApplyService;
import com.academic.broker.service.SyncRequestService;
import lombok.RequiredArgsConstructor;
import org.springframework.data.domain.Page;
import org.springframework.data.domain.PageRequest;
import org.springframework.data.domain.Pageable;
import org.springframework.data.domain.Sort;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;

import java.util.List;
import java.util.Map;
import java.util.UUID;

/**
 * Operator panel API. All endpoints under {@code /api/operator/sync-requests}
 * require a valid operator token (handled by {@link OperatorAuthFilter} which
 * stamps {@code OperatorAuthFilter.OPERATOR_ID_ATTR} into the request).
 */
@RestController
@RequestMapping("/api/operator/sync-requests")
@RequiredArgsConstructor
public class SyncRequestOperatorController {

    private final SyncRequestService service;
    private final BackendApplyService applyService;
    private final ArticleTaskService articleTaskService;
    private final CitationReportTaskRepository citationReportRepository;

    // ── List / detail ────────────────────────────────────────────────

    @GetMapping
    public Page<SyncRequestDtos.OperatorView> list(
            @RequestParam(required = false) SyncRequestStatus status,
            @RequestParam(required = false) String filter,
            @RequestParam(defaultValue = "0") int page,
            @RequestParam(defaultValue = "25") int size) {

        Pageable pageable = PageRequest.of(page, size);
        Page<SyncRequest> result;
        if ("queue".equalsIgnoreCase(filter) || filter == null) {
            // default: operator queue (non-terminal) sorted by SLA urgency
            result = service.findOperatorQueue(pageable);
        } else if (status != null) {
            result = service.findByStatus(status, pageable);
        } else {
            result = service.findAll(PageRequest.of(page, size,
                    Sort.by(Sort.Direction.DESC, "requestedAt")));
        }
        return result.map(SyncRequestDtos.OperatorView::from);
    }

    @GetMapping("/stats")
    public Map<String, Long> stats() {
        Map<SyncRequestStatus, Long> counts = service.getStatusCounts();
        return Map.of(
                "pendingScrape", counts.getOrDefault(SyncRequestStatus.PENDING_SCRAPE, 0L),
                "readyForReview", counts.getOrDefault(SyncRequestStatus.READY_FOR_REVIEW, 0L),
                "failed", counts.getOrDefault(SyncRequestStatus.FAILED, 0L),
                "approved", counts.getOrDefault(SyncRequestStatus.APPROVED, 0L),
                "rejected", counts.getOrDefault(SyncRequestStatus.REJECTED, 0L),
                "expired", counts.getOrDefault(SyncRequestStatus.EXPIRED, 0L)
        );
    }

    /**
     * Operator performance summary. Default window is 7 days. Returns
     * counts + average response time + per-operator breakdown.
     */
    @GetMapping("/metrics")
    public Map<String, Object> performanceMetrics(
            @RequestParam(name = "windowHours", required = false, defaultValue = "168") long windowHours) {
        return service.getPerformanceMetrics(java.time.Duration.ofHours(windowHours));
    }

    @GetMapping("/{id}")
    public SyncRequestDtos.OperatorView get(@PathVariable UUID id) {
        return SyncRequestDtos.OperatorView.from(service.get(id));
    }

    @GetMapping("/{id}/audit")
    public List<SyncAuditLog> auditTrail(@PathVariable UUID id) {
        return service.getAuditTrail(id);
    }

    // ── Mutations ────────────────────────────────────────────────────

    @PostMapping("/manual")
    public ResponseEntity<SyncRequestDtos.OperatorView> createManual(
            @RequestBody SyncRequestDtos.CreateManualReq req,
            @RequestAttribute(OperatorAuthFilter.OPERATOR_ID_ATTR) UUID operatorId) {
        try {
            SyncRequest created = service.createManual(
                    req.getRequesterUserId(), operatorId,
                    req.getProfileSnapshot(), req.getStagedData(), req.getOperatorNote());
            return ResponseEntity.status(HttpStatus.CREATED)
                    .body(SyncRequestDtos.OperatorView.from(created));
        } catch (IllegalStateException e) {
            return ResponseEntity.status(HttpStatus.CONFLICT).build();
        }
    }

    @PatchMapping("/{id}")
    public SyncRequestDtos.OperatorView edit(
            @PathVariable UUID id,
            @RequestBody SyncRequestDtos.EditReq req,
            @RequestAttribute(OperatorAuthFilter.OPERATOR_ID_ATTR) UUID operatorId) {
        SyncRequest updated = service.applyEdits(id, operatorId,
                req.getEditedData(), req.getApprovedFields(), req.getOperatorNote());
        return SyncRequestDtos.OperatorView.from(updated);
    }

    @PostMapping("/{id}/approve")
    public SyncRequestDtos.OperatorView approve(
            @PathVariable UUID id,
            @RequestBody(required = false) SyncRequestDtos.ApproveReq req,
            @RequestAttribute(OperatorAuthFilter.OPERATOR_ID_ATTR) UUID operatorId) {
        String notes = req == null ? null : req.getNotes();
        SyncRequest approved = service.approve(id, operatorId, notes);
        // Fire-and-forget apply-to-backend; retry loop handles failures.
        applyService.applyNow(approved);
        return SyncRequestDtos.OperatorView.from(approved);
    }

    @PostMapping("/{id}/reject")
    public SyncRequestDtos.OperatorView reject(
            @PathVariable UUID id,
            @RequestBody SyncRequestDtos.RejectReq req,
            @RequestAttribute(OperatorAuthFilter.OPERATOR_ID_ATTR) UUID operatorId) {
        SyncRequest rejected = service.reject(id, operatorId, req.getReason());
        return SyncRequestDtos.OperatorView.from(rejected);
    }

    // ── Retry: all worker sources at once ────────────────────────────
    /**
     * <b>Full re-scrape</b> of every source on this SyncRequest — kicks off
     * fresh OPENALEX / WOS / SCOPUS / SCHOLAR tasks with {@code FULL_SCRAPE}
     * task type, AS IF the operator had cancelled the request and started
     * again. Differs from the per-source "Tekrar Çek" button (which uses
     * {@code METRICS_ONLY} for a quick author-dashboard refresh) because
     * the operator explicitly wants to start from scratch — they hit the
     * top-level "Tümünü Yeniden Çek" button.
     *
     * <p>Side effects:
     * <ul>
     *   <li>Every PENDING/PROCESSING task for the same externalId is
     *       wiped via {@code force=true} on addTasks.</li>
     *   <li>{@code stagedData.publications} stays put — the
     *       {@code rebuildPublications} pipeline will reconstruct it from
     *       the fresh per-source raw blobs as each source completes.</li>
     *   <li>{@code sourceProgress} for every retried source flips to
     *       PENDING so the operator panel chips show "Çekiliyor".</li>
     * </ul>
     * Sources that don't have an external id on the requester profile
     * snapshot are skipped — operator can still hit the per-source button
     * afterwards if they manually filled in an id.
     */
    @PostMapping("/{id}/retry-all")
    public Map<String, Object> retryAll(
            @PathVariable UUID id,
            @RequestAttribute(OperatorAuthFilter.OPERATOR_ID_ATTR) UUID operatorId) {
        // ── Step 1: full reset ───────────────────────────────────────
        // Behaves exactly like the researcher had hit "Senkronize Et"
        // again — wipes stagedData / editedData / approvedFields /
        // sourceProgress, deletes leftover article+plumx tasks, and
        // flips status back to PENDING_SCRAPE. Different from the
        // per-source "Tekrar Çek" button, which does an in-place
        // METRICS_ONLY refresh and preserves operator edits.
        SyncRequest req = service.resetForRescrape(id, operatorId);
        Map<String, Object> snap = req.getRequesterProfileSnapshot();
        Map<String, Object> progress = new java.util.HashMap<>();

        java.util.List<String> retried = new java.util.ArrayList<>();
        java.util.List<String> skipped = new java.util.ArrayList<>();

        // ── Step 2: queue fresh tasks ────────────────────────────────
        // Order matches the worker's serial pipeline:
        //   OPENALEX → WOS → SCOPUS → SCHOLAR
        // OpenAlex MUST come first because it lays down the publication
        // baseline (DOIs / titles / authorship) the rest enrich. Without
        // it, WoS/Scopus would race with no twin to attach to.
        for (TargetSource ts : new TargetSource[]{
                TargetSource.OPENALEX, TargetSource.WOS, TargetSource.SCOPUS, TargetSource.SCHOLAR}) {
            String externalId = resolveExternalId(snap, ts);
            if (externalId == null || externalId.isBlank()) {
                skipped.add(ts.name());
                continue;
            }
            articleTaskService.addTasks(ts, List.of(externalId), buildRedirectUrl(ts, externalId),
                    /*force*/ true, TaskType.FULL_SCRAPE, id);
            progress.put(ts.name(), "PENDING");
            retried.add(ts.name());
        }

        if (!retried.isEmpty()) {
            service.updateSourceProgress(id, progress);
            service.audit(id, operatorId, "OPERATOR", "RETRY_ALL",
                    Map.of("retried", retried, "skipped", skipped,
                            "taskType", "FULL_SCRAPE", "stagedDataReset", true));
        }
        return Map.of("ok", true, "retried", retried, "skipped", skipped, "reset", true);
    }

    // ── PlumX re-enrichment ──────────────────────────────────────────
    /**
     * Re-trigger PlumX citation enrichment for every DOI that's currently
     * in this request's staged publications list. Useful after a partial
     * scrape where PlumX numbers came back missing or zero.
     */
    /**
     * Operator panel: read-only summary of the WoS Citation Report task
     * tied to this sync (status, retry count, error, scraped payload).
     * Returns 200 with {@code task: null} when no citation report has
     * been queued for this sync — the panel renders "Atıf raporu yok"
     * in that case.
     */
    @GetMapping("/{id}/citation-report")
    public Map<String, Object> citationReportStatus(@PathVariable UUID id) {
        service.get(id); // existence check
        java.util.List<CitationReportTask> tasks = citationReportRepository.findBySyncRequestId(id);
        if (tasks.isEmpty()) return Map.of("task", "");
        CitationReportTask t = tasks.get(0);
        java.util.Map<String, Object> dto = new java.util.HashMap<>();
        dto.put("taskId", t.getId());
        dto.put("status", t.getStatus().name());
        dto.put("citationReportUrl", t.getCitationReportUrl());
        dto.put("authorWosId", t.getAuthorWosId());
        dto.put("retryCount", t.getRetryCount());
        dto.put("errorMessage", t.getErrorMessage());
        dto.put("createdAt", t.getCreatedAt() != null ? t.getCreatedAt().toString() : null);
        dto.put("updatedAt", t.getUpdatedAt() != null ? t.getUpdatedAt().toString() : null);
        dto.put("rawData", t.getRawData());
        return Map.of("task", dto);
    }

    /**
     * Operator action — re-fetch the WoS Citation Report for this sync.
     * Flips the request's CitationReportTask back to PENDING so the
     * worker re-scrapes when it next polls. No-op for syncs without a
     * recorded citation-report task (returns 200 with {@code ok:false}).
     */
    @PostMapping("/{id}/retry/citation-report")
    public Map<String, Object> retryCitationReport(
            @PathVariable UUID id,
            @RequestAttribute(OperatorAuthFilter.OPERATOR_ID_ATTR) UUID operatorId) {
        service.get(id); // existence check
        java.util.List<CitationReportTask> tasks = citationReportRepository.findBySyncRequestId(id);
        if (tasks.isEmpty()) {
            return Map.of("ok", false,
                    "error", "Bu istek için kaydedilmiş Atıf Raporu görevi yok",
                    "reason", "no-task");
        }
        CitationReportTask t = tasks.get(0);
        TaskStatus s = t.getStatus();
        if (s == TaskStatus.PENDING || s == TaskStatus.PROCESSING) {
            return Map.of("ok", false, "reason", "already active", "status", s.name());
        }
        t.setStatus(TaskStatus.PENDING);
        t.setErrorMessage(null);
        t.setRetryCount(t.getRetryCount() + 1);
        t.touch();
        citationReportRepository.save(t);
        service.audit(id, operatorId, "OPERATOR", "RETRY_CITATION_REPORT",
                Map.of("taskId", t.getId(), "retryCount", t.getRetryCount()));
        return Map.of("ok", true, "taskId", t.getId(), "retryCount", t.getRetryCount());
    }

    @PostMapping("/{id}/retry/plumx")
    public Map<String, Object> retryPlumx(
            @PathVariable UUID id,
            @RequestAttribute(OperatorAuthFilter.OPERATOR_ID_ATTR) UUID operatorId) {
        SyncRequest req = service.get(id);
        java.util.List<String> dois = extractDois(req.getStagedData(), req.getEditedData());
        if (dois.isEmpty()) {
            return Map.of("ok", false, "error", "Staged yayınlarda DOI bulunamadı");
        }

        // Reuse the existing batch endpoint that the backend already uses for
        // background enrichment; force-mode PlumX takes the freshest result.
        // Stamp with syncRequestId so the bridge routes the citation
        // overlays back into THIS request's publications.
        com.academic.broker.api.dto.AddTasksResponse resp = articleTaskService.addPlumxTasks(dois, id);

        service.audit(id, operatorId, "OPERATOR", "RETRY_PLUMX",
                Map.of("doisQueued", resp.getAdded(), "totalDois", dois.size()));
        return Map.of("ok", true, "doisQueued", resp.getAdded(), "totalDois", dois.size());
    }

    // ── Per-publication re-enrichment ────────────────────────────────
    /**
     * Re-trigger PlumX for a single DOI on this SyncRequest. Used by the
     * operator-panel publication-row "Tekrar Çek" button when only one
     * paper's citation overlay needs a refresh — avoids the cost of
     * re-running the whole batch and leaves other publications untouched.
     *
     * <p>The PlumX task is force-recreated (any stale PENDING/PROCESSING
     * row for the same DOI gets wiped) and stamped with the syncRequestId
     * so the bridge folds the result into the matching publication entry.
     */
    @PostMapping("/{id}/retry-publication")
    public Map<String, Object> retryPublication(
            @PathVariable UUID id,
            @RequestBody Map<String, Object> body,
            @RequestAttribute(OperatorAuthFilter.OPERATOR_ID_ATTR) UUID operatorId) {
        Object doiObj = body.get("doi");
        String doi = doiObj instanceof String s ? s.trim().toLowerCase() : "";
        if (doi.isBlank()) {
            return Map.of("ok", false, "error", "doi zorunludur");
        }
        // Strip any "https://doi.org/" prefix the operator might paste in.
        if (doi.startsWith("https://doi.org/")) {
            doi = doi.substring("https://doi.org/".length());
        } else if (doi.startsWith("http://doi.org/")) {
            doi = doi.substring("http://doi.org/".length());
        }

        SyncRequest req = service.get(id); // throws if missing — guards against bad ids

        // Wipe any active PlumX task for this DOI so we get fresh data
        // (the operator wouldn't have hit "Tekrar Çek" if the existing
        // result was acceptable).
        articleTaskService.forcePlumxRefresh(doi, id);

        service.audit(id, operatorId, "OPERATOR", "RETRY_PUBLICATION",
                Map.of("doi", doi));
        return Map.of("ok", true, "doi", doi);
    }

    @SuppressWarnings("unchecked")
    private static java.util.List<String> extractDois(Map<String, Object> stagedData,
                                                      Map<String, Object> editedData) {
        java.util.LinkedHashSet<String> out = new java.util.LinkedHashSet<>();
        Object pubs = (stagedData == null ? null : stagedData.get("publications"));
        if (pubs instanceof List<?> list) {
            for (Object o : list) {
                if (o instanceof Map<?, ?> m) {
                    Object doi = ((Map<String, Object>) m).get("doi");
                    if (doi instanceof String s && !s.isBlank()) out.add(s.trim());
                }
            }
        }
        // Operator overrides may add or correct a DOI
        Object editedPubs = (editedData == null ? null : editedData.get("publications"));
        if (editedPubs instanceof Map<?, ?> editedMap) {
            for (Object v : ((Map<String, Object>) editedMap).values()) {
                if (v instanceof Map<?, ?> m) {
                    Object doi = ((Map<String, Object>) m).get("doi");
                    if (doi instanceof String s && !s.isBlank()) out.add(s.trim());
                }
            }
        }
        return new java.util.ArrayList<>(out);
    }

    // ── Per-source retry ──────────────────────────────────────────────
    /**
     * Re-trigger the worker for a single source on this SyncRequest. Used
     * when the original scrape returned partial / no data and the operator
     * wants a fresh attempt without rejecting the whole request.
     *
     * <p>Forces a new article-task (deletes any stale PENDING/PROCESSING
     * for the same externalId), stamps it with {@code syncRequestId}, and
     * relies on the worker bridge to fold the result into the request's
     * {@code stagedData} when complete.
     */
    @PostMapping("/{id}/retry/{source}")
    public Map<String, Object> retrySource(
            @PathVariable UUID id,
            @PathVariable String source,
            @RequestAttribute(OperatorAuthFilter.OPERATOR_ID_ATTR) UUID operatorId) {

        SyncRequest req = service.get(id);
        TargetSource ts;
        try {
            ts = TargetSource.valueOf(source.toUpperCase());
        } catch (IllegalArgumentException e) {
            return Map.of("ok", false, "error", "Invalid source: " + source);
        }

        // Resolve the externalId from the profile snapshot (broker stays
        // user-agnostic — it only knows what the backend told it).
        Map<String, Object> snap = req.getRequesterProfileSnapshot();
        String externalId = resolveExternalId(snap, ts);
        if (externalId == null || externalId.isBlank()) {
            return Map.of("ok", false, "error", "Bu kaynak için kayıtlı ID yok");
        }

        String redirectUrl = buildRedirectUrl(ts, externalId);
        // METRICS_ONLY: refresh just the source's author dashboard
        // (h-index / citations / publications). Publication-level data
        // is left alone — operator's per-row "Tekrar Çek" handles that
        // separately via PlumX so the merged publications list isn't
        // disturbed.
        articleTaskService.addTasks(ts, List.of(externalId), redirectUrl, /*force*/ true,
                TaskType.METRICS_ONLY, id);

        // Audit + emit progress so the UI shows the retry started
        Map<String, Object> progress = req.getSourceProgress() != null
                ? new java.util.HashMap<>(req.getSourceProgress()) : new java.util.HashMap<>();
        progress.put(source.toUpperCase(), "PENDING");
        service.updateSourceProgress(id, progress);
        service.audit(id, operatorId, "OPERATOR", "RETRY_SOURCE",
                Map.of("source", ts.name(), "externalId", externalId));

        return Map.of("ok", true, "source", ts.name(), "externalId", externalId);
    }

    private static String resolveExternalId(Map<String, Object> snap, TargetSource ts) {
        if (snap == null) return null;
        return switch (ts) {
            case WOS -> str(snap.get("publonsId"));
            case SCOPUS -> str(snap.get("scopusId"));
            case SCHOLAR -> str(snap.get("googleScholarId"));
            case OPENALEX -> {
                // OpenAlex's externalId is the researcher's ORCID. Strip
                // the URL prefix in case the snapshot stored the full
                // https://orcid.org/... form.
                String orcid = str(snap.get("orcid"));
                if (orcid == null) yield null;
                orcid = orcid.trim();
                if (orcid.startsWith("https://orcid.org/")) {
                    orcid = orcid.substring("https://orcid.org/".length());
                } else if (orcid.startsWith("http://orcid.org/")) {
                    orcid = orcid.substring("http://orcid.org/".length());
                }
                yield orcid.isBlank() ? null : orcid;
            }
            default -> null;
        };
    }

    private static String buildRedirectUrl(TargetSource ts, String externalId) {
        return switch (ts) {
            case WOS -> "https://www.webofscience.com/wos/author/record/" + externalId;
            case SCOPUS -> "https://www.scopus.com/authid/detail.uri?authorId=" + externalId;
            case SCHOLAR -> "https://scholar.google.com/citations?user=" + externalId + "&hl=tr";
            // OpenAlex isn't a browser-tab scrape — the worker hits the
            // public JSON API directly. The redirectUrl is decorative
            // (shown in the operator panel link), but matches the
            // worker's own URL construction so logs stay consistent.
            case OPENALEX -> "https://api.openalex.org/authors/orcid:" + externalId;
            default -> null;
        };
    }

    private static String str(Object o) {
        return o == null ? null : o.toString();
    }

    // ── Bulk ─────────────────────────────────────────────────────────

    @PostMapping("/bulk-approve")
    public Map<String, Object> bulkApprove(
            @RequestBody SyncRequestDtos.BulkActionReq req,
            @RequestAttribute(OperatorAuthFilter.OPERATOR_ID_ATTR) UUID operatorId) {
        List<SyncRequest> approved = service.bulkApprove(req.getIds(), operatorId, req.getNotes());
        approved.forEach(applyService::applyNow);
        return Map.of("approved", approved.size());
    }

    @PostMapping("/bulk-reject")
    public Map<String, Object> bulkReject(
            @RequestBody SyncRequestDtos.BulkActionReq req,
            @RequestAttribute(OperatorAuthFilter.OPERATOR_ID_ATTR) UUID operatorId) {
        List<SyncRequest> rejected = service.bulkReject(req.getIds(), operatorId, req.getReason());
        return Map.of("rejected", rejected.size());
    }
}

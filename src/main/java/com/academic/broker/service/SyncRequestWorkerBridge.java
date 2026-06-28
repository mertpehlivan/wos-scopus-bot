package com.academic.broker.service;

import com.academic.broker.domain.ArticleTask;
import com.academic.broker.domain.CitationReportTask;
import com.academic.broker.domain.PlumxTask;
import com.academic.broker.domain.SyncRequest;
import com.academic.broker.domain.SyncRequestStatus;
import com.academic.broker.domain.TaskStatus;
import com.academic.broker.repository.ArticleTaskRepository;
import com.academic.broker.repository.CitationReportTaskRepository;
import com.academic.broker.repository.PlumxTaskRepository;
import com.academic.broker.repository.SyncRequestRepository;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;

/**
 * Glues the worker (article-task) pipeline to {@link SyncRequest} staging.
 *
 * <p>Responsibilities:
 * <ul>
 *   <li>{@link #linkTasksToRequest} — once article tasks are created for a
 *       sync request, stamp the {@code syncRequestId} foreign key onto each
 *       so the task processor knows where to deposit results.</li>
 *   <li>{@link #ingestTaskCompletion} — called by the article-task complete
 *       handler. Pulls scraped data into the SyncRequest's stagedData and,
 *       once all sources finish, transitions the request to
 *       {@code READY_FOR_REVIEW}.</li>
 * </ul>
 */
@Slf4j
@Service
@RequiredArgsConstructor
public class SyncRequestWorkerBridge {

    private final SyncRequestRepository syncRepository;
    private final ArticleTaskRepository articleRepository;
    private final PlumxTaskRepository plumxRepository;
    private final CitationReportTaskRepository citationReportRepository;
    private final SyncRequestService syncService;

    /** Stamp existing article-tasks (or new ones) with this request id. */
    @Transactional
    public void linkTasksToRequest(UUID syncRequestId, List<Long> taskIds) {
        for (Long id : taskIds) {
            articleRepository.findById(id).ifPresent(t -> {
                t.setSyncRequestId(syncRequestId);
                articleRepository.save(t);
            });
        }
    }

    /**
     * Seeds {@code sourceProgress[source] = "PENDING"} on the sync request so
     * the operator panel can render a "Çekiliyor" chip while the worker is
     * still scraping. Without this seed, the panel sees an undefined entry,
     * falls back to {@code UNKNOWN} ("Bilinmiyor"), and the operator can't
     * tell the source is queued.
     *
     * <p>Idempotent — only writes the first time a source is seen for a
     * given request. Already-COMPLETED/FAILED entries are left alone so a
     * late "second task" creation can't regress the progress chip.
     */
    @Transactional
    public void markSourcePending(UUID syncRequestId, String source) {
        if (syncRequestId == null || source == null) return;
        SyncRequest req = syncRepository.findById(syncRequestId).orElse(null);
        if (req == null) return;

        Map<String, Object> progress = req.getSourceProgress() != null
                ? new HashMap<>(req.getSourceProgress()) : new HashMap<>();
        Object existing = progress.get(source);
        // Don't overwrite a terminal status — task creation can be re-fired
        // after a completion (e.g. operator hits "Tekrar Çek").
        if (existing != null) {
            String s = String.valueOf(existing).toUpperCase();
            if ("COMPLETED".equals(s) || "FAILED".equals(s) || "OK".equals(s) || "ERROR".equals(s)) {
                // Reset to PENDING since worker is going to re-scrape.
                progress.put(source, "PENDING");
            }
            // Otherwise (PENDING/PROCESSING) leave as-is.
        } else {
            progress.put(source, "PENDING");
        }
        req.setSourceProgress(progress);
        req.touch();
        syncRepository.save(req);
    }

    /**
     * Called from the worker pipeline whenever a task linked to a sync
     * request reaches a terminal state (COMPLETED / FAILED). Merges the
     * task's payload into the request's stagedData, updates per-source
     * progress, and — if every linked source for this request is now done
     * — flips the request to READY_FOR_REVIEW.
     */
    @Transactional
    public void ingestTaskCompletion(ArticleTask task) {
        UUID reqId = task.getSyncRequestId();
        if (reqId == null) {
            log.debug("[Bridge] Task {} has no syncRequestId — skipping", task.getId());
            return;
        }
        SyncRequest req = syncRepository.findById(reqId).orElse(null);
        if (req == null) {
            log.warn("[Bridge] Task {} references missing sync request {}", task.getId(), reqId);
            return;
        }
        // Defense in depth: a task can complete LONG after its sync
        // request reached a TERMINAL state — most often when an old
        // Scholar profile tab finishes scraping right as the operator
        // approves/rejects the request. Letting that completion mutate
        // a closed request silently corrupts what the operator already
        // signed off on.
        //
        // BUT: READY_FOR_REVIEW is NOT terminal. The operator may have
        // hit "Tekrar Çek" on a single source while the request waits
        // in their queue — re-scrape data MUST flow into the staged
        // blob, otherwise the retry button appears to do nothing.
        // So we only drop on truly terminal statuses.
        if (req.getStatus() == SyncRequestStatus.APPROVED
                || req.getStatus() == SyncRequestStatus.REJECTED
                || req.getStatus() == SyncRequestStatus.EXPIRED) {
            log.warn("[Bridge] Task {} ({}) completed AFTER sync {} reached {} — dropping payload",
                    task.getId(), task.getTargetSource(), reqId, req.getStatus());
            return;
        }

        String sourceKey = task.getTargetSource().name();
        Map<String, Object> staged = req.getStagedData() != null
                ? new HashMap<>(req.getStagedData()) : new HashMap<>();
        Map<String, Object> sourceBlob = new HashMap<>();

        // Author metrics canonicalization. The legacy WoS/Scopus/Scholar
        // content scripts emit {hIndex, sumOfTimesCited, publications,
        // i10Index, citingArticles}; OpenAlex emits {hIndex, citations,
        // documents, i10Index}. The operator panel reads only the latter
        // shape, so we map both into the canonical names here. Without
        // this, the panel shows "veri yok" for citations/documents on
        // every WoS/Scopus/Scholar source even though the worker did
        // actually scrape them.
        if (task.getAuthorMetricsData() != null) {
            sourceBlob.put("metrics", canonicalizeMetrics(task.getAuthorMetricsData()));
        }
        if (task.getRawData() != null) {
            // Same fix for the rawData.authorMetrics nested copy that some
            // worker code paths still produce.
            Map<String, Object> rd = task.getRawData();
            Object am = rd.get("authorMetrics");
            if (am instanceof Map<?, ?> mm) {
                @SuppressWarnings("unchecked")
                Map<String, Object> normalized = canonicalizeMetrics((Map<String, Object>) mm);
                Map<String, Object> rdCopy = new HashMap<>(rd);
                rdCopy.put("authorMetrics", normalized);
                sourceBlob.put("rawData", rdCopy);
                // If we hadn't gotten metrics via the dedicated endpoint
                // (some short-circuit paths only call /complete), fall back
                // to the rawData-embedded copy.
                if (!sourceBlob.containsKey("metrics")) {
                    sourceBlob.put("metrics", normalized);
                }
            } else {
                sourceBlob.put("rawData", rd);
            }
        }
        sourceBlob.put("scrapedAt", task.getUpdatedAt() != null
                ? task.getUpdatedAt().toString() : null);
        sourceBlob.put("provenance", "WORKER");
        staged.put(sourceKey, sourceBlob);

        // Rebuild the unified publications list every time a new source
        // lands. Order matters here:
        //
        //   OPENALEX (baseline)  →  WOS / SCOPUS / SCHOLAR (enrichment-only)
        //
        // Mirrors the historical SmartPublicationService design: OpenAlex is
        // the only source allowed to ADD publications. WoS/Scopus/Scholar
        // can only patch citations + index/quartile/IF onto entries that
        // already came from OpenAlex (matched by DOI then fuzzy title).
        // Otherwise an early WoS completion races OpenAlex and ends up
        // labelling the whole list as "Web of Science".
        rebuildPublications(staged);

        // Fan out PlumX over EVERY DOI in the unified publications list — not
        // just the ones OpenAlex returned. WoS detail-scrape produces DOIs
        // that OpenAlex didn't surface (and Scholar occasionally too); without
        // this loop those DOIs never get a Scopus citation count from PlumX.
        // Mirrors the user spec: "PlumX ve Google Scholar bakabilir WoS'un
        // eklediği yayına atıf bilgilerini ekleyebilirler".
        @SuppressWarnings("unchecked")
        List<Map<String, Object>> pubs = staged.get("publications") instanceof List<?> pl
                ? (List<Map<String, Object>>) pl : List.of();
        fanOutPlumxForNewDois(reqId, pubs);

        req.setStagedData(staged);

        Map<String, Object> progress = req.getSourceProgress() != null
                ? new HashMap<>(req.getSourceProgress()) : new HashMap<>();
        progress.put(sourceKey, task.getStatus().name());
        req.setSourceProgress(progress);

        boolean allDone = areAllLinkedTasksDone(reqId);
        if (allDone && req.getStatus() == SyncRequestStatus.PENDING_SCRAPE) {
            // hand off to service so it sets expiresAt + audits the transition
            syncService.markScrapeComplete(reqId, req.getStagedData(), progress);
            log.info("[Bridge] All tasks for sync {} done — moved to READY_FOR_REVIEW", reqId);
        } else {
            req.touch();
            syncRepository.save(req);
            log.debug("[Bridge] {} of req {}: progress updated", sourceKey, reqId);
        }
    }

    /**
     * Folds author-metrics (h-index, citations, documents, i10Index,
     * yearlyStats) into the staged blob as soon as they arrive via the
     * dedicated {@code /author-metrics} endpoint — instead of leaving them
     * stranded on the task row until a later {@code /complete} (which may
     * never come for METRICS_ONLY refreshes, or may land after the request
     * was gated READY_FOR_REVIEW by other sources).
     *
     * <p>Unlike {@link #ingestTaskCompletion} this MERGES into any existing
     * source blob, so a metrics update that arrives AFTER {@code /complete}
     * does not drop the publications rawData that the complete already stored
     * (a from-scratch rebuild would have wiped it). It never marks the request
     * ready on its own — the task stays PROCESSING here, so the readiness gate
     * only fires once the real terminal completion lands.
     */
    @Transactional
    public void ingestAuthorMetrics(ArticleTask task) {
        UUID reqId = task.getSyncRequestId();
        if (reqId == null || task.getAuthorMetricsData() == null) return;
        SyncRequest req = syncRepository.findById(reqId).orElse(null);
        if (req == null) return;
        // Same terminal-status guard as ingestTaskCompletion — never mutate a
        // request the operator already signed off on.
        if (req.getStatus() == SyncRequestStatus.APPROVED
                || req.getStatus() == SyncRequestStatus.REJECTED
                || req.getStatus() == SyncRequestStatus.EXPIRED) {
            return;
        }

        String sourceKey = task.getTargetSource().name();
        Map<String, Object> staged = req.getStagedData() != null
                ? new HashMap<>(req.getStagedData()) : new HashMap<>();
        // Merge into the existing blob (preserve rawData/publications a prior
        // /complete stored) rather than replacing it.
        Map<String, Object> sourceBlob;
        Object existing = staged.get(sourceKey);
        if (existing instanceof Map<?, ?> em) {
            @SuppressWarnings("unchecked")
            Map<String, Object> casted = (Map<String, Object>) em;
            sourceBlob = new HashMap<>(casted);
        } else {
            sourceBlob = new HashMap<>();
        }
        sourceBlob.put("metrics", canonicalizeMetrics(task.getAuthorMetricsData()));
        sourceBlob.put("scrapedAt", task.getUpdatedAt() != null ? task.getUpdatedAt().toString() : null);
        sourceBlob.put("provenance", "WORKER");
        staged.put(sourceKey, sourceBlob);

        rebuildPublications(staged);
        req.setStagedData(staged);
        req.touch();
        syncRepository.save(req);
        log.debug("[Bridge] author-metrics staged for {} of req {} (publications preserved)", sourceKey, reqId);
    }

    /**
     * True when every task linked to this sync request — ArticleTasks
     * (WOS/SCOPUS/SCHOLAR/OPENALEX), PlumX per-DOI tasks, and the WoS
     * Citation Report (if one was queued) — has reached a terminal
     * status. PlumX is part of the readiness gate because the operator
     * panel shows Scopus citation counts pulled via PlumX, and surfacing
     * the request before those land would mean half the citation column
     * is blank on first review. The Citation Report is included for the
     * same reason: showing a "ready" request before the per-year citation
     * histogram lands would force the operator to refresh.
     */
    private boolean areAllLinkedTasksDone(UUID syncRequestId) {
        List<ArticleTask> linked = articleRepository.findBySyncRequestId(syncRequestId);
        if (linked.isEmpty()) return false;
        for (ArticleTask t : linked) {
            TaskStatus s = t.getStatus();
            if (s == TaskStatus.PENDING || s == TaskStatus.PROCESSING) return false;
        }
        // PlumX runs as a separate pool with its own table; include only
        // those plumx_tasks that were stamped with this syncRequestId.
        List<PlumxTask> plumx = plumxRepository.findBySyncRequestId(syncRequestId);
        for (PlumxTask t : plumx) {
            TaskStatus s = t.getStatus();
            if (s == TaskStatus.PENDING || s == TaskStatus.PROCESSING) return false;
        }
        // Citation Report is opportunistic — only created if the WoS
        // author scrape actually exposed a citation-report link. So a
        // sync request without a CitationReportTask is fine; we only
        // gate when one exists and isn't terminal yet.
        List<CitationReportTask> crs = citationReportRepository.findBySyncRequestId(syncRequestId);
        for (CitationReportTask t : crs) {
            TaskStatus s = t.getStatus();
            if (s == TaskStatus.PENDING || s == TaskStatus.PROCESSING) return false;
        }
        return true;
    }

    /**
     * Folds a completed PlumX lookup into its sync request's stagedData by
     * DOI. PlumX returns per-DOI citation counts from Scopus / Mendeley /
     * CrossRef; we route them into {@code citations.{scopus,mendeley,
     * crossref}} on the publication entry that was seeded by OpenAlex.
     *
     * <p><b>Enrichment-only:</b> if no publication has this DOI yet, the
     * citation is dropped. PlumX is a per-DOI overlay, not a source of
     * publications — letting it create entries would re-introduce the
     * "WoS-as-baseline" problem we just fixed in {@link #rebuildPublications}.
     * In practice this never happens because the worker fires PlumX
     * batches AFTER OpenAlex's complete handler returns, so the baseline
     * is already in stagedData when PlumX results land.
     */
    @Transactional
    public void ingestPlumxCompletion(PlumxTask task) {
        UUID reqId = task.getSyncRequestId();
        if (reqId == null) return;
        SyncRequest req = syncRepository.findById(reqId).orElse(null);
        if (req == null) return;
        // Same defensive drop as ingestTaskCompletion — PlumX batches can
        // straggle in for ~minutes after the rest of the request closed.
        // READY_FOR_REVIEW is OK (operator may have hit Tekrar Çek on
        // PlumX); only true terminal states drop.
        if (req.getStatus() == SyncRequestStatus.APPROVED
                || req.getStatus() == SyncRequestStatus.REJECTED
                || req.getStatus() == SyncRequestStatus.EXPIRED) {
            log.warn("[Bridge] PlumX task {} (doi={}) completed AFTER sync {} reached {} — dropping",
                    task.getId(), task.getDoi(), reqId, req.getStatus());
            return;
        }

        Map<String, Object> raw = task.getRawData() != null ? task.getRawData() : Map.of();
        String doi = task.getDoi();
        if (doi == null || doi.isBlank()) return;
        String doiKey = doi.trim().toLowerCase();

        Integer scopus = asInt(raw.get("scopusCitations"));
        Integer mendeley = asInt(raw.get("mendeleyCitations"));
        Integer crossref = asInt(raw.get("crossrefCitations"));

        Map<String, Object> staged = req.getStagedData() != null
                ? new HashMap<>(req.getStagedData()) : new HashMap<>();

        @SuppressWarnings("unchecked")
        List<Map<String, Object>> pubs = staged.get("publications") instanceof List<?> existingObj
                ? new java.util.ArrayList<>((List<Map<String, Object>>) existingObj)
                : new java.util.ArrayList<>();

        // Apply to EVERY row sharing this DOI, not just the first. WoS-added
        // baseline rows can duplicate an OpenAlex row by DOI; matching only
        // the first left the duplicate with blank PlumX citations. Candidate
        // DOI is trimmed before compare so surrounding whitespace can't miss.
        int matched = 0;
        for (Map<String, Object> p : pubs) {
            String pdoi = stringField(p, "doi");
            if (pdoi != null && doiKey.equals(pdoi.trim().toLowerCase())) {
                if (scopus != null) putCitation(p, "scopus", scopus);
                if (mendeley != null) putCitation(p, "mendeley", mendeley);
                if (crossref != null) putCitation(p, "crossref", crossref);
                addSource(p, "PLUMX");
                matched++;
            }
        }

        // Enrichment-only — if no OpenAlex entry has this DOI, the PlumX
        // result has nothing to attach to and is dropped. The worker should
        // never get into this state because it queues PlumX AFTER OpenAlex
        // produces the publications list, but be defensive.
        if (matched > 0) {
            staged.put("publications", pubs);
        } else {
            log.debug("[Bridge] PlumX completion for req {} doi={} — no matching baseline pub, dropped",
                    reqId, doi);
        }

        Map<String, Object> progress = req.getSourceProgress() != null
                ? new HashMap<>(req.getSourceProgress()) : new HashMap<>();
        progress.put("PLUMX", task.getStatus().name());
        req.setSourceProgress(progress);
        req.setStagedData(staged);

        boolean allDone = areAllLinkedTasksDone(reqId);
        if (allDone && req.getStatus() == SyncRequestStatus.PENDING_SCRAPE) {
            syncService.markScrapeComplete(reqId, req.getStagedData(), progress);
            log.info("[Bridge] PlumX completion closed sync {} — moved to READY_FOR_REVIEW", reqId);
        } else {
            req.touch();
            syncRepository.save(req);
            log.debug("[Bridge] PlumX of req {}: doi={} scopus={} merged", reqId, doi, scopus);
        }
    }

    private static Integer asInt(Object v) {
        if (v == null) return null;
        if (v instanceof Number n) return n.intValue();
        try { return Integer.parseInt(String.valueOf(v).trim()); }
        catch (NumberFormatException e) { return null; }
    }

    /**
     * Records a citation-report link discovered by the Chrome extension.
     * The extension knows its originating task by numeric
     * {@link ArticleTask#getId()} (the same id it received in
     * {@code /api/tasks/next}). We resolve the {@code syncRequestId}
     * from the article task and create a pending
     * {@link CitationReportTask} so the URL survives a service-worker
     * restart and the operator panel can show pipeline progress.
     *
     * <p>Idempotent: re-announces for the same sync update the URL/auth
     * id and re-arm a previously FAILED row instead of creating a
     * duplicate.
     *
     * @return persisted CitationReportTask id, or null on bad input /
     *         missing article task / unlinked task
     */
    @Transactional
    public Long announceCitationReportLink(Long articleTaskId,
                                           String citationReportUrl,
                                           String authorWosId) {
        if (articleTaskId == null || citationReportUrl == null || citationReportUrl.isBlank()) {
            return null;
        }
        ArticleTask article = articleRepository.findById(articleTaskId).orElse(null);
        if (article == null) {
            log.warn("[Bridge] announceCitationReportLink: ArticleTask {} not found", articleTaskId);
            return null;
        }
        UUID syncReqId = article.getSyncRequestId();
        if (syncReqId == null) {
            log.warn("[Bridge] announceCitationReportLink: ArticleTask {} has no syncRequestId — dropping",
                    articleTaskId);
            return null;
        }
        // Idempotent: there's at most one WoS author scrape per sync in the
        // current pipeline, so a re-announce should refresh the existing
        // task rather than create a duplicate. If a previous attempt
        // FAILED, the announce re-arms it back to PENDING.
        List<CitationReportTask> existing = citationReportRepository.findBySyncRequestId(syncReqId);
        if (!existing.isEmpty()) {
            CitationReportTask et = existing.get(0);
            et.setCitationReportUrl(citationReportUrl);
            if (authorWosId != null && !authorWosId.isBlank()) et.setAuthorWosId(authorWosId);
            if (et.getStatus() == TaskStatus.FAILED) {
                et.setStatus(TaskStatus.PENDING);
                et.setErrorMessage(null);
            }
            et.touch();
            citationReportRepository.save(et);
            log.info("[Bridge] Citation report URL refreshed for sync {} task #{}", syncReqId, et.getId());
            return et.getId();
        }
        CitationReportTask t = CitationReportTask.builder()
                .syncRequestId(syncReqId)
                .citationReportUrl(citationReportUrl)
                .authorWosId(authorWosId)
                .status(TaskStatus.PENDING)
                .retryCount(0)
                .build();
        CitationReportTask saved = citationReportRepository.save(t);
        log.info("[Bridge] Created CitationReportTask {} for sync {} (article task {})",
                saved.getId(), syncReqId, articleTaskId);
        return saved.getId();
    }

    /**
     * Folds a completed citation-report scrape into the sync request's
     * stagedData. Mirrors {@link #ingestPlumxCompletion} in shape: writes
     * the raw blob under {@code stagedData.WOS.citationReport} so the
     * operator panel can render it, and overlays per-publication
     * citation counts onto the rebuilt publications list.
     *
     * <p>The main backend's {@link com.rdlsis.service.ApplySyncService}
     * is expected to read the same JSON shape on apply.
     */
    @Transactional
    public void ingestCitationReportCompletion(CitationReportTask task) {
        UUID reqId = task.getSyncRequestId();
        if (reqId == null) return;
        SyncRequest req = syncRepository.findById(reqId).orElse(null);
        if (req == null) return;
        if (req.getStatus() == SyncRequestStatus.APPROVED
                || req.getStatus() == SyncRequestStatus.REJECTED
                || req.getStatus() == SyncRequestStatus.EXPIRED) {
            log.warn("[Bridge] CitationReportTask {} completed AFTER sync {} reached {} — dropping",
                    task.getId(), reqId, req.getStatus());
            return;
        }

        Map<String, Object> staged = req.getStagedData() != null
                ? new HashMap<>(req.getStagedData()) : new HashMap<>();

        // Stash the whole payload under stagedData.WOS.citationReport. If
        // a WOS source blob exists already, augment it; otherwise create a
        // shell so the apply service has a place to read from.
        @SuppressWarnings("unchecked")
        Map<String, Object> wos = staged.get("WOS") instanceof Map<?, ?> wm
                ? new HashMap<>((Map<String, Object>) wm) : new HashMap<>();
        Map<String, Object> crBlob = new HashMap<>();
        crBlob.put("status", task.getStatus().name());
        crBlob.put("scrapedAt", task.getUpdatedAt() != null ? task.getUpdatedAt().toString() : null);
        crBlob.put("retryCount", task.getRetryCount());
        crBlob.put("citationReportUrl", task.getCitationReportUrl());
        if (task.getAuthorWosId() != null) crBlob.put("authorWosId", task.getAuthorWosId());
        if (task.getErrorMessage() != null) crBlob.put("errorMessage", task.getErrorMessage());
        if (task.getRawData() != null) crBlob.put("data", task.getRawData());
        wos.put("citationReport", crBlob);
        staged.put("WOS", wos);

        // Per-publication citation overrides — apply to the unified
        // publications list if the scrape produced per-pub entries with
        // wosId+totalCitations. Match by wosId first, fall back to title.
        if (task.getRawData() != null) {
            Object pubsObj = task.getRawData().get("publications");
            if (pubsObj instanceof List<?> crList) {
                @SuppressWarnings("unchecked")
                List<Map<String, Object>> stagedPubs = staged.get("publications") instanceof List<?> existing
                        ? new java.util.ArrayList<>((List<Map<String, Object>>) existing)
                        : new java.util.ArrayList<>();
                int matched = 0;
                for (Object o : crList) {
                    if (!(o instanceof Map<?, ?> crm)) continue;
                    @SuppressWarnings("unchecked")
                    Map<String, Object> crp = (Map<String, Object>) crm;
                    Integer total = asInt(crp.get("totalCitations"));
                    if (total == null) continue;
                    String wosIdRaw = crp.get("wosId") != null ? crp.get("wosId").toString().trim() : null;
                    String wosIdNorm = wosIdRaw == null ? null
                            : (wosIdRaw.startsWith("WOS:") ? wosIdRaw.substring(4) : wosIdRaw);
                    String title = crp.get("title") != null ? crp.get("title").toString().trim() : null;
                    Map<String, Object> match = null;
                    if (wosIdNorm != null && !wosIdNorm.isBlank()) {
                        for (Map<String, Object> p : stagedPubs) {
                            String pwos = stringField(p, "wosId");
                            if (pwos == null) continue;
                            String pwosNorm = pwos.startsWith("WOS:") ? pwos.substring(4) : pwos;
                            if (pwosNorm.equalsIgnoreCase(wosIdNorm)) { match = p; break; }
                        }
                    }
                    if (match == null && title != null && !title.isBlank()) {
                        for (Map<String, Object> p : stagedPubs) {
                            String pt = stringField(p, "title");
                            if (pt != null && pt.trim().equalsIgnoreCase(title)) { match = p; break; }
                        }
                    }
                    if (match != null) {
                        putCitation(match, "wos", total);
                        matched++;
                    }
                }
                if (!stagedPubs.isEmpty()) staged.put("publications", stagedPubs);
                log.info("[Bridge] Citation report task {}: matched {} of {} publications to staged list",
                        task.getId(), matched, crList.size());
            }
        }

        Map<String, Object> progress = req.getSourceProgress() != null
                ? new HashMap<>(req.getSourceProgress()) : new HashMap<>();
        progress.put("CITATION_REPORT", task.getStatus().name());
        req.setSourceProgress(progress);
        req.setStagedData(staged);

        boolean allDone = areAllLinkedTasksDone(reqId);
        if (allDone && req.getStatus() == SyncRequestStatus.PENDING_SCRAPE) {
            syncService.markScrapeComplete(reqId, req.getStagedData(), progress);
            log.info("[Bridge] Citation report closed sync {} — moved to READY_FOR_REVIEW", reqId);
        } else {
            req.touch();
            syncRepository.save(req);
            log.debug("[Bridge] Citation report of req {}: status={}", reqId, task.getStatus());
        }
    }

    /**
     * Walks the rebuilt publications list and queues a PlumX lookup for every
     * DOI we don't already have an active task for. Called after every
     * {@link #rebuildPublications} pass, so a DOI that first appears via
     * WoS-detail scrape (i.e. not in OpenAlex's response) still gets the
     * Scopus / Mendeley / CrossRef overlay.
     *
     * <p>De-dupes against:
     * <ul>
     *   <li>existing PlumX rows for THIS sync request (any status)</li>
     *   <li>any PENDING / PROCESSING PlumX row globally — prevents two
     *       overlapping sync requests from double-queuing the same DOI.</li>
     * </ul>
     * The bridge writes directly to {@code plumxRepository} rather than
     * routing through {@code ArticleTaskService.addPlumxTasks(...)} to keep
     * Spring's bean wiring acyclic — we already inject the repo for read
     * paths, so this is just one more save() call from inside the same
     * transaction.
     */
    private void fanOutPlumxForNewDois(UUID reqId, List<Map<String, Object>> publications) {
        if (publications == null || publications.isEmpty()) return;

        // Collect DOIs from the unified pub list.
        java.util.LinkedHashSet<String> wantedDois = new java.util.LinkedHashSet<>();
        for (Map<String, Object> p : publications) {
            String doi = stringField(p, "doi");
            if (doi != null) wantedDois.add(doi.trim().toLowerCase());
        }
        if (wantedDois.isEmpty()) return;

        // What's already in the queue for THIS sync — covers PENDING /
        // PROCESSING / COMPLETED / FAILED so we don't re-queue something
        // that already failed (the operator can hit "Tekrar Çek" if they
        // want to reset that).
        java.util.Set<String> alreadyQueued = new java.util.HashSet<>();
        for (PlumxTask t : plumxRepository.findBySyncRequestId(reqId)) {
            if (t.getDoi() != null) alreadyQueued.add(t.getDoi().trim().toLowerCase());
        }

        List<TaskStatus> active = List.of(TaskStatus.PENDING, TaskStatus.PROCESSING);
        int queued = 0;
        for (String doi : wantedDois) {
            if (alreadyQueued.contains(doi)) continue;
            // Cross-sync defense: another sync may already have an in-flight
            // PlumX task for this DOI. Stamp our reqId onto it so this
            // request also receives the result when it lands.
            java.util.Optional<PlumxTask> globalActive =
                    plumxRepository.findFirstByDoiAndStatusIn(doi, active);
            if (globalActive.isPresent()) {
                PlumxTask t = globalActive.get();
                if (t.getSyncRequestId() == null) {
                    t.setSyncRequestId(reqId);
                    plumxRepository.save(t);
                }
                continue;
            }
            PlumxTask fresh = PlumxTask.builder()
                    .doi(doi)
                    .status(TaskStatus.PENDING)
                    .syncRequestId(reqId)
                    .updatedAt(java.time.Instant.now())
                    .build();
            plumxRepository.save(fresh);
            queued++;
        }
        if (queued > 0) {
            log.info("[Bridge] Fan-out PlumX: queued {} new DOI(s) for sync {}", queued, reqId);
            // Make sure the operator panel shows "PLUMX: Çekiliyor".
            markSourcePending(reqId, "PLUMX");
        }
    }

    // ═══════════════════════════════════════════════════════════════════════
    //  PUBLICATION-TYPE → SYSTEM CATEGORY MAPPING
    // ═══════════════════════════════════════════════════════════════════════
    //
    // Each source emits a different shape:
    //   • OpenAlex: lowercase hyphenated ("article", "book-chapter",
    //     "proceedings-article", "preprint", "dissertation", ...).
    //   • WoS detail: raw doc-type strings ("Article", "Editorial Material",
    //     "Review", "Proceedings Paper", ...). Some payloads carry a
    //     pre-mapped slug ("article", "review", "book_chapter", ...) from
    //     the chrome extension's mapWosDocType.
    //   • Scopus: same free-form doc-type strings as WoS.
    //   • Scholar: no per-publication type at all → fallback to
    //     pub_article.
    //
    // The operator panel renders one of:
    //   pub_article, pub_book, pub_book_chapter, pub_conference_paper,
    //   pub_thesis, pub_report, pub_editorial_material, pub_letter,
    //   pub_preprint, pub_dataset, pub_research_project, pub_review,
    //   pub_corrigendum, pub_section_in_encyclopedia,
    //   pub_retracted_article, pub_bulletin, ...
    //
    // {@link #mapToCategory} accepts any of the upstream variants and
    // returns the pub_* slug. Final safety net: pub_article.

    private static final Map<String, String> CATEGORY_MAP;
    static {
        Map<String, String> m = new java.util.HashMap<>();
        // ─── OpenAlex API types ─────────────────────────────────────
        m.put("article", "pub_article");
        m.put("review", "pub_article");
        m.put("book", "pub_book");
        m.put("book-chapter", "pub_book_chapter");
        m.put("proceedings-article", "pub_conference_paper");
        m.put("preprint", "pub_preprint");
        m.put("dataset", "pub_dataset");
        m.put("editorial", "pub_editorial_material");
        m.put("letter", "pub_letter");
        m.put("report", "pub_report");
        m.put("standard", "pub_report");
        m.put("dissertation", "pub_thesis");
        m.put("erratum", "pub_corrigendum");
        m.put("paratext", "pub_article");
        m.put("peer-review", "pub_article");
        m.put("other", "pub_article");
        m.put("reference-entry", "pub_section_in_encyclopedia");
        // ─── WoS / Scopus free-form doc-types (lowercase + trimmed) ──
        m.put("review article", "pub_article");
        m.put("proceedings paper", "pub_conference_paper");
        m.put("conference paper", "pub_conference_paper");
        m.put("conference review", "pub_conference_paper");
        m.put("book chapter", "pub_book_chapter");
        m.put("data paper", "pub_dataset");
        m.put("editorial material", "pub_editorial_material");
        m.put("meeting abstract", "pub_conference_paper");
        m.put("news item", "pub_article");
        m.put("discussion", "pub_article");
        m.put("correction", "pub_corrigendum");
        m.put("retraction", "pub_retracted_article");
        m.put("retracted publication", "pub_retracted_article");
        m.put("retracted", "pub_retracted_article");
        m.put("retracted article", "pub_retracted_article");
        m.put("expression of concern", "pub_corrigendum");
        m.put("reprint", "pub_article");
        m.put("note", "pub_article");
        m.put("short survey", "pub_article");
        m.put("biographical-item", "pub_article");
        m.put("biographical item", "pub_article");
        m.put("bibliography", "pub_article");
        m.put("book review", "pub_book");
        m.put("art exhibit review", "pub_article");
        m.put("film review", "pub_article");
        m.put("software review", "pub_article");
        m.put("hardware review", "pub_article");
        m.put("theater review", "pub_article");
        m.put("script", "pub_article");
        m.put("poetry", "pub_article");
        m.put("fiction", "pub_article");
        m.put("excerpt", "pub_article");
        m.put("chronology", "pub_article");
        m.put("music score", "pub_article");
        m.put("music score review", "pub_article");
        m.put("music performance review", "pub_article");
        m.put("dance performance review", "pub_article");
        // ─── Internal slugs from chrome-extension/article_detail.js ──
        m.put("book_chapter", "pub_book_chapter");
        m.put("proceedings_paper", "pub_conference_paper");
        m.put("data_paper", "pub_dataset");
        m.put("editorial_material", "pub_editorial_material");
        m.put("news_item", "pub_article");
        m.put("biographical_item", "pub_article");
        m.put("book_review", "pub_book");
        m.put("art_exhibit_review", "pub_article");
        m.put("film_review", "pub_article");
        m.put("software_review", "pub_article");
        m.put("hardware_review", "pub_article");
        m.put("theater_review", "pub_article");
        m.put("music_score", "pub_article");
        m.put("music_score_review", "pub_article");
        m.put("music_performance_review", "pub_article");
        m.put("dance_performance_review", "pub_article");
        m.put("expression_of_concern", "pub_corrigendum");
        m.put("meeting_abstract", "pub_conference_paper");
        // ─── Already-canonical pub_* slugs ───────────────────────────
        for (String pub : List.of(
                "pub_article", "pub_book", "pub_book_chapter", "pub_bulletin",
                "pub_expertise_report", "pub_expert_report", "pub_preprint",
                "pub_report", "pub_retracted_article", "pub_thesis",
                "pub_intellectual_property", "pub_dataset", "pub_research_project",
                "pub_company_test_report", "pub_corrigendum", "pub_editorial_material",
                "pub_encyclopedia", "pub_letter", "pub_conference_paper",
                "pub_poster", "pub_teaching_document", "pub_section_in_encyclopedia",
                "pub_translator")) {
            m.put(pub, pub);
        }
        CATEGORY_MAP = java.util.Map.copyOf(m);
    }

    /**
     * Maps a publication-type string from any source (OpenAlex API, WoS
     * doc-type, Scopus doc-type, the extension's pre-mapped slug, or an
     * already-canonical {@code pub_*} value) to a system publication
     * category. Falls back to {@code pub_article} when nothing matches —
     * which is the historical default behaviour and the only category
     * guaranteed to exist in every form-definition seeder.
     *
     * <p>Match strategy (in order):
     * <ol>
     *   <li>Exact lowercase trim hit on {@link #CATEGORY_MAP}.</li>
     *   <li>"Contains" pass: walk known keys longest-first, return the
     *       first key that appears as a substring (handles "Review
     *       Article", "Proceedings Paper, Article", etc.)</li>
     *   <li>{@code pub_article} fallback.</li>
     * </ol>
     */
    static String mapToCategory(String raw) {
        if (raw == null) return "pub_article";
        String norm = raw.toLowerCase().trim();
        if (norm.isEmpty()) return "pub_article";
        String hit = CATEGORY_MAP.get(norm);
        if (hit != null) return hit;
        // Contains pass — sort keys by length desc so "book chapter" wins
        // over "book". Cheap; CATEGORY_MAP is small and rarely re-walked.
        java.util.List<String> keys = new java.util.ArrayList<>(CATEGORY_MAP.keySet());
        keys.sort((a, b) -> Integer.compare(b.length(), a.length()));
        for (String k : keys) {
            // Skip fallback alias collisions ("article" matches every string).
            if (k.length() < 4) continue;
            if (norm.contains(k)) return CATEGORY_MAP.get(k);
        }
        return "pub_article";
    }

    /**
     * Pulls the type signal from a normalized publication entry — checks the
     * many synonyms different sources put it under — and returns the mapped
     * pub_* category. Order matters: an explicit operator-set or
     * already-mapped category wins over any source's raw type.
     */
    private static String resolveCategory(Map<String, Object> p) {
        // 1) Already-mapped category from a previous rebuild pass.
        Object existing = p.get("category");
        if (existing instanceof String s && s.startsWith("pub_")) return s;
        // 2) WoS detail script emits mappedPublicationType (system slug).
        Object mapped = p.get("mappedPublicationType");
        if (mapped instanceof String ms && !ms.isBlank()) return mapToCategory(ms);
        // 3) WoS detail's documentTypes[] (free-form, take first).
        Object docTypes = p.get("documentTypes");
        if (docTypes instanceof List<?> dl && !dl.isEmpty()) {
            Object first = dl.get(0);
            if (first != null) return mapToCategory(String.valueOf(first));
        }
        // 4) OpenAlex worker emits originalType ("article", "book-chapter").
        Object origType = p.get("originalType");
        if (origType instanceof String os && !os.isBlank()) return mapToCategory(os);
        // 5) Generic fallbacks worker scripts may have used.
        for (String k : List.of("documentType", "type", "publicationType", "articleType")) {
            Object v = p.get(k);
            if (v instanceof String vs && !vs.isBlank()) return mapToCategory(vs);
        }
        return "pub_article";
    }

    /**
     * Canonicalizes author-metrics field names so the operator panel always
     * reads the same shape regardless of which source produced the data.
     * <ul>
     *   <li>{@code sumOfTimesCited} → {@code citations}</li>
     *   <li>{@code publications} → {@code documents}</li>
     *   <li>{@code citingArticles} → {@code citingArticles} (passthrough)</li>
     *   <li>{@code i10Index} → {@code i10Index} (passthrough)</li>
     *   <li>{@code hIndex} → {@code hIndex} (passthrough)</li>
     * </ul>
     * Aliases the legacy field but ALSO keeps the original key, so any
     * existing consumer that still reads e.g. {@code sumOfTimesCited} keeps
     * working. Returns a NEW map — never mutates the JSONB blob in place.
     *
     * <p><b>CONTRACT (broker ⇄ backend):</b> this map is stored at
     * {@code stagedData.<SOURCE>.metrics} and read back verbatim by the main
     * backend's {@code ApplySyncService.applyMetricsBlock} via
     * {@code block.get("metrics")}. Passthrough fields {@code yearlyStats}
     * (the per-year {year,publications,citations} histogram) and
     * {@code i10Index} have no canonical alias and are persisted ONLY by the
     * backend reading this exact nested path — so do NOT rename the
     * {@code "metrics"} key or those field names on either side without
     * updating both. There is no test guarding this coupling.
     */
    private static Map<String, Object> canonicalizeMetrics(Map<String, Object> raw) {
        Map<String, Object> out = new HashMap<>(raw);
        // citations: prefer existing canonical key, then sumOfTimesCited
        if (!out.containsKey("citations") || out.get("citations") == null) {
            Object v = out.get("sumOfTimesCited");
            if (v != null) out.put("citations", v);
        }
        // documents: prefer existing canonical key, then publications
        if (!out.containsKey("documents") || out.get("documents") == null) {
            Object v = out.get("publications");
            if (v != null) out.put("documents", v);
        }
        return out;
    }

    /**
     * Rebuilds {@code staged.publications} from scratch using the current
     * per-source raw payloads stored under {@code staged.OPENALEX},
     * {@code staged.WOS}, {@code staged.SCOPUS}, {@code staged.SCHOLAR}.
     * <p>
     * Algorithm:
     * <ol>
     *   <li>Seed the list from <b>OPENALEX</b>'s {@code rawData.publications}
     *       — OpenAlex is the publication baseline (DOI / title / authors /
     *       year / journal already filled in).
     *   <li>For each of <b>WOS / SCOPUS / SCHOLAR</b>, walk their
     *       {@code rawData.articles} list and try to match every incoming
     *       row against the running list — first by DOI, then by exact
     *       title, then by fuzzy title (Levenshtein + prefix). On match,
     *       copy the source's citation count into {@code citations.<source>}
     *       and backfill any missing metadata. <b>If no match is found,
     *       add the row as a new baseline entry</b> (with its own
     *       {@code sources} list and a category mapped via
     *       {@link #mapToCategory}). This recovers e.g. WoS-indexed
     *       conference papers OpenAlex didn't surface.
     *   <li>PlumX overlay is handled separately by
     *       {@link #ingestPlumxCompletion}, which reaches in by DOI.
     * </ol>
     * Order is deterministic and idempotent — calling rebuild after every
     * source completion converges to the same final list regardless of
     * arrival order, because we always start from the per-source raw blobs.
     */
    @SuppressWarnings("unchecked")
    private void rebuildPublications(Map<String, Object> staged) {
        // 1) Seed from OpenAlex
        java.util.LinkedHashMap<String, Map<String, Object>> byDoi = new java.util.LinkedHashMap<>();
        java.util.LinkedHashMap<String, Map<String, Object>> byTitle = new java.util.LinkedHashMap<>();
        List<Map<String, Object>> baseline = new java.util.ArrayList<>();

        List<Map<String, Object>> oaList = readSourceArticles(staged, "OPENALEX");
        for (Map<String, Object> raw : oaList) {
            Map<String, Object> p = normalizePublication(raw, "OPENALEX");
            if (p.get("title") == null && p.get("doi") == null) continue;
            baseline.add(p);
            indexEntry(p, byDoi, byTitle);
        }

        // 2) Enrich with WoS / Scopus / Scholar.
        //
        //    Add-vs-enrich policy per source:
        //      • WOS    — matched: enrich; unmatched: ADD as new baseline.
        //                 (User spec: "WoS'ta olup OpenAlex'te olmayanları
        //                  da eklesin").
        //      • SCOPUS — matched: enrich; unmatched: ADD. (Currently the
        //                 backend pulls METRICS_ONLY tasks, so the
        //                 Scopus articles array is empty — but if a future
        //                 task type populates it, we treat Scopus the
        //                 same as WoS.)
        //      • SCHOLAR — matched: enrich (citations.scholar + abstract
        //                 backfill if blank); unmatched: DROP. Scholar
        //                 has no per-paper canonical metadata (no
        //                 reliable DOI for many entries, no journal,
        //                 truncated titles), so an unmatched Scholar
        //                 row is information-only — letting it create
        //                 a publication would seed garbage. User spec:
        //                 "scholarin doğrudan yayın ekleme yetkisi yok,
        //                  sadece atıf ekleyebilir; var olan bir
        //                  yayına abstract boş ise onu doldurabilir".
        int oaSeed = baseline.size();
        for (String src : List.of("WOS", "SCOPUS", "SCHOLAR")) {
            boolean canCreatePublications = !"SCHOLAR".equals(src);
            List<Map<String, Object>> incoming = readSourceArticles(staged, src);
            if (incoming.isEmpty()) continue;
            int matched = 0, added = 0, dropped = 0, skipped = 0;
            for (Map<String, Object> raw : incoming) {
                Map<String, Object> norm = normalizePublication(raw, src);
                if (norm.get("title") == null && norm.get("doi") == null) {
                    skipped++;
                    continue;
                }
                Map<String, Object> match = findMatch(norm, byDoi, byTitle, baseline);
                if (match != null) {
                    // Enrichment for any source: citations + WoS-specialty
                    // fields + abstract backfill (when target is blank).
                    enrichInto(match, norm, src);
                    matched++;
                } else if (canCreatePublications) {
                    // No OpenAlex/WoS twin — keep this row as its own
                    // baseline entry. The category was already resolved by
                    // normalizePublication via mapToCategory (pub_article
                    // fallback).
                    baseline.add(norm);
                    indexEntry(norm, byDoi, byTitle);
                    added++;
                } else {
                    // Scholar-only with no match — drop. Citation count
                    // and abstract on an unmatched Scholar row would
                    // have nowhere to attach.
                    dropped++;
                }
            }
            log.info("[Rebuild] {} -> {} incoming: {} matched (enriched), {} added (no twin), {} dropped (Scholar-only or no-add policy), {} skipped (no key)",
                    src, incoming.size(), matched, added, dropped, skipped);
        }
        log.info("[Rebuild] Final list: {} entries (OpenAlex baseline: {}, total after enrichment+adds: {})",
                baseline.size(), oaSeed, baseline.size());

        // 3) Re-apply PlumX citations from any prior completions kept on
        //    the existing publications list (so a rebuild triggered by a
        //    later WoS completion doesn't wipe out citations.scopus).
        Object prevPubs = staged.get("publications");
        if (prevPubs instanceof List<?> prev) {
            for (Object o : prev) {
                if (!(o instanceof Map<?, ?> m)) continue;
                Map<String, Object> p = (Map<String, Object>) m;
                String doi = stringField(p, "doi");
                if (doi == null) continue;
                Map<String, Object> match = byDoi.get(doi.trim().toLowerCase());
                if (match == null) continue;
                Object cit = p.get("citations");
                if (cit instanceof Map<?, ?> cm) {
                    for (String key : List.of("scopus", "mendeley", "crossref")) {
                        Object v = ((Map<String, Object>) cm).get(key);
                        if (v instanceof Number n) putCitation(match, key, n.intValue());
                    }
                }
                // Preserve PLUMX in sources if it was there
                Object srcs = p.get("sources");
                if (srcs instanceof List<?> sl) {
                    for (Object s : sl) {
                        if ("PLUMX".equals(String.valueOf(s))) addSource(match, "PLUMX");
                    }
                }
            }
        }

        // 4) Safety-net coalesce: merge baseline rows that share a normalized
        //    DOI (same DOI == same paper). DOI-only and gap-filling — it never
        //    overwrites an existing citation value and never merges by title,
        //    so distinct papers can't be wrongly collapsed. Belt-and-suspenders
        //    on top of the trim-normalized DOI indexing above.
        staged.put("publications", coalesceByDoi(baseline));
    }

    /**
     * Merges baseline rows sharing a normalized (trim+lowercase) DOI into the
     * first occurrence, folding sources and filling MISSING citation keys
     * only. DOI-less rows pass through untouched.
     */
    @SuppressWarnings("unchecked")
    private List<Map<String, Object>> coalesceByDoi(List<Map<String, Object>> pubs) {
        java.util.LinkedHashMap<String, Map<String, Object>> firstByDoi = new java.util.LinkedHashMap<>();
        List<Map<String, Object>> out = new java.util.ArrayList<>();
        for (Map<String, Object> p : pubs) {
            String doi = stringField(p, "doi");
            String key = doi == null ? null : doi.trim().toLowerCase();
            if (key == null) { out.add(p); continue; }
            Map<String, Object> first = firstByDoi.get(key);
            if (first == null) {
                firstByDoi.put(key, p);
                out.add(p);
                continue;
            }
            // Duplicate DOI — fold into the first occurrence.
            Object firstCitObj = first.get("citations");
            Map<String, Object> firstCit = firstCitObj instanceof Map<?, ?> fm
                    ? (Map<String, Object>) fm : null;
            Object cit = p.get("citations");
            if (cit instanceof Map<?, ?> cm) {
                for (Map.Entry<String, Object> e : ((Map<String, Object>) cm).entrySet()) {
                    String ck = String.valueOf(e.getKey()).toLowerCase();
                    Object v = e.getValue();
                    // Gap-fill only — never clobber a value the first row already has.
                    if (v instanceof Number n && (firstCit == null || firstCit.get(ck) == null)) {
                        putCitation(first, ck, n.intValue());
                    }
                }
            }
            Object srcs = p.get("sources");
            if (srcs instanceof List<?> sl) {
                for (Object s : sl) addSource(first, String.valueOf(s));
            }
        }
        if (out.size() != pubs.size()) {
            log.info("[Rebuild] Coalesced {} baseline rows into {} by DOI", pubs.size(), out.size());
        }
        return out;
    }

    /** Adds {@code p}'s DOI and title to the running indexes. Tolerant of
     *  missing fields — only indexes what's present. */
    private static void indexEntry(Map<String, Object> p,
            java.util.LinkedHashMap<String, Map<String, Object>> byDoi,
            java.util.LinkedHashMap<String, Map<String, Object>> byTitle) {
        String doi = stringField(p, "doi");
        if (doi != null) byDoi.put(doi.trim().toLowerCase(), p);
        String title = stringField(p, "title");
        if (title != null) byTitle.put(title.toLowerCase().trim(), p);
    }

    /** Reads {@code staged.{source}.rawData.{articles|publications}} as a List. */
    @SuppressWarnings("unchecked")
    private static List<Map<String, Object>> readSourceArticles(Map<String, Object> staged, String source) {
        Object blob = staged.get(source);
        if (!(blob instanceof Map<?, ?> bm)) return List.of();
        Object raw = ((Map<String, Object>) bm).get("rawData");
        if (!(raw instanceof Map<?, ?> rm)) return List.of();
        Map<String, Object> rawMap = (Map<String, Object>) rm;
        Object arr = rawMap.get("articles");
        if (arr == null) arr = rawMap.get("publications");
        if (!(arr instanceof List<?> list)) return List.of();
        List<Map<String, Object>> out = new java.util.ArrayList<>();
        for (Object o : list) {
            if (o instanceof Map<?, ?> m) out.add((Map<String, Object>) m);
        }
        return out;
    }

    /**
     * 3-tier match against the OpenAlex baseline:
     * <ol>
     *   <li>DOI exact (case-insensitive)</li>
     *   <li>Title exact (lowercased + trimmed)</li>
     *   <li>Title fuzzy: alphanumeric-only normalize + prefix-of-other (≥20
     *       chars, handles Scholar's "..." truncation) + Levenshtein within
     *       ~10% of length.</li>
     * </ol>
     * Returns the matched baseline entry, or null if nothing matches.
     */
    private static Map<String, Object> findMatch(Map<String, Object> incoming,
            Map<String, Map<String, Object>> byDoi,
            Map<String, Map<String, Object>> byTitle,
            List<Map<String, Object>> all) {
        String doi = stringField(incoming, "doi");
        if (doi != null) {
            Map<String, Object> m = byDoi.get(doi.trim().toLowerCase());
            if (m != null) return m;
        }
        String title = stringField(incoming, "title");
        if (title == null) return null;
        Map<String, Object> exact = byTitle.get(title.toLowerCase().trim());
        if (exact != null) return exact;

        String inNorm = normalizeTitle(title);
        if (inNorm.isEmpty()) return null;
        for (Map<String, Object> p : all) {
            String t = stringField(p, "title");
            if (t == null) continue;
            String pNorm = normalizeTitle(t);
            if (titleMatches(inNorm, pNorm)) return p;
        }
        return null;
    }

    /** Lowercase + strip non-alphanumerics. */
    private static String normalizeTitle(String t) {
        if (t == null) return "";
        return t.toLowerCase().replaceAll("[^a-z0-9]", "");
    }

    /** Mirrors SmartPublicationService.isTitleMatch. */
    private static boolean titleMatches(String a, String b) {
        if (a.isEmpty() || b.isEmpty()) return false;
        if (a.equals(b)) return true;
        // Scholar truncates with "..." — accept prefix when ≥ 20 chars.
        if (a.length() >= 20 && b.startsWith(a)) return true;
        if (b.length() >= 20 && a.startsWith(b)) return true;
        // ~10% tolerance, min 2 edits.
        int allowed = Math.max(2, Math.min(a.length(), b.length()) / 10);
        return levenshtein(a, b) <= allowed;
    }

    private static int levenshtein(String a, String b) {
        int[] costs = new int[b.length() + 1];
        for (int j = 0; j < costs.length; j++) costs[j] = j;
        for (int i = 1; i <= a.length(); i++) {
            costs[0] = i;
            int prev = i - 1;
            for (int j = 1; j <= b.length(); j++) {
                int curr = costs[j];
                costs[j] = Math.min(
                        Math.min(costs[j] + 1, costs[j - 1] + 1),
                        prev + (a.charAt(i - 1) == b.charAt(j - 1) ? 0 : 1));
                prev = curr;
            }
        }
        return costs[b.length()];
    }

    /** Copy citations + missing metadata from {@code from} into baseline {@code into}.
     *  First-source-wins for scalar metadata, EXCEPT for index/quartile/IF
     *  fields which are WoS's specialty and should always overwrite when WoS
     *  provides them (OpenAlex doesn't have JCR data). */
    @SuppressWarnings("unchecked")
    private static void enrichInto(Map<String, Object> into, Map<String, Object> from, String source) {
        // Generic backfill: only if existing is missing/blank. Abstract
        // intentionally NOT in this list — it has source-specific rules
        // applied below (OpenAlex → WoS only).
        List<String> backfill = List.of(
                "year", "journal", "publisher", "volume", "issue", "pages", "url",
                "authors", "language", "issn", "eissn", "articleNo",
                "publicationDate", "openAccess",
                "wosId", "scopusId", "openAlexId",
                "category");
        for (String k : backfill) {
            Object existing = into.get(k);
            boolean blank = existing == null
                    || (existing instanceof String s && s.isBlank())
                    || (existing instanceof java.util.Collection<?> c && c.isEmpty())
                    || (existing instanceof Map<?, ?> mc && mc.isEmpty());
            if (blank && from.get(k) != null) {
                into.put(k, from.get(k));
            }
        }

        // ── Abstract: OpenAlex priority, WoS fallback only ──────────
        // Per product spec the publication's abstract must come from
        // OpenAlex when available; if OpenAlex didn't supply one, WoS
        // is allowed to fill in. Scopus / Scholar / PlumX never touch
        // the abstract field — they don't reliably produce one and
        // letting them overwrite would cost us OpenAlex's longer
        // reconstructed text.
        if ("WOS".equals(source)) {
            Object existing = into.get("abstract");
            boolean blank = existing == null
                    || (existing instanceof String s && s.isBlank());
            if (blank && from.get("abstract") != null) {
                Object incoming = from.get("abstract");
                if (incoming instanceof String is && !is.isBlank()) {
                    into.put("abstract", is);
                }
            }
        }
        // SCOPUS / SCHOLAR / PLUMX: deliberately no abstract write.
        // WoS-specialty fields ALWAYS take WoS's value when WoS provides one
        // (JCR Q value, JIF, indexTypes, funding, addresses — none of
        // which OpenAlex/Scopus have).
        if ("WOS".equals(source)) {
            for (String k : List.of(
                    "indexType", "qValue", "impactFactor",
                    "indexTypes", "wosCategories", "researchAreas",
                    "authorKeywords", "keywordsPlus",
                    "jcrCategories", "jciCategories", "jifValues", "jcrYear", "jciValue",
                    "funding", "addresses", "orcidList", "researcherIdList",
                    "accession", "idsNumber", "earlyAccess", "indexed",
                    "documentTypes", "mappedPublicationType")) {
                if (from.get(k) != null) into.put(k, from.get(k));
            }
        }
        // ── Keywords: WoS priority ─────────────────────────────────
        // Per product spec WoS authorKeywords are the canonical source —
        // when WoS provides a non-empty list, REPLACE whatever other
        // sources contributed (OpenAlex concepts in particular tend to
        // be very general topical labels). Other sources only fill the
        // field when it's still empty (first-source-wins for non-WoS).
        Object incomingKw = from.get("keywords");
        if (incomingKw instanceof java.util.Collection<?> incomingList && !incomingList.isEmpty()) {
            if ("WOS".equals(source)) {
                // WoS always overwrites, dedup'd and ordered.
                java.util.LinkedHashSet<Object> wosKw = new java.util.LinkedHashSet<>(
                        (java.util.Collection<Object>) incomingList);
                into.put("keywords", new java.util.ArrayList<>(wosKw));
            } else {
                // Non-WoS: only set if existing is missing/empty.
                Object existingKw = into.get("keywords");
                boolean blank = existingKw == null
                        || (existingKw instanceof java.util.Collection<?> ec && ec.isEmpty());
                if (blank) {
                    java.util.LinkedHashSet<Object> dedup = new java.util.LinkedHashSet<>(
                            (java.util.Collection<Object>) incomingList);
                    into.put("keywords", new java.util.ArrayList<>(dedup));
                }
            }
        }
        // Merge citations from this source
        Object srcCit = from.get("citations");
        if (srcCit instanceof Map<?, ?> sm) {
            for (var e : ((Map<String, Object>) sm).entrySet()) {
                if (e.getValue() instanceof Number n) putCitation(into, e.getKey(), n.intValue());
            }
        }
        addSource(into, source);
    }

    @SuppressWarnings("unchecked")
    private static void putCitation(Map<String, Object> p, String key, int value) {
        Map<String, Object> c = p.get("citations") instanceof Map<?, ?> cm
                ? (Map<String, Object>) cm : new HashMap<>();
        c.put(key, value);
        p.put("citations", c);
    }

    @SuppressWarnings("unchecked")
    private static void addSource(Map<String, Object> p, String source) {
        Object existing = p.get("sources");
        java.util.LinkedHashSet<String> set = new java.util.LinkedHashSet<>();
        if (existing instanceof List<?> l) {
            for (Object s : l) if (s != null) set.add(String.valueOf(s));
        }
        set.add(source);
        p.put("sources", new java.util.ArrayList<>(set));
    }

    private static String stringField(Map<String, Object> p, String key) {
        Object v = p.get(key);
        if (v instanceof String s && !s.isBlank()) return s.trim();
        return null;
    }

    private static String pubKey(Map<String, Object> p) {
        String doi = stringField(p, "doi");
        if (doi != null) return "doi:" + doi.toLowerCase();
        String title = stringField(p, "title");
        if (title != null) return "title:" + title.toLowerCase();
        return null;
    }

    @SuppressWarnings("unchecked")
    private static Map<String, Object> normalizePublication(Map<String, Object> raw, String source) {
        Map<String, Object> p = new HashMap<>();
        // ── Identifiers ────────────────────────────────────────────────
        copyFirst(p, "doi", raw, "doi", "DOI");
        copyFirst(p, "openAlexId", raw, "openAlexId", "openalex_id", "id");
        copyFirst(p, "wosId", raw, "wosId", "accession", "ut");
        copyFirst(p, "scopusId", raw, "scopusId", "eid");

        // ── Title / type / dates / language ────────────────────────────
        copyFirst(p, "title", raw, "title", "name", "articleTitle", "display_name");
        copyFirst(p, "year", raw, "year", "publicationYear", "publishedYear", "publication_year");
        copyFirst(p, "publicationDate", raw, "publicationDate", "publication_date", "pubDate");
        copyFirst(p, "language", raw, "language");

        // ── Venue ──────────────────────────────────────────────────────
        copyFirst(p, "journal", raw, "journal", "sourceTitle", "venue", "publication");
        copyFirst(p, "publisher", raw, "publisher");
        copyFirst(p, "issn", raw, "issn", "ISSN");
        copyFirst(p, "eissn", raw, "eissn", "EISSN");

        // ── Bibliographic ──────────────────────────────────────────────
        copyFirst(p, "volume", raw, "volume");
        copyFirst(p, "issue", raw, "issue");
        copyFirst(p, "pages", raw, "pages");
        copyFirst(p, "articleNo", raw, "articleNo", "article_number");

        // ── Links / abstract / classification ──────────────────────────
        copyFirst(p, "url", raw, "url", "href", "link", "articleUrl");
        // Abstract: only OpenAlex and WoS may produce one. Scopus, Scholar,
        // and PlumX never touch abstract — even when they're a baseline
        // source (e.g. WoS-only pub matched against no OpenAlex twin).
        // Per product spec the priority chain is OpenAlex → WoS, others
        // remain hands-off so we never replace the longer/cleaner
        // OpenAlex reconstruction with a partial scrape.
        if ("OPENALEX".equals(source) || "WOS".equals(source)) {
            copyFirst(p, "abstract", raw, "abstract", "abstractText");
        }
        copyFirst(p, "openAccess", raw, "openAccess");

        // Index info — WoS provides indexTypes (array, e.g. SCI-EXPANDED, SSCI)
        // and a derived indexType (Q value, despite the field name).
        // Normalize the array entries to the system's short codes so the
        // researcher dashboard's IndexBadge component can render them
        // (it only knows SCI / SCI-E / SSCI / AHCI / ESCI / CPCI-* /
        // BKCI-* / Scopus / TR Dizin).
        Object indexTypes = raw.get("indexTypes");
        if (indexTypes instanceof java.util.List<?> idxList) {
            java.util.List<String> normalized = new java.util.ArrayList<>();
            for (Object o : idxList) {
                if (o == null) continue;
                String code = normalizeIndexCode(String.valueOf(o));
                if (code != null && !normalized.contains(code)) normalized.add(code);
            }
            if (!normalized.isEmpty()) p.put("indexTypes", normalized);
        } else if (indexTypes != null) {
            p.put("indexTypes", indexTypes);
        }
        Object researchAreas = raw.get("researchAreas");
        if (researchAreas != null) p.put("researchAreas", researchAreas);
        Object wosCategories = raw.get("wosCategories");
        if (wosCategories != null) p.put("wosCategories", wosCategories);

        // Keywords from WoS (authorKeywords + keywordsPlus) and OpenAlex (concepts).
        Object akw = raw.get("authorKeywords");
        if (akw != null) p.put("authorKeywords", akw);
        Object kwPlus = raw.get("keywordsPlus");
        if (kwPlus != null) p.put("keywordsPlus", kwPlus);
        Object keywords = raw.get("keywords");
        if (keywords != null) p.put("keywords", keywords);

        // ── Authors (always carried as-is; downstream handles shape) ──
        Object authors = raw.get("authors");
        if (authors == null) authors = raw.get("authorList");
        if (authors != null) p.put("authors", authors);

        // Per-publication citations. Different sources name this field
        // differently — even within the same source the worker has multiple
        // fallbacks (citation report value vs detail-page refined value).
        // Pull from every known alias:
        //   • {citations: <n>}                    — generic, fills citations.<source>
        //   • {citations: {wos: ..., scopus: ...}} — already-merged map
        //   • {wosCitations: <n>}                 — WoS detail page refined
        //   • {citationCountWos: <n>}             — legacy backend shape
        //   • {scopusCitations: <n>}              — PlumX overlay (we stamp this when ingesting PlumX, but the worker also emits it directly for some Scopus paths)
        //   • {scholarCitations: <n>} / {citationCountScholar: <n>}
        //   • {timesCited / citationCount / citedByCount: <n>} — generic fallbacks
        Map<String, Object> citations = new HashMap<>();
        Object cit = raw.get("citations");
        if (cit instanceof Number n) {
            citations.put(source.toLowerCase(), n.intValue());
        } else if (cit instanceof Map<?, ?> cm) {
            for (var e : ((Map<String, Object>) cm).entrySet()) {
                Object v = e.getValue();
                if (v instanceof Number nn) citations.put(String.valueOf(e.getKey()).toLowerCase(), nn.intValue());
            }
        }

        // Per-source explicit fields — these take precedence over the
        // generic "citations" field for THEIR source. Lets a WoS scrape
        // emit BOTH a fuzzy "citations" (from the list page) AND a
        // refined "wosCitations" (from the detail page) and we land on
        // the better number.
        putIfNumber(citations, "wos", firstNumber(raw, "wosCitations", "citationCountWos"));
        putIfNumber(citations, "scopus", firstNumber(raw, "scopusCitations", "citationCountScopus"));
        putIfNumber(citations, "scholar", firstNumber(raw, "scholarCitations", "citationCountScholar"));
        putIfNumber(citations, "openalex", firstNumber(raw, "openalexCitations", "citedByCount"));
        putIfNumber(citations, "mendeley", firstNumber(raw, "mendeleyCitations", "mendeleyReaders"));
        putIfNumber(citations, "crossref", firstNumber(raw, "crossrefCitations"));

        // Last-resort generic fallbacks — only for the source that's
        // currently being normalized, and only if we haven't filled it
        // already.
        if (citations.get(source.toLowerCase()) == null) {
            Integer generic = firstNumber(raw, "timesCited", "citationCount");
            if (generic != null) citations.put(source.toLowerCase(), generic);
        }

        if (!citations.isEmpty()) p.put("citations", citations);

        Object indexType = raw.get("indexType");
        if (indexType == null) indexType = raw.get("index");
        if (indexType != null) p.put("indexType", indexType);

        Object qValue = raw.get("qValue");
        if (qValue == null) qValue = raw.get("quartile");
        if (qValue != null) p.put("qValue", qValue);

        Object impactFactor = raw.get("impactFactor");
        if (impactFactor != null) p.put("impactFactor", impactFactor);

        // Additional WoS-detail fields the form-engine downstream renders.
        // Carry them through unchanged so the operator panel + the
        // researcher CV both see the rich JCR / JCI / funding metadata.
        for (String k : List.of(
                // JCR / JCI rankings + values
                "jifValues", "jcrYear", "jciValue",
                // Funding & affiliation context
                "funding", "addresses",
                // Author identifier crosswalks (ORCID / ResearcherID lists
                // attached to this paper). Different from the per-author
                // `authors[].orcid` because some papers have ORCID without
                // a full name match.
                "orcidList", "researcherIdList",
                // Misc bibliographic IDs
                "accession", "idsNumber", "earlyAccess", "indexed",
                // Documents-by-author tabs sometimes carry these
                "pubType", "documentSubType")) {
            Object v = raw.get(k);
            if (v != null) p.put(k, v);
        }

        // Carry through type-signalling fields so resolveCategory has a
        // chance to read them.
        for (String k : List.of("documentType", "documentTypes",
                "mappedPublicationType", "originalType", "publicationType",
                "articleType", "type")) {
            Object v = raw.get(k);
            if (v != null) p.put(k, v);
        }

        // Existing source-supplied category wins ONLY if it's already a
        // pub_* slug; otherwise we run it through the mapper.
        Object rawCategory = raw.get("category");
        if (rawCategory instanceof String rc && rc.startsWith("pub_")) {
            p.put("category", rc);
        } else {
            // Will read documentTypes / originalType / etc. and fall back
            // to pub_article.
            String resolved = resolveCategory(p);
            p.put("category", resolved);
        }

        // Track which sources surfaced this entry
        List<String> sources = new java.util.ArrayList<>();
        sources.add(source);
        p.put("sources", sources);

        // Audit: provenance per-publication
        p.put("provenance", "WORKER");
        return p;
    }

    /**
     * Normalises a WoS edition string (as scraped from
     * {@code [id^="FullRRPTa-edition"]} elements) to the system's short
     * code that the IndexBadge component recognises:
     * <pre>
     *   SCI     — Science Citation Index
     *   SCI-E   — Science Citation Index Expanded
     *   SSCI    — Social Sciences Citation Index
     *   AHCI    — Arts &amp; Humanities Citation Index
     *   ESCI    — Emerging Sources Citation Index
     *   CPCI-S  — Conference Proceedings Citation Index – Science
     *   CPCI-SSH— Conference Proceedings Citation Index – Social Sciences &amp; Humanities
     *   BKCI-S  — Book Citation Index – Science
     *   BKCI-SSH— Book Citation Index – Social Sciences &amp; Humanities
     * </pre>
     * Inputs may be:
     * <ul>
     *   <li>"Science Citation Index Expanded (SCI-EXPANDED)" — full WoS label with paren'd code</li>
     *   <li>"SCI-EXPANDED" — bare code</li>
     *   <li>"SSCI" — already short</li>
     *   <li>Anything unrecognised — returned trimmed verbatim so we don't lose data</li>
     * </ul>
     */
    private static String normalizeIndexCode(String raw) {
        if (raw == null) return null;
        String s = raw.trim();
        if (s.isEmpty()) return null;

        // 1. Look for a parenthesised short code first — most reliable
        //    when the WoS label is the long human-readable form.
        java.util.regex.Matcher m = java.util.regex.Pattern.compile("\\(([A-Za-z][A-Za-z0-9 \\-]{1,15})\\)").matcher(s);
        while (m.find()) {
            String paren = m.group(1).trim().toUpperCase();
            String code = mapShortIndexCode(paren);
            if (code != null) return code;
        }

        // 2. Match against well-known full names.
        String upper = s.toUpperCase();
        if (upper.contains("SCIENCE CITATION INDEX EXPANDED")) return "SCI-E";
        if (upper.contains("SCIENCE CITATION INDEX")) return "SCI";
        if (upper.contains("SOCIAL SCIENCES CITATION INDEX")) return "SSCI";
        if (upper.contains("ARTS") && upper.contains("HUMANITIES CITATION INDEX")) return "AHCI";
        if (upper.contains("EMERGING SOURCES CITATION INDEX")) return "ESCI";
        if (upper.contains("CONFERENCE PROCEEDINGS CITATION INDEX")
                && (upper.contains("SOCIAL") || upper.contains("HUMANITIES") || upper.contains("SSH"))) {
            return "CPCI-SSH";
        }
        if (upper.contains("CONFERENCE PROCEEDINGS CITATION INDEX")) return "CPCI-S";
        if (upper.contains("BOOK CITATION INDEX")
                && (upper.contains("SOCIAL") || upper.contains("HUMANITIES") || upper.contains("SSH"))) {
            return "BKCI-SSH";
        }
        if (upper.contains("BOOK CITATION INDEX")) return "BKCI-S";

        // 3. Bare short code passed as-is.
        String maybe = mapShortIndexCode(upper);
        if (maybe != null) return maybe;

        // 4. Unknown — return trimmed input so unusual labels still appear
        //    on the badge (operator can edit if needed).
        return s;
    }

    /** Folds known short-code spellings (e.g. "SCI-EXPANDED" → "SCI-E"). */
    private static String mapShortIndexCode(String upper) {
        switch (upper) {
            case "SCI":
                return "SCI";
            case "SCI-E":
            case "SCIE":
            case "SCI-EXPANDED":
                return "SCI-E";
            case "SSCI":
                return "SSCI";
            case "AHCI":
            case "A&HCI":
                return "AHCI";
            case "ESCI":
                return "ESCI";
            case "CPCI-S":
            case "CPCIS":
                return "CPCI-S";
            case "CPCI-SSH":
            case "CPCISSH":
                return "CPCI-SSH";
            case "BKCI-S":
            case "BKCIS":
                return "BKCI-S";
            case "BKCI-SSH":
            case "BKCISSH":
                return "BKCI-SSH";
            case "SCOPUS":
                return "Scopus";
            case "TR DIZIN":
            case "TR-DIZIN":
            case "TR_DIZIN":
                return "TR Dizin";
            default:
                return null;
        }
    }

    private static void copyFirst(Map<String, Object> dst, String dstKey, Map<String, Object> src, String... candidates) {
        for (String k : candidates) {
            Object v = src.get(k);
            if (v != null && !(v instanceof String s && s.isBlank())) {
                dst.put(dstKey, v);
                return;
            }
        }
    }

    /**
     * Pulls the first non-null numeric value from {@code src} under any of
     * the candidate keys. Coerces strings like "5" to 5; returns null if
     * none of the keys produce a number.
     */
    private static Integer firstNumber(Map<String, Object> src, String... candidates) {
        for (String k : candidates) {
            Object v = src.get(k);
            if (v instanceof Number n) return n.intValue();
            if (v instanceof String s && !s.isBlank()) {
                try { return Integer.parseInt(s.trim()); }
                catch (NumberFormatException ignored) { /* fall through */ }
            }
        }
        return null;
    }

    private static void putIfNumber(Map<String, Object> citations, String key, Integer value) {
        if (value != null) citations.put(key, value);
    }
}

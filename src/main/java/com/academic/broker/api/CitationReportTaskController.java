package com.academic.broker.api;

import com.academic.broker.domain.CitationReportTask;
import com.academic.broker.domain.TaskStatus;
import com.academic.broker.exception.TaskNotFoundException;
import com.academic.broker.exception.TaskNotProcessableException;
import com.academic.broker.repository.CitationReportTaskRepository;
import com.academic.broker.service.SyncRequestWorkerBridge;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.data.domain.PageRequest;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.web.bind.annotation.*;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;

/**
 * Worker + operator-panel API for the WoS Citation Report pipeline.
 *
 * <p>Endpoints:
 * <ul>
 *   <li>{@code POST /announce} — Chrome extension calls this when it
 *       discovers the "View citation report" link on the WoS author
 *       profile page. Persists the URL as a {@link CitationReportTask}
 *       so it survives a service-worker restart and shows up in the
 *       operator panel.</li>
 *   <li>{@code GET  /poll}    — worker pulls batched PENDING tasks,
 *       atomically flipping them to PROCESSING.</li>
 *   <li>{@code POST /{id}/complete} — worker submits the scraped
 *       payload. Bridge folds it into the sync request's stagedData.</li>
 *   <li>{@code POST /{id}/fail} — worker reports a scrape failure
 *       (timeout, injection error, page exception). The task moves to
 *       FAILED so the operator panel can offer a "Tekrar Dene" button.</li>
 *   <li>{@code POST /{id}/retry} — operator panel "Tekrar Dene" action.
 *       Resets a FAILED/COMPLETED task to PENDING and bumps
 *       {@code retryCount}.</li>
 * </ul>
 */
@Slf4j
@RestController
@RequestMapping("/api/citation-report-tasks")
@RequiredArgsConstructor
public class CitationReportTaskController {

    private final CitationReportTaskRepository repository;
    private final SyncRequestWorkerBridge bridge;

    /**
     * Worker submits the citation-report URL discovered during a WOS
     * author scrape. We resolve the syncRequestId from the announced
     * article task and create (or update) the citation-report task row.
     *
     * <p>Body: {@code {"articleTaskId": <Long>, "citationReportUrl": "...",
     *                  "authorWosId": "..."}}
     *
     * <p>Returns: {@code {"taskId": <Long>}} on success, 4xx on bad
     * input, 200 with {@code taskId: null} when the article task is
     * unknown (broker-side log only — worker should ignore).
     */
    @PostMapping(value = "/announce",
            consumes = MediaType.APPLICATION_JSON_VALUE,
            produces = MediaType.APPLICATION_JSON_VALUE)
    public ResponseEntity<Map<String, Object>> announce(@RequestBody Map<String, Object> body) {
        Object atIdRaw = body.get("articleTaskId");
        Object urlRaw = body.get("citationReportUrl");
        Object authorWosIdRaw = body.get("authorWosId");

        Long articleTaskId = null;
        if (atIdRaw instanceof Number n) {
            articleTaskId = n.longValue();
        } else if (atIdRaw instanceof String s && !s.isBlank()) {
            try { articleTaskId = Long.parseLong(s.trim()); }
            catch (NumberFormatException e) { /* fall through */ }
        }

        if (articleTaskId == null
                || !(urlRaw instanceof String url) || url.isBlank()) {
            return ResponseEntity.badRequest().body(Map.of(
                    "error", "articleTaskId (Long) and citationReportUrl (non-blank String) are required"));
        }

        String authorWosId = authorWosIdRaw instanceof String s ? s : null;
        Long taskId = bridge.announceCitationReportLink(articleTaskId, url, authorWosId);
        return ResponseEntity.ok(Map.of("taskId", taskId == null ? "" : taskId));
    }

    /**
     * Worker poll: claim a batch of PENDING tasks and mark them
     * PROCESSING. Returns 204 if there's nothing to do.
     */
    @GetMapping(value = "/poll", produces = MediaType.APPLICATION_JSON_VALUE)
    @Transactional
    public ResponseEntity<List<Map<String, Object>>> poll(
            @RequestParam(name = "batchSize", defaultValue = "1") int batchSize) {
        if (batchSize <= 0 || batchSize > 10) batchSize = 1;
        List<CitationReportTask> pending = repository.findPendingForUpdate(
                PageRequest.of(0, batchSize));
        if (pending.isEmpty()) return ResponseEntity.noContent().build();
        List<Map<String, Object>> out = new ArrayList<>(pending.size());
        for (CitationReportTask t : pending) {
            t.setStatus(TaskStatus.PROCESSING);
            t.touch();
            repository.save(t);
            out.add(Map.of(
                    "taskId", t.getId(),
                    "citationReportUrl", t.getCitationReportUrl(),
                    "authorWosId", t.getAuthorWosId() == null ? "" : t.getAuthorWosId(),
                    "syncRequestId", t.getSyncRequestId().toString(),
                    "retryCount", t.getRetryCount()
            ));
        }
        return ResponseEntity.ok(out);
    }

    /**
     * Worker submits the citation-report payload. Marks the task
     * COMPLETED and dispatches it through the bridge so the data lands
     * in {@code stagedData.WOS.citationReport} on the sync request.
     *
     * <p>Body: {@code {"rawData": {...}}}
     */
    @PostMapping(value = "/{taskId}/complete",
            consumes = MediaType.APPLICATION_JSON_VALUE)
    @Transactional
    public ResponseEntity<Void> complete(@PathVariable Long taskId,
                                          @RequestBody Map<String, Object> body) {
        CitationReportTask task = repository.findByIdForUpdate(taskId)
                .orElseThrow(() -> new TaskNotFoundException(taskId));
        if (task.getStatus() != TaskStatus.PROCESSING) {
            throw new TaskNotProcessableException(taskId, task.getStatus(), "complete");
        }
        Object raw = body.get("rawData");
        if (raw instanceof Map<?, ?> rm) {
            @SuppressWarnings("unchecked")
            Map<String, Object> rawMap = (Map<String, Object>) rm;
            task.setRawData(rawMap);
        }
        task.setStatus(TaskStatus.COMPLETED);
        task.setErrorMessage(null);
        task.touch();
        repository.save(task);
        bridge.ingestCitationReportCompletion(task);
        log.info("[CitationReport] Task {} completed", taskId);
        return ResponseEntity.ok().build();
    }

    /**
     * Worker reports a scrape failure. Body: {@code {"errorMessage":
     * "..."}}.
     */
    @PostMapping(value = "/{taskId}/fail",
            consumes = MediaType.APPLICATION_JSON_VALUE)
    @Transactional
    public ResponseEntity<Void> fail(@PathVariable Long taskId,
                                      @RequestBody(required = false) Map<String, Object> body) {
        CitationReportTask task = repository.findByIdForUpdate(taskId)
                .orElseThrow(() -> new TaskNotFoundException(taskId));
        if (task.getStatus() != TaskStatus.PROCESSING) {
            throw new TaskNotProcessableException(taskId, task.getStatus(), "fail");
        }
        String err = body != null && body.get("errorMessage") instanceof String s ? s : null;
        task.setStatus(TaskStatus.FAILED);
        task.setErrorMessage(err);
        task.touch();
        repository.save(task);
        // Push the failure into stagedData so the operator panel sees a
        // "FAILED" chip with the error message and can offer Retry.
        bridge.ingestCitationReportCompletion(task);
        log.warn("[CitationReport] Task {} failed: {}", taskId, err);
        return ResponseEntity.ok().build();
    }

    /**
     * Operator-panel "Tekrar Dene" — flip a FAILED or COMPLETED task
     * back to PENDING so the worker re-scrapes it. PENDING/PROCESSING
     * tasks are left alone (no-op) so a double-click doesn't reset
     * mid-flight work.
     */
    @PostMapping(value = "/{taskId}/retry")
    @Transactional
    public ResponseEntity<Map<String, Object>> retry(@PathVariable Long taskId) {
        CitationReportTask task = repository.findByIdForUpdate(taskId)
                .orElseThrow(() -> new TaskNotFoundException(taskId));
        TaskStatus s = task.getStatus();
        if (s == TaskStatus.PENDING || s == TaskStatus.PROCESSING) {
            return ResponseEntity.ok(Map.of("ok", false, "reason", "already active", "status", s.name()));
        }
        task.setStatus(TaskStatus.PENDING);
        task.setErrorMessage(null);
        task.setRetryCount(task.getRetryCount() + 1);
        task.setWatchdogResets(0); // fresh watchdog budget on an operator retry
        task.touch();
        repository.save(task);
        log.info("[CitationReport] Task {} retried (count={})", taskId, task.getRetryCount());
        return ResponseEntity.ok(Map.of("ok", true, "retryCount", task.getRetryCount()));
    }

    /**
     * Operator panel: get all citation-report tasks for a sync request
     * (typically 0 or 1). Returns a flat list of summary records the UI
     * can render.
     */
    @GetMapping(value = "/by-sync/{syncRequestId}",
            produces = MediaType.APPLICATION_JSON_VALUE)
    public ResponseEntity<List<Map<String, Object>>> bySync(
            @PathVariable java.util.UUID syncRequestId) {
        List<CitationReportTask> tasks = repository.findBySyncRequestId(syncRequestId);
        List<Map<String, Object>> out = new ArrayList<>(tasks.size());
        for (CitationReportTask t : tasks) {
            Map<String, Object> m = new java.util.HashMap<>();
            m.put("taskId", t.getId());
            m.put("status", t.getStatus().name());
            m.put("citationReportUrl", t.getCitationReportUrl());
            m.put("authorWosId", t.getAuthorWosId());
            m.put("retryCount", t.getRetryCount());
            m.put("errorMessage", t.getErrorMessage());
            m.put("createdAt", t.getCreatedAt() != null ? t.getCreatedAt().toString() : null);
            m.put("updatedAt", t.getUpdatedAt() != null ? t.getUpdatedAt().toString() : null);
            m.put("rawData", t.getRawData());
            out.add(m);
        }
        return ResponseEntity.ok(out);
    }
}

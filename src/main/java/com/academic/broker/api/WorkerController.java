package com.academic.broker.api;

import com.academic.broker.domain.ArticleTask;
import com.academic.broker.domain.CitationReportTask;
import com.academic.broker.domain.TargetSource;
import com.academic.broker.domain.TaskStatus;
import com.academic.broker.repository.ArticleTaskRepository;
import com.academic.broker.repository.CitationReportTaskRepository;
import com.academic.broker.service.SessionStateService;
import com.academic.broker.service.WorkerHealthService;
import lombok.RequiredArgsConstructor;
import org.springframework.http.ResponseEntity;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RestController;

import java.time.Duration;
import java.time.Instant;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;

/**
 * Worker liveness + progress, split by audience:
 * <ul>
 *   <li>{@code POST /api/worker/ping} — the extension (API-key auth)</li>
 *   <li>{@code GET /api/operator/worker/health},
 *       {@code GET /api/operator/sync-requests/{id}/tasks} — the operator
 *       panel (operator-token auth; see OperatorAuthFilter)</li>
 * </ul>
 * Read endpoints never return scraped payloads (rawData / metrics), only
 * status, timing and progress.
 */
@RestController
@RequiredArgsConstructor
public class WorkerController {

    private final WorkerHealthService health;
    private final SessionStateService sessionState;
    private final ArticleTaskRepository articleRepository;
    private final CitationReportTaskRepository citationReportRepository;

    /**
     * Worker liveness ping. The response lists {@code cancel}: task ids the
     * worker reports as active that the broker no longer wants — deleted by an
     * operator re-scrape / approve / reject / expiry, or already COMPLETED /
     * FAILED. The worker closes those tabs instead of scraping on for nothing
     * (its results would be rejected anyway).
     */
    @PostMapping("/api/worker/ping")
    @Transactional(readOnly = true)
    public ResponseEntity<Map<String, Object>> ping(@RequestBody(required = false) Map<String, Object> body) {
        health.recordPing(body);
        List<Long> reported = new ArrayList<>();
        if (body != null && body.get("activeTasks") instanceof List<?> list) {
            for (Object o : list) {
                if (o instanceof Map<?, ?> m && m.get("taskId") instanceof Number n) reported.add(n.longValue());
            }
        }
        List<Long> cancel = new ArrayList<>();
        if (!reported.isEmpty()) {
            Map<Long, TaskStatus> known = new LinkedHashMap<>();
            for (ArticleTask t : articleRepository.findAllById(reported)) known.put(t.getId(), t.getStatus());
            for (Long id : reported) {
                TaskStatus s = known.get(id);
                if (s == null || s == TaskStatus.COMPLETED || s == TaskStatus.FAILED) cancel.add(id);
            }
        }
        return ResponseEntity.ok(Map.of("ok", true, "serverTime", Instant.now().toString(), "cancel", cancel));
    }

    @GetMapping("/api/operator/worker/health")
    @Transactional(readOnly = true)
    public Map<String, Object> workerHealth() {
        Map<String, Object> out = new LinkedHashMap<>(health.snapshot());

        Map<String, Object> sessions = new LinkedHashMap<>();
        for (String s : List.of("WOS", "SCOPUS", "SCHOLAR")) {
            sessions.put(s, sessionState.snapshot(s).toMap());
        }
        out.put("sessions", sessions);

        List<Map<String, Object>> processing = new ArrayList<>();
        for (ArticleTask t : articleRepository.findByStatusOrderByIdAsc(TaskStatus.PROCESSING)) {
            processing.add(taskView(t));
        }
        out.put("processing", processing);

        Map<String, Long> pending = new LinkedHashMap<>();
        for (TargetSource s : TargetSource.values()) {
            long n = articleRepository.countByTargetSourceAndStatus(s, TaskStatus.PENDING);
            if (n > 0) pending.put(s.name(), n);
        }
        out.put("pendingBySource", pending);
        return out;
    }

    @GetMapping("/api/operator/sync-requests/{id}/tasks")
    @Transactional(readOnly = true)
    public Map<String, Object> syncRequestTasks(@PathVariable UUID id) {
        List<Map<String, Object>> tasks = new ArrayList<>();
        for (ArticleTask t : articleRepository.findBySyncRequestId(id)) {
            tasks.add(taskView(t));
        }
        tasks.sort((a, b) -> Long.compare((Long) b.get("id"), (Long) a.get("id")));

        List<Map<String, Object>> citationReports = new ArrayList<>();
        for (CitationReportTask c : citationReportRepository.findBySyncRequestId(id)) {
            Map<String, Object> m = new LinkedHashMap<>();
            m.put("id", c.getId());
            m.put("status", c.getStatus() == null ? null : c.getStatus().name());
            m.put("updatedAt", iso(c.getUpdatedAt()));
            m.put("errorMessage", c.getErrorMessage());
            m.put("watchdogResets", c.getWatchdogResets());
            citationReports.add(m);
        }
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("tasks", tasks);
        out.put("citationReports", citationReports);
        out.put("serverTime", Instant.now().toString());
        return out;
    }

    private static Map<String, Object> taskView(ArticleTask t) {
        Instant now = Instant.now();
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("id", t.getId());
        m.put("source", t.getTargetSource().name());
        m.put("externalId", t.getExternalId());
        m.put("taskType", t.getTaskType() == null ? null : t.getTaskType().name());
        m.put("status", t.getStatus().name());
        m.put("syncRequestId", t.getSyncRequestId() == null ? null : t.getSyncRequestId().toString());
        m.put("createdAt", iso(t.getCreatedAt()));
        m.put("startedAt", iso(t.getStartedAt()));
        m.put("finishedAt", iso(t.getFinishedAt()));
        m.put("updatedAt", iso(t.getUpdatedAt()));
        m.put("lastHeartbeatAt", iso(t.getLastHeartbeatAt()));
        m.put("secondsSinceUpdate", t.getUpdatedAt() == null ? null
                : Duration.between(t.getUpdatedAt(), now).toSeconds());
        m.put("phase", t.getProgressPhase());
        m.put("current", t.getProgressCurrent());
        m.put("total", t.getProgressTotal());
        m.put("hasAuthorMetrics", t.getAuthorMetricsData() != null);
        m.put("errorMessage", t.getErrorMessage());
        // R4: partial completion (idle timeout mid-detail) + details reused from cache.
        if (t.getRawData() != null) {
            Object partial = t.getRawData().get("partialDetails");
            if (partial != null) m.put("partialDetails", partial);
            Object cached = t.getRawData().get("cachedDetails");
            if (cached != null) m.put("cachedDetails", cached);
        }
        return m;
    }

    private static String iso(Instant i) {
        return i == null ? null : i.toString();
    }
}

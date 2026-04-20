package com.academic.broker.api;

import com.academic.broker.api.dto.DoiPollResponse;
import com.academic.broker.domain.DoiEnrichTask;
import com.academic.broker.domain.TaskStatus;
import com.academic.broker.repository.DoiEnrichTaskRepository;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.web.bind.annotation.*;

import java.time.Instant;
import java.util.List;
import java.util.Map;
import java.util.stream.Collectors;

/**
 * Broker REST controller for DOI-based enrichment tasks.
 *
 * <p>
 * The Chrome extension polls these endpoints every ~15s to pick up work.
 * The Spring Boot backend queues tasks by calling POST
 * /api/doi-enrich-tasks/batch.
 * </p>
 *
 * <h3>Contract:</h3>
 * <ul>
 * <li>{@code POST /batch} — backend queues a batch of DOI tasks</li>
 * <li>{@code GET  /poll?source=WOS} — Chrome extension polls for pending WOS
 * tasks</li>
 * <li>{@code GET  /poll?source=SCHOLAR} — Chrome extension polls for pending
 * SCHOLAR tasks</li>
 * <li>{@code POST /{taskId}/complete} — Chrome extension reports
 * completion</li>
 * <li>{@code POST /{taskId}/scholar-complete} — Scholar-specific complete</li>
 * <li>{@code POST /{taskId}/fail} — Chrome extension reports failure</li>
 * </ul>
 */
@Slf4j
@RestController
@RequestMapping("/api/doi-enrich-tasks")
@RequiredArgsConstructor
public class DoiEnrichTaskController {

    private final DoiEnrichTaskRepository repository;

    // ═══════════════════════════════════════════════
    // Backend → Broker: Queue new tasks
    // ═══════════════════════════════════════════════

    /**
     * Queue DOI enrichment tasks for both WOS and SCHOLAR sources.
     * Skips DOIs that already have PENDING/PROCESSING tasks for that source.
     * <p>
     * Request: {@code { "dois": ["10.1234/...", ...] }}
     */
    @Transactional
    @PostMapping(value = "/batch", consumes = MediaType.APPLICATION_JSON_VALUE)
    public ResponseEntity<Map<String, Object>> addDoiEnrichBatch(
            @RequestBody Map<String, List<String>> request) {

        List<String> dois = request.getOrDefault("dois", List.of());
        if (dois.isEmpty()) {
            return ResponseEntity.badRequest().body(Map.of("error", "dois list is required"));
        }

        int addedWos = 0;
        int addedScholar = 0;
        List<TaskStatus> activeStatuses = List.of(TaskStatus.PENDING, TaskStatus.PROCESSING);

        for (String doi : dois) {
            if (doi == null || doi.isBlank())
                continue;
            String normalizedDoi = doi.trim();

            // Queue WOS task
            if (!repository.existsByDoiAndSourceAndStatusIn(normalizedDoi, "WOS", activeStatuses)) {
                repository.save(DoiEnrichTask.builder()
                        .doi(normalizedDoi)
                        .source("WOS")
                        .status(TaskStatus.PENDING)
                        .build());
                addedWos++;
            }

            // Queue SCHOLAR task
            if (!repository.existsByDoiAndSourceAndStatusIn(normalizedDoi, "SCHOLAR", activeStatuses)) {
                repository.save(DoiEnrichTask.builder()
                        .doi(normalizedDoi)
                        .source("SCHOLAR")
                        .status(TaskStatus.PENDING)
                        .build());
                addedScholar++;
            }
        }

        log.info("[DoiEnrich Broker] Queued WOS={}, SCHOLAR={} from {} DOIs", addedWos, addedScholar, dois.size());
        return ResponseEntity.status(201).body(Map.of(
                "added", addedWos + addedScholar,
                "addedWos", addedWos,
                "addedScholar", addedScholar,
                "skipped", dois.size() * 2 - addedWos - addedScholar));
    }

    // ═══════════════════════════════════════════════
    // Chrome Extension → Broker: Poll for work
    // ═══════════════════════════════════════════════

    /**
     * Chrome extension polls for pending DOI tasks of a given source.
     * Atomically claims PENDING → PROCESSING (SKIP LOCKED prevents double-take).
     *
     * @param source    WOS or SCHOLAR
     * @param batchSize how many tasks to claim at once (default 2)
     */
    @Transactional
    @GetMapping(value = "/poll", produces = MediaType.APPLICATION_JSON_VALUE)
    public ResponseEntity<List<DoiPollResponse>> pollDoiTasks(
            @RequestParam String source,
            @RequestParam(defaultValue = "2") int batchSize) {

        List<DoiEnrichTask> tasks = repository.claimPending(source.toUpperCase(), Math.min(batchSize, 5));
        if (tasks.isEmpty()) {
            return ResponseEntity.noContent().build();
        }

        // Mark as PROCESSING
        for (DoiEnrichTask task : tasks) {
            task.setStatus(TaskStatus.PROCESSING);
            task.touch();
        }
        repository.saveAll(tasks);

        List<DoiPollResponse> response = tasks.stream()
                .map(t -> new DoiPollResponse(t.getId(), t.getDoi(), source.toUpperCase()))
                .collect(Collectors.toList());

        log.info("[DoiEnrich Broker] Polled {} {} task(s) for Chrome extension", tasks.size(), source);
        return ResponseEntity.ok(response);
    }

    // ═══════════════════════════════════════════════
    // Chrome Extension → Broker: Report completion
    // ═══════════════════════════════════════════════

    /**
     * WoS DOI enrichment complete — forward rawData to backend Spring Boot app.
     */
    @Transactional
    @PostMapping(value = "/{taskId}/complete", consumes = MediaType.APPLICATION_JSON_VALUE)
    public ResponseEntity<Void> completeWosTask(
            @PathVariable Long taskId,
            @RequestBody Map<String, Object> body) {

        return completeTask(taskId, body, "WOS");
    }

    /**
     * Scholar DOI enrichment complete — forward rawData to backend Spring Boot app.
     */
    @Transactional
    @PostMapping(value = "/{taskId}/scholar-complete", consumes = MediaType.APPLICATION_JSON_VALUE)
    public ResponseEntity<Void> completeScholarTask(
            @PathVariable Long taskId,
            @RequestBody Map<String, Object> body) {

        return completeTask(taskId, body, "SCHOLAR");
    }

    @SuppressWarnings("unchecked")
    private ResponseEntity<Void> completeTask(Long taskId, Map<String, Object> body, String source) {
        repository.findById(taskId).ifPresent(task -> {
            task.setStatus(TaskStatus.COMPLETED);
            task.setRawData((Map<String, Object>) body.getOrDefault("rawData", body));
            task.touch();
            repository.save(task);
        });

        // Forward result to backend Spring Boot
        forwardToBackend(taskId, body, source);

        log.info("[DoiEnrich Broker] Task {} ({}) completed", taskId, source);
        return ResponseEntity.ok().build();
    }

    /**
     * Chrome extension reports a failure.
     */
    @Transactional
    @PostMapping("/{taskId}/fail")
    public ResponseEntity<Void> failTask(
            @PathVariable Long taskId,
            @RequestBody(required = false) Map<String, Object> body) {

        String error = body != null ? String.valueOf(body.getOrDefault("error", "Unknown")) : "Unknown";
        repository.findById(taskId).ifPresent(task -> {
            task.setStatus(TaskStatus.FAILED);
            task.setErrorMessage(error);
            task.touch();
            repository.save(task);

            // Forward failure to backend
            forwardFailureToBackend(taskId, task.getDoi(), error, task.getSource());
        });
        log.warn("[DoiEnrich Broker] Task {} failed: {}", taskId, error);
        return ResponseEntity.ok().build();
    }

    // ═══════════════════════════════════════════════
    // Forward to backend
    // ═══════════════════════════════════════════════

    /**
     * Forwards the completed task result to the main backend Spring Boot service.
     * The backend URL is hardcoded to localhost:8080 for internal communication.
     * In production this should be externalized to configuration.
     */
    private void forwardToBackend(Long taskId, Map<String, Object> body, String source) {
        try {
            java.net.http.HttpClient client = java.net.http.HttpClient.newHttpClient();
            String endpoint = "SCHOLAR".equals(source)
                    ? "http://localhost:8080/api/doi-enrich-tasks/" + taskId + "/scholar-complete"
                    : "http://localhost:8080/api/doi-enrich-tasks/" + taskId + "/complete";

            String json = new com.fasterxml.jackson.databind.ObjectMapper()
                    .writeValueAsString(body);

            java.net.http.HttpRequest request = java.net.http.HttpRequest.newBuilder()
                    .uri(java.net.URI.create(endpoint))
                    .header("Content-Type", "application/json")
                    .POST(java.net.http.HttpRequest.BodyPublishers.ofString(json))
                    .timeout(java.time.Duration.ofSeconds(10))
                    .build();

            java.net.http.HttpResponse<String> response = client.send(request,
                    java.net.http.HttpResponse.BodyHandlers.ofString());

            if (response.statusCode() >= 400) {
                log.warn("[DoiEnrich Broker] Backend returned {} for task {}", response.statusCode(), taskId);
            }
        } catch (Exception e) {
            log.warn("[DoiEnrich Broker] Failed to forward task {} to backend: {}", taskId, e.getMessage());
        }
    }

    private void forwardFailureToBackend(Long taskId, String doi, String error, String source) {
        try {
            java.net.http.HttpClient client = java.net.http.HttpClient.newHttpClient();
            String endpoint = "http://localhost:8080/api/doi-enrich-tasks/" + taskId + "/fail";

            Map<String, Object> body = Map.of(
                    "doi", doi != null ? doi : "",
                    "error", error != null ? error : "Unknown",
                    "source", source != null ? source : "Unknown");

            String json = new com.fasterxml.jackson.databind.ObjectMapper()
                    .writeValueAsString(body);

            java.net.http.HttpRequest request = java.net.http.HttpRequest.newBuilder()
                    .uri(java.net.URI.create(endpoint))
                    .header("Content-Type", "application/json")
                    .POST(java.net.http.HttpRequest.BodyPublishers.ofString(json))
                    .timeout(java.time.Duration.ofSeconds(10))
                    .build();

            client.send(request, java.net.http.HttpResponse.BodyHandlers.ofString());

        } catch (Exception e) {
            log.warn("[DoiEnrich Broker] Failed to forward failure for task {} to backend: {}", taskId, e.getMessage());
        }
    }
}

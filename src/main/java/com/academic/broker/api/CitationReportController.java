package com.academic.broker.api;

import com.fasterxml.jackson.databind.ObjectMapper;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;

import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.time.Duration;
import java.util.Map;
import java.util.concurrent.CompletableFuture;

/**
 * Broker endpoint for WoS Citation Report data.
 *
 * <p><b>The forward-to-backend leg has been turned off.</b> Previously
 * the broker forwarded everything posted here to the main backend's
 * {@code /api/wos/citation-report/sync} endpoint, which wrote directly
 * into {@code researcher_profile} + {@code staged_publication} — bypassing
 * the operator approval gate completely. The bridge already extracts the
 * citation-report data from the article-task's {@code rawData}; this
 * endpoint is kept only as an ack for the extension's POST so the
 * Chrome side doesn't see HTTP errors mid-flight.
 *
 * <h3>Contract:</h3>
 * <ul>
 *   <li>{@code POST /api/wos/citation-report/sync} — accepted, logged,
 *       and dropped. Returns 200 OK so the extension's retry loop quiets
 *       down.</li>
 * </ul>
 */
@Slf4j
@RestController
@RequestMapping("/api/wos/citation-report")
@RequiredArgsConstructor
public class CitationReportController {

    private final ObjectMapper objectMapper;

    @Value("${broker.backend-url:http://localhost:8080}")
    private String backendUrl;

    /**
     * Accepts Citation Report data from the Chrome extension. Logs and
     * returns 200 OK without forwarding — the bridge owns the
     * citation-report integration now (data flows through {@code
     * /api/tasks/{taskId}/complete} → {@code SyncRequestWorkerBridge}).
     */
    @PostMapping(value = "/sync", consumes = MediaType.APPLICATION_JSON_VALUE)
    public ResponseEntity<Map<String, Object>> syncCitationReport(
            @RequestBody Map<String, Object> body) {

        Object authorWosId = body.get("authorWosId");
        Object taskId = body.get("taskId");
        Object error = body.get("error");

        if (error != null) {
            log.warn("[CitationReport] Extension reported an error for author={} task={}: {}",
                    authorWosId, taskId, error);
        } else {
            log.debug("[CitationReport] Received data for author={} task={} (no-forward; bridge owns this now)",
                    authorWosId, taskId);
        }

        // Forwarding is disabled — see class-level Javadoc.
        return ResponseEntity.ok(Map.of("ok", true, "received", true, "forwarded", false));
    }

    /**
     * Forwards the citation report payload to the main backend Spring Boot app
     * asynchronously with 3-retry exponential backoff (1s, 3s, 9s).
     */
    private void forwardToBackendAsync(Map<String, Object> body) {
        CompletableFuture.runAsync(() -> {
            forwardWithRetry(() -> {
                String json = objectMapper.writeValueAsString(body);
                HttpClient client = HttpClient.newBuilder()
                        .connectTimeout(Duration.ofSeconds(10))
                        .build();

                HttpRequest request = HttpRequest.newBuilder()
                        .uri(URI.create(backendUrl + "/api/wos/citation-report/sync"))
                        .header("Content-Type", "application/json")
                        .POST(HttpRequest.BodyPublishers.ofString(json))
                        .timeout(Duration.ofSeconds(15))
                        .build();

                HttpResponse<String> response = client.send(request,
                        HttpResponse.BodyHandlers.ofString());

                if (response.statusCode() >= 400) {
                    throw new RuntimeException("Backend returned HTTP " + response.statusCode());
                }
                log.info("[CitationReport] Successfully forwarded to backend (HTTP {})",
                        response.statusCode());
            });
        });
    }

    private void forwardWithRetry(ForwardTask task) {
        int[] delays = {1000, 3000, 9000};
        for (int i = 0; i <= delays.length; i++) {
            try {
                task.execute();
                return;
            } catch (Exception e) {
                if (i == delays.length) {
                    log.error("[CitationReport] Failed to forward data after 3 retries: {}", e.getMessage());
                    return;
                }
                try {
                    Thread.sleep(delays[i]);
                } catch (InterruptedException ignored) {
                    Thread.currentThread().interrupt();
                }
            }
        }
    }

    @FunctionalInterface
    interface ForwardTask {
        void execute() throws Exception;
    }
}

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
 * <p>The Chrome extension sends citation report data here after scraping the
 * WoS citation-report page. The broker validates the payload and forwards it
 * asynchronously to the main backend system.</p>
 *
 * <h3>Contract:</h3>
 * <ul>
 *   <li>{@code POST /api/wos/citation-report/sync} — Extension sends scraped data</li>
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
     * Receives Citation Report data from the Chrome extension and forwards it
     * asynchronously to the main backend.
     *
     * @param body Raw payload: { authorWosId, taskId, researcherProfileStats, publications, error? }
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
            log.info("[CitationReport] Received data for author={} task={}", authorWosId, taskId);
        }

        // Forward to main backend asynchronously (non-blocking)
        forwardToBackendAsync(body);

        return ResponseEntity.ok(Map.of("ok", true, "received", true));
    }

    /**
     * Forwards the citation report payload to the main backend Spring Boot app
     * asynchronously so the broker response is not delayed.
     */
    private void forwardToBackendAsync(Map<String, Object> body) {
        CompletableFuture.runAsync(() -> {
            try {
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
                    log.warn("[CitationReport] Backend returned HTTP {} when forwarding data",
                            response.statusCode());
                } else {
                    log.info("[CitationReport] Successfully forwarded to backend (HTTP {})",
                            response.statusCode());
                }

            } catch (Exception e) {
                // Non-fatal: the data reached the broker successfully; backend unavailability
                // is logged but should not break the extension flow.
                log.warn("[CitationReport] Failed to forward data to backend: {}", e.getMessage());
            }
        });
    }
}

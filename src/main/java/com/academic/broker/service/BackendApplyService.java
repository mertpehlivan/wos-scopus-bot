package com.academic.broker.service;

import com.academic.broker.domain.SyncRequest;
import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.ObjectMapper;
import lombok.extern.slf4j.Slf4j;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Service;

import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.time.Duration;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

/**
 * Pushes approved {@link SyncRequest} payloads to the main backend's
 * {@code /api/v1/internal/apply-sync} endpoint, where they become permanent
 * data (ResearcherProfile + StagedPublication entries).
 *
 * <p>Runs as a background retry loop so transient backend outages don't
 * lose operator approvals. Each request is retried up to
 * {@link SyncRequestService#MAX_APPLY_ATTEMPTS} times before being parked
 * for manual investigation.
 */
@Slf4j
@Service
public class BackendApplyService {

    private static final HttpClient HTTP = HttpClient.newBuilder()
            .connectTimeout(Duration.ofSeconds(10))
            .build();

    @Value("${broker.backend-url}")
    private String backendUrl;

    @Value("${broker.backend-api-key:${broker.api-key}}")
    private String backendApiKey;

    private final SyncRequestService service;
    private final ObjectMapper objectMapper;

    public BackendApplyService(SyncRequestService service, ObjectMapper objectMapper) {
        this.service = service;
        this.objectMapper = objectMapper;
    }

    /** Try to push the given approval immediately. Falls back to scheduled retry on failure. */
    public boolean applyNow(SyncRequest req) {
        try {
            return doApply(req);
        } catch (Exception e) {
            service.recordApplyAttempt(req.getId(), e.getMessage());
            log.warn("[Apply] Immediate apply failed for {}: {}", req.getId(), e.getMessage());
            return false;
        }
    }

    /** Background retry — every 30 seconds, retry any unapplied approvals. */
    @Scheduled(fixedDelay = 30_000L, initialDelay = 30_000L)
    public void retryLoop() {
        List<SyncRequest> pending = service.findUnappliedApprovals();
        if (pending.isEmpty()) return;
        log.info("[Apply] Retrying {} unapplied approvals", pending.size());
        for (SyncRequest req : pending) {
            try {
                doApply(req);
            } catch (Exception e) {
                service.recordApplyAttempt(req.getId(), e.getMessage());
                log.warn("[Apply] Retry failed for {}: {}", req.getId(), e.getMessage());
            }
        }
    }

    private boolean doApply(SyncRequest req) throws Exception {
        Map<String, Object> body = new HashMap<>();
        body.put("syncRequestId", req.getId().toString());
        body.put("requesterUserId", req.getRequesterUserId().toString());
        body.put("origin", req.getOrigin().name());
        body.put("stagedData", req.getStagedData());
        body.put("editedData", req.getEditedData());
        body.put("approvedFields", req.getApprovedFields());
        body.put("reviewedByUserId", req.getReviewedByUserId() == null
                ? null : req.getReviewedByUserId().toString());
        body.put("reviewedAt", req.getReviewedAt() == null ? null : req.getReviewedAt().toString());
        body.put("reviewerNotes", req.getReviewerNotes());

        String json;
        try {
            json = objectMapper.writeValueAsString(body);
        } catch (JsonProcessingException e) {
            throw new RuntimeException("Apply payload serialization failed", e);
        }

        String url = trimTrailingSlash(backendUrl) + "/api/v1/internal/apply-sync";
        HttpRequest request = HttpRequest.newBuilder()
                .uri(URI.create(url))
                .header("Content-Type", "application/json")
                .header("X-Internal-Key", backendApiKey)
                .timeout(Duration.ofSeconds(30))
                .POST(HttpRequest.BodyPublishers.ofString(json))
                .build();

        HttpResponse<String> response = HTTP.send(request, HttpResponse.BodyHandlers.ofString());
        if (response.statusCode() >= 200 && response.statusCode() < 300) {
            service.markApplied(req.getId());
            log.info("[Apply] {} applied to backend (HTTP {})", req.getId(), response.statusCode());
            return true;
        } else {
            String error = "HTTP " + response.statusCode() + " — " + truncate(response.body());
            service.recordApplyAttempt(req.getId(), error);
            log.warn("[Apply] {} apply failed: {}", req.getId(), error);
            return false;
        }
    }

    private static String trimTrailingSlash(String s) {
        return s != null && s.endsWith("/") ? s.substring(0, s.length() - 1) : s;
    }

    private static String truncate(String s) {
        if (s == null) return "";
        return s.length() > 200 ? s.substring(0, 200) : s;
    }
}

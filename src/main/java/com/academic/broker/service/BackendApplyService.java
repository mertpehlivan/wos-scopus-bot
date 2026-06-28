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

    /**
     * Background retry — every 5 seconds, retry any unapplied approvals.
     * Previously 30s, which meant the dashboard sat on stale metric cards
     * for a full half-minute on every transient backend hiccup. 5s is short
     * enough to feel instant to the operator without overloading the backend.
     */
    @Scheduled(fixedDelay = 5_000L, initialDelay = 5_000L)
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
        // Contract: forwarded RAW — the broker does NO field-level merge.
        // The backend (ApplySyncService.mergeEdits + allowed()) is the single
        // authority that applies editedData over stagedData gated by
        // approvedFields. Keep these three keys in sync with that reader.
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

        // Multi-tenant: route the callback to the backend that opened THIS
        // request, with the token it supplied. Falls back to the global
        // broker.backend-url / backend-api-key for legacy requests that carry
        // no per-tenant routing info (single-tenant / not-yet-migrated).
        String targetBase = (req.getBackendBaseUrl() != null && !req.getBackendBaseUrl().isBlank())
                ? req.getBackendBaseUrl() : backendUrl;
        String targetToken = (req.getBackendCallbackToken() != null && !req.getBackendCallbackToken().isBlank())
                ? req.getBackendCallbackToken() : backendApiKey;
        String url = trimTrailingSlash(targetBase) + "/api/v1/internal/apply-sync";
        HttpRequest request = HttpRequest.newBuilder()
                .uri(URI.create(url))
                .header("Content-Type", "application/json")
                .header("X-Internal-Key", targetToken)
                .timeout(Duration.ofSeconds(30))
                .POST(HttpRequest.BodyPublishers.ofString(json))
                .build();

        HttpResponse<String> response = HTTP.send(request, HttpResponse.BodyHandlers.ofString());
        int code = response.statusCode();
        if (code >= 200 && code < 300) {
            service.markApplied(req.getId());
            log.info("[Apply] {} applied to backend (HTTP {})", req.getId(), code);
            return true;
        }
        String error = "HTTP " + code + " — " + truncate(response.body());
        if (code >= 400 && code < 500) {
            // Non-retryable: a 401 (bad X-Internal-Key / tenant token), 400
            // (malformed body) or 413 (too large) will NEVER succeed on retry.
            // Park immediately with a distinct signal instead of burning all 5
            // attempts and then silently abandoning it — config errors must be
            // diagnosable, not indistinguishable from a transient outage.
            service.parkApplyNonRetryable(req.getId(), error);
            log.error("[Apply] {} non-retryable apply rejection, parked: {}", req.getId(), error);
        } else {
            // 5xx / unexpected — retryable, keep the backoff loop going.
            service.recordApplyAttempt(req.getId(), error);
            log.warn("[Apply] {} apply failed (retryable): {}", req.getId(), error);
        }
        return false;
    }

    /**
     * Surfaces parked approvals — approved requests whose backend apply
     * permanently failed and dropped out of the retry loop. Without this they
     * are silently lost (stuck APPROVED + appliedToBackend=false). Logged at
     * ERROR every 5 min so monitoring/operators can act; the list is also
     * queryable via {@link SyncRequestService#findParkedApprovals()}.
     */
    @Scheduled(fixedDelay = 300_000L, initialDelay = 60_000L)
    public void warnParkedApprovals() {
        List<SyncRequest> parked = service.findParkedApprovals();
        if (parked.isEmpty()) return;
        log.error("[Apply] {} approved sync request(s) PARKED (backend apply failed permanently) — manual attention needed: {}",
                parked.size(), parked.stream().map(r -> r.getId().toString()).toList());
    }

    private static String trimTrailingSlash(String s) {
        return s != null && s.endsWith("/") ? s.substring(0, s.length() - 1) : s;
    }

    private static String truncate(String s) {
        if (s == null) return "";
        return s.length() > 200 ? s.substring(0, 200) : s;
    }
}

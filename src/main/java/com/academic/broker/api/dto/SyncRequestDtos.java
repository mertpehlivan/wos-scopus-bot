package com.academic.broker.api.dto;

import com.academic.broker.domain.SyncRequest;
import com.academic.broker.domain.SyncRequestOrigin;
import com.academic.broker.domain.SyncRequestStatus;
import lombok.Builder;
import lombok.Value;
import lombok.extern.jackson.Jacksonized;

import java.time.Instant;
import java.util.List;
import java.util.Map;
import java.util.UUID;

/**
 * Request/response shapes for the SyncRequest REST API.
 * Two views — {@link OperatorView} carries everything an operator needs to
 * review (full payload + provenance); {@link CallerView} is the lightweight
 * shape returned to the main backend / researcher (countdown only).
 */
public final class SyncRequestDtos {

    private SyncRequestDtos() {}

    /** Researcher / main-backend projection — countdown only, no scraped detail. */
    @Value @Builder
    public static class CallerView {
        UUID id;
        SyncRequestStatus status;
        SyncRequestOrigin origin;
        Instant requestedAt;
        Instant expiresAt;
        Long secondsRemaining;
        boolean appliedToBackend;
        Instant appliedAt;

        public static CallerView from(SyncRequest r) {
            Long remaining = null;
            if (r.getExpiresAt() != null) {
                remaining = Math.max(0,
                        r.getExpiresAt().getEpochSecond() - Instant.now().getEpochSecond());
            }
            return CallerView.builder()
                    .id(r.getId())
                    .status(r.getStatus())
                    .origin(r.getOrigin())
                    .requestedAt(r.getRequestedAt())
                    .expiresAt(r.getExpiresAt())
                    .secondsRemaining(remaining)
                    .appliedToBackend(r.isAppliedToBackend())
                    .appliedAt(r.getAppliedAt())
                    .build();
        }
    }

    @Value @Builder
    public static class OperatorView {
        UUID id;
        UUID requesterUserId;
        Map<String, Object> requesterProfileSnapshot;
        SyncRequestOrigin origin;
        /** Multi-tenant: which backend (institution) opened this request. The callback token is NEVER exposed. */
        String backendBaseUrl;
        SyncRequestStatus status;
        Instant requestedAt;
        Instant expiresAt;
        Long secondsRemaining;
        Map<String, Object> sourceProgress;
        Map<String, Object> stagedData;
        Map<String, Object> editedData;
        Map<String, Object> approvedFields;
        UUID reviewedByUserId;
        Instant reviewedAt;
        String reviewerNotes;
        String rejectionReason;
        String operatorNote;
        boolean appliedToBackend;
        Instant appliedAt;
        int applyAttempts;
        Instant updatedAt;
        Long version;

        public static OperatorView from(SyncRequest r) {
            Long remaining = null;
            if (r.getExpiresAt() != null) {
                remaining = Math.max(0,
                        r.getExpiresAt().getEpochSecond() - Instant.now().getEpochSecond());
            }
            return OperatorView.builder()
                    .id(r.getId())
                    .requesterUserId(r.getRequesterUserId())
                    .requesterProfileSnapshot(r.getRequesterProfileSnapshot())
                    .origin(r.getOrigin())
                    .backendBaseUrl(r.getBackendBaseUrl())
                    .status(r.getStatus())
                    .requestedAt(r.getRequestedAt())
                    .expiresAt(r.getExpiresAt())
                    .secondsRemaining(remaining)
                    .sourceProgress(r.getSourceProgress())
                    .stagedData(r.getStagedData())
                    .editedData(r.getEditedData())
                    .approvedFields(r.getApprovedFields())
                    .reviewedByUserId(r.getReviewedByUserId())
                    .reviewedAt(r.getReviewedAt())
                    .reviewerNotes(r.getReviewerNotes())
                    .rejectionReason(r.getRejectionReason())
                    .operatorNote(r.getOperatorNote())
                    .appliedToBackend(r.isAppliedToBackend())
                    .appliedAt(r.getAppliedAt())
                    .applyAttempts(r.getApplyAttempts())
                    .updatedAt(r.getUpdatedAt())
                    .version(r.getVersion())
                    .build();
        }
    }

    // ── Request DTOs ──
    // Marked @Jacksonized so Jackson can drive the Lombok-generated builder
    // when deserializing JSON. Without it, @Value + @Builder produces a
    // class with no usable constructor for Jackson and POSTs blow up with
    // "cannot deserialize from Object value (no delegate- or property-based Creator)".

    @Value @Builder @Jacksonized
    public static class CreateFromBackendReq {
        UUID requesterUserId;
        Map<String, Object> profileSnapshot;
        /** Multi-tenant: base URL of the calling backend (where to apply the approved sync back). */
        String backendBaseUrl;
        /** Multi-tenant: the X-Internal-Key the broker should present on the apply-sync callback. */
        String callbackToken;
    }

    @Value @Builder @Jacksonized
    public static class CreateManualReq {
        UUID requesterUserId;
        Map<String, Object> profileSnapshot;
        Map<String, Object> stagedData;
        String operatorNote;
        /** Multi-tenant: which registered backend this manual sync targets (its base URL). */
        String backendBaseUrl;
    }

    @Value @Builder @Jacksonized
    public static class EditReq {
        Map<String, Object> editedData;
        Map<String, Object> approvedFields;
        String operatorNote;
    }

    @Value @Builder @Jacksonized
    public static class ApproveReq { String notes; }

    @Value @Builder @Jacksonized
    public static class RejectReq { String reason; }

    @Value @Builder @Jacksonized
    public static class BulkActionReq {
        List<UUID> ids;
        String reason;       // for reject
        String notes;        // for approve
    }

    @Value @Builder @Jacksonized
    public static class LoginReq {
        String username;
        String password;
    }

    // Response DTO — only ever serialized, but @Jacksonized doesn't hurt
    // and makes it round-trippable for tests.
    @Value @Builder @Jacksonized
    public static class LoginResp {
        String token;
        UUID userId;
        String username;
        String displayName;
    }
}

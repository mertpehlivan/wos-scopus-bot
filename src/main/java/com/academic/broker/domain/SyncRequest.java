package com.academic.broker.domain;

import jakarta.persistence.*;
import lombok.AccessLevel;
import lombok.AllArgsConstructor;
import lombok.Builder;
import lombok.Getter;
import lombok.NoArgsConstructor;
import lombok.Setter;
import org.hibernate.annotations.CreationTimestamp;
import org.hibernate.annotations.JdbcTypeCode;
import org.hibernate.type.SqlTypes;

import java.time.Instant;
import java.util.Map;
import java.util.UUID;

/**
 * A single sync operation pending operator review. The broker is the
 * <em>staging area</em> — worker output and manual entries land here first,
 * the operator panel reviews/edits/approves, and only then does the data
 * land on the main backend's persistent tables.
 *
 * <p>Per-source data + per-publication entries live in {@link #stagedData}.
 * Operator overrides (if any) live in {@link #editedData}. The merge that
 * goes to the main backend on approve uses {@code editedData ?? stagedData}
 * filtered by {@link #approvedFields}.
 */
@Entity
@Table(name = "sync_requests", indexes = {
        @Index(name = "idx_syncreq_user", columnList = "requester_user_id"),
        @Index(name = "idx_syncreq_status", columnList = "status"),
        @Index(name = "idx_syncreq_expires", columnList = "expires_at")
})
@Getter
@Setter
@Builder
@NoArgsConstructor
@AllArgsConstructor(access = AccessLevel.PRIVATE)
public class SyncRequest {

    @Id
    @GeneratedValue(strategy = GenerationType.UUID)
    private UUID id;

    /** UUID of the researcher in the main backend. Opaque to the broker. */
    @Column(name = "requester_user_id", nullable = false)
    private UUID requesterUserId;

    /**
     * Snapshot of the researcher's profile (name, ORCID, scopusId, publonsId,
     * googleScholarId, etc.) captured at request time. Lets the operator panel
     * render a useful header without round-tripping to the main backend.
     */
    @JdbcTypeCode(SqlTypes.JSON)
    @Column(name = "requester_profile_snapshot", columnDefinition = "jsonb")
    private Map<String, Object> requesterProfileSnapshot;

    @Enumerated(EnumType.STRING)
    @Column(nullable = false, length = 16)
    private SyncRequestOrigin origin;

    @Enumerated(EnumType.STRING)
    @Column(nullable = false, length = 32)
    private SyncRequestStatus status;

    @CreationTimestamp
    @Column(name = "requested_at", nullable = false, updatable = false)
    private Instant requestedAt;

    /**
     * Hard SLA deadline. For WORKER origin, set when scrape completes
     * (PENDING_SCRAPE → READY_FOR_REVIEW). For MANUAL origin, set on save.
     * A scheduled job marks anything past this as EXPIRED.
     */
    @Column(name = "expires_at")
    private Instant expiresAt;

    /** Per-source progress, e.g. {"WOS":"OK","SCOPUS":"FAILED"}. */
    @JdbcTypeCode(SqlTypes.JSON)
    @Column(name = "source_progress", columnDefinition = "jsonb")
    private Map<String, Object> sourceProgress;

    /** Canonical scraped/entered payload (per-source metrics + publications). */
    @JdbcTypeCode(SqlTypes.JSON)
    @Column(name = "staged_data", columnDefinition = "jsonb")
    private Map<String, Object> stagedData;

    /** Operator overrides on top of {@link #stagedData}. */
    @JdbcTypeCode(SqlTypes.JSON)
    @Column(name = "edited_data", columnDefinition = "jsonb")
    private Map<String, Object> editedData;

    /** Field-level approval mask — what to merge on approve. */
    @JdbcTypeCode(SqlTypes.JSON)
    @Column(name = "approved_fields", columnDefinition = "jsonb")
    private Map<String, Object> approvedFields;

    /** Operator user id from {@code operator_users} who reviewed this. */
    @Column(name = "reviewed_by_user_id")
    private UUID reviewedByUserId;

    @Column(name = "reviewed_at")
    private Instant reviewedAt;

    @Column(name = "reviewer_notes", length = 2000)
    private String reviewerNotes;

    @Column(name = "rejection_reason", length = 2000)
    private String rejectionReason;

    /** Free-text "why I created this manually" — audit. */
    @Column(name = "operator_note", length = 2000)
    private String operatorNote;

    /**
     * Once APPROVED, set to true after successful POST to main backend.
     * Lets the broker retry the webhook on transient backend outages.
     */
    @Column(name = "applied_to_backend", nullable = false)
    @Builder.Default
    private boolean appliedToBackend = false;

    @Column(name = "applied_at")
    private Instant appliedAt;

    /** Number of times the apply-to-backend webhook has been attempted. */
    @Column(name = "apply_attempts", nullable = false)
    @Builder.Default
    private int applyAttempts = 0;

    @Column(name = "updated_at", nullable = false)
    private Instant updatedAt;

    @Version
    private Long version;

    @PrePersist
    void onCreate() {
        if (updatedAt == null) updatedAt = Instant.now();
    }

    @PreUpdate
    void onUpdate() {
        updatedAt = Instant.now();
    }

    public void touch() {
        this.updatedAt = Instant.now();
    }
}

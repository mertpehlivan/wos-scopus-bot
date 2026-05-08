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
 * Immutable audit trail of every state change made to a {@link SyncRequest}.
 * Lets us answer "who approved this and when?", "how long did the operator
 * take to respond?", "which fields were edited?".
 */
@Entity
@Table(name = "sync_audit_log", indexes = {
        @Index(name = "idx_audit_request", columnList = "sync_request_id"),
        @Index(name = "idx_audit_actor", columnList = "actor_user_id"),
        @Index(name = "idx_audit_created", columnList = "created_at")
})
@Getter
@Setter
@Builder
@NoArgsConstructor
@AllArgsConstructor(access = AccessLevel.PRIVATE)
public class SyncAuditLog {

    @Id
    @GeneratedValue(strategy = GenerationType.IDENTITY)
    private Long id;

    @Column(name = "sync_request_id", nullable = false)
    private UUID syncRequestId;

    /** Operator user id, or null for system actions (auto-expiry, worker). */
    @Column(name = "actor_user_id")
    private UUID actorUserId;

    /** "WORKER", "OPERATOR", "SYSTEM". */
    @Column(name = "actor_kind", nullable = false, length = 16)
    private String actorKind;

    /** Action verb: CREATE, EDIT, APPROVE, REJECT, EXPIRE, MANUAL_FILL, RETRY, APPLY_TO_BACKEND. */
    @Column(nullable = false, length = 32)
    private String action;

    /** Optional snapshot of what changed (field deltas, status transitions). */
    @JdbcTypeCode(SqlTypes.JSON)
    @Column(columnDefinition = "jsonb")
    private Map<String, Object> details;

    @CreationTimestamp
    @Column(name = "created_at", nullable = false, updatable = false)
    private Instant createdAt;
}

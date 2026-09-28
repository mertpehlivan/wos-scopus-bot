package com.academic.broker.domain;

import jakarta.persistence.Column;
import jakarta.persistence.Entity;
import jakarta.persistence.EnumType;
import jakarta.persistence.Enumerated;
import jakarta.persistence.GeneratedValue;
import jakarta.persistence.GenerationType;
import jakarta.persistence.Id;
import jakarta.persistence.Table;
import jakarta.persistence.PrePersist;
import jakarta.persistence.Version;
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

@Entity
@Table(name = "article_tasks")
@Getter
@Setter
@Builder
@NoArgsConstructor
@AllArgsConstructor(access = AccessLevel.PRIVATE)
public class ArticleTask {

    @Id
    @GeneratedValue(strategy = GenerationType.IDENTITY)
    private Long id;

    @Enumerated(EnumType.STRING)
    @Column(name = "target_source", nullable = false, length = 20)
    private TargetSource targetSource;

    @Column(name = "external_id", nullable = false, length = 255)
    private String externalId;

    /**
     * The exact browser URL the Chrome extension worker should open to start
     * scraping.
     * If null the worker falls back to constructing the URL from externalId.
     */
    @Column(name = "redirect_url", length = 500)
    private String redirectUrl;

    /**
     * Determines the scope of work: METRICS_ONLY or FULL_SCRAPE.
     * Defaults to FULL_SCRAPE for backward compatibility.
     */
    @Enumerated(EnumType.STRING)
    @Column(name = "task_type", nullable = false, length = 20)
    @Builder.Default
    private TaskType taskType = TaskType.FULL_SCRAPE;

    @Enumerated(EnumType.STRING)
    @Column(nullable = false, length = 20)
    private TaskStatus status;

    /**
     * Author-level metrics (h-index, publications, citations) stored as JSONB.
     */
    @JdbcTypeCode(SqlTypes.JSON)
    @Column(name = "author_metrics_data", columnDefinition = "jsonb")
    private Map<String, Object> authorMetricsData;

    /**
     * Raw scraped payload stored as JSONB in PostgreSQL.
     */
    @JdbcTypeCode(SqlTypes.JSON)
    @Column(name = "raw_data", columnDefinition = "jsonb")
    private Map<String, Object> rawData;

    /**
     * Optional link to the {@code SyncRequest} this task was created for.
     * When set, the task processor writes its scraped output into the
     * sync request's stagedData instead of (or in addition to) the legacy
     * direct-to-backend path.
     */
    @Column(name = "sync_request_id")
    private UUID syncRequestId;

    /**
     * Why the task last failed (or was re-queued by the watchdog). Sent by the
     * worker in the {@code /fail} body; previously discarded, which made stalls
     * undiagnosable from the DB. Nullable — added column, no backfill.
     */
    @Column(name = "error_message", length = 1000)
    private String errorMessage;

    /** When a worker last claimed the task (PENDING → PROCESSING via poll). */
    @Column(name = "started_at")
    private Instant startedAt;

    /** When the task last reached a terminal state (COMPLETED / FAILED). */
    @Column(name = "finished_at")
    private Instant finishedAt;

    @CreationTimestamp
    @Column(name = "created_at", nullable = false, updatable = false)
    private Instant createdAt;

    @Column(name = "updated_at", nullable = false)
    private Instant updatedAt;

    @Version
    private Long version;

    @PrePersist
    void setUpdatedAtOnCreate() {
        if (updatedAt == null) {
            updatedAt = Instant.now();
        }
    }

    public void touch() {
        this.updatedAt = Instant.now();
    }
}

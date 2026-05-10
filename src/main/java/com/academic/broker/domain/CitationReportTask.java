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

/**
 * Standalone task for scraping a researcher's WoS Citation Report after
 * the main author scrape has finished.
 *
 * <p>The Chrome extension's content script discovers a "View citation
 * report" link on the WoS author profile page and reports its URL via
 * {@code CITATION_REPORT_LINK_SAVED}. Previously the URL was only kept
 * in an in-memory map ({@code savedCitationReportLinks}) on the worker
 * service-worker; if Chrome restarted or the worker reloaded, the link
 * was lost and there was no way to retry. Persisting it as a
 * {@code CitationReportTask} lets:
 *
 * <ul>
 *   <li>The worker pick the URL up after restart.</li>
 *   <li>The operator panel show "Atıf raporu çekildi / hata / bekliyor"
 *       and offer a "Tekrar dene" button.</li>
 *   <li>The bridge gate {@code READY_FOR_REVIEW} on this task too — the
 *       operator shouldn't see a sync as ready when the citation report
 *       is still pending.</li>
 * </ul>
 *
 * <p>Modeled after {@link PlumxTask} (independent task table polled by
 * its own worker queue).
 */
@Entity
@Table(name = "citation_report_tasks")
@Getter
@Setter
@Builder
@NoArgsConstructor
@AllArgsConstructor(access = AccessLevel.PRIVATE)
public class CitationReportTask {

    @Id
    @GeneratedValue(strategy = GenerationType.IDENTITY)
    private Long id;

    /**
     * The WoS Citation Report page URL captured during the author scrape.
     * The worker navigates to this and runs {@code wos_citation_report_content.js}.
     */
    @Column(name = "citation_report_url", nullable = false, length = 2000)
    private String citationReportUrl;

    /**
     * The researcher's WoS author id (e.g. {@code "K-1234-2018"}). Used
     * by the main backend to match the citation report against an existing
     * researcher profile via {@code publons_id}.
     */
    @Column(name = "author_wos_id", length = 100)
    private String authorWosId;

    @Enumerated(EnumType.STRING)
    @Column(nullable = false, length = 20)
    private TaskStatus status;

    /**
     * Raw citation report payload as scraped by the extension. Shape:
     * <pre>
     * {
     *   "researcherProfileStats": {
     *     "overallTotalCitations": ...,
     *     "totalAveragePerYear": ...,
     *     "yearlyStats": [{"year": ..., "totalCitations": ...}, ...]
     *   },
     *   "publications": [
     *     {"wosId": ..., "title": ..., "totalCitations": ...,
     *      "citationsByYear": [...]},
     *     ...
     *   ]
     * }
     * </pre>
     */
    @JdbcTypeCode(SqlTypes.JSON)
    @Column(name = "raw_data", columnDefinition = "jsonb")
    private Map<String, Object> rawData;

    /**
     * Human-readable error captured when the worker fails (timeout,
     * injection failure, scrape exception). Surfaced to the operator
     * panel so the operator knows whether to retry or proceed.
     */
    @Column(name = "error_message", length = 1000)
    private String errorMessage;

    /**
     * FK to the {@link SyncRequest} this citation report belongs to.
     * Always populated for tasks created by the bridge after a WOS
     * author scrape; never null in practice.
     */
    @Column(name = "sync_request_id", nullable = false)
    private UUID syncRequestId;

    /**
     * The originating WOS author scrape's task id. Kept for traceability
     * and for the bridge to fold the citation report into the right
     * stagedData.WOS source blob.
     */
    @Column(name = "article_task_id")
    private UUID articleTaskId;

    /**
     * Number of times the operator has hit "Tekrar Dene" on this task.
     * The retry endpoint flips status back to PENDING and bumps this.
     * Useful for surfacing "3rd attempt failed" in the panel UI.
     */
    @Column(name = "retry_count", nullable = false)
    @Builder.Default
    private int retryCount = 0;

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

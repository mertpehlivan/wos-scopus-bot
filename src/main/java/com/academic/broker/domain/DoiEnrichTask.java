package com.academic.broker.domain;

import jakarta.persistence.*;
import lombok.*;
import org.hibernate.annotations.CreationTimestamp;
import org.hibernate.annotations.JdbcTypeCode;
import org.hibernate.type.SqlTypes;

import java.time.Instant;
import java.util.Map;

/**
 * Broker-side task entity for DOI-based enrichment.
 * Supports two sources: WOS (WoS Smart-Search) and SCHOLAR (Scholar DOI
 * lookup).
 *
 * Mirrors the {@link PlumxTask} pattern for parallel processing.
 */
@Entity
@Table(name = "doi_enrich_tasks")
@Getter
@Setter
@Builder
@NoArgsConstructor
@AllArgsConstructor(access = AccessLevel.PRIVATE)
public class DoiEnrichTask {

    @Id
    @GeneratedValue(strategy = GenerationType.IDENTITY)
    private Long id;

    /** The DOI being enriched */
    @Column(name = "doi", nullable = false, length = 500)
    private String doi;

    /**
     * Source of enrichment: WOS or SCHOLAR.
     * Both source types are stored in the same table for simplicity.
     */
    @Column(name = "source", nullable = false, length = 20)
    private String source;

    @Enumerated(EnumType.STRING)
    @Column(nullable = false, length = 20)
    private TaskStatus status;

    /**
     * Raw scraped payload stored as JSONB.
     * WOS: { abstract, wosCitations, quartile, indexType, impactFactor }
     * SCHOLAR: { scholarCitations, abstract }
     */
    @JdbcTypeCode(SqlTypes.JSON)
    @Column(name = "raw_data", columnDefinition = "jsonb")
    private Map<String, Object> rawData;

    /** Error message if task failed */
    @Column(name = "error_message", length = 1000)
    private String errorMessage;

    @CreationTimestamp
    @Column(name = "created_at", nullable = false, updatable = false)
    private Instant createdAt;

    @Column(name = "updated_at", nullable = false)
    private Instant updatedAt;

    @Version
    private Long version;

    @PrePersist
    void onPrePersist() {
        if (updatedAt == null)
            updatedAt = Instant.now();
    }

    public void touch() {
        this.updatedAt = Instant.now();
    }
}

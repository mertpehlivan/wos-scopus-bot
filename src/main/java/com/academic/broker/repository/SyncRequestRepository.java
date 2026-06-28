package com.academic.broker.repository;

import com.academic.broker.domain.SyncRequest;
import com.academic.broker.domain.SyncRequestStatus;
import org.springframework.data.domain.Page;
import org.springframework.data.domain.Pageable;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Modifying;
import org.springframework.data.jpa.repository.Query;
import org.springframework.data.repository.query.Param;

import java.time.Instant;
import java.util.List;
import java.util.Optional;
import java.util.UUID;

public interface SyncRequestRepository extends JpaRepository<SyncRequest, UUID> {

    /** Single active request per researcher — guards against duplicate submissions. */
    @Query("SELECT r FROM SyncRequest r WHERE r.requesterUserId = :userId "
            + "AND r.status IN (com.academic.broker.domain.SyncRequestStatus.DRAFT, "
            + "com.academic.broker.domain.SyncRequestStatus.PENDING_SCRAPE, "
            + "com.academic.broker.domain.SyncRequestStatus.READY_FOR_REVIEW, "
            + "com.academic.broker.domain.SyncRequestStatus.FAILED) "
            + "ORDER BY r.requestedAt DESC")
    Optional<SyncRequest> findActiveForUser(@Param("userId") UUID userId);

    /** Operator queue: non-terminal first, sorted by SLA urgency (least time first). */
    @Query("SELECT r FROM SyncRequest r WHERE r.status IN :statuses "
            + "ORDER BY CASE WHEN r.expiresAt IS NULL THEN 1 ELSE 0 END, r.expiresAt ASC")
    Page<SyncRequest> findByStatusIn(@Param("statuses") List<SyncRequestStatus> statuses,
                                     Pageable pageable);

    Page<SyncRequest> findByStatusOrderByRequestedAtDesc(SyncRequestStatus status, Pageable pageable);

    Page<SyncRequest> findAllByOrderByRequestedAtDesc(Pageable pageable);

    /** Used by the expiry job. */
    @Query("SELECT r FROM SyncRequest r WHERE r.status IN :statuses AND r.expiresAt IS NOT NULL "
            + "AND r.expiresAt < :cutoff")
    List<SyncRequest> findOverdue(@Param("statuses") List<SyncRequestStatus> statuses,
                                  @Param("cutoff") Instant cutoff);

    /**
     * Still scraping but created before {@code cutoff} — candidates for the
     * scrape-start watchdog. A request whose worker never engaged within the
     * watchdog window would otherwise hang in PENDING_SCRAPE for the full 24h.
     */
    @Query("SELECT r FROM SyncRequest r WHERE r.status = com.academic.broker.domain.SyncRequestStatus.PENDING_SCRAPE "
            + "AND r.requestedAt < :cutoff")
    List<SyncRequest> findStalledScrapes(@Param("cutoff") Instant cutoff);

    /** Approved-but-not-yet-applied — used by the apply-to-backend retry loop. */
    @Query("SELECT r FROM SyncRequest r WHERE r.status = com.academic.broker.domain.SyncRequestStatus.APPROVED "
            + "AND r.appliedToBackend = false AND r.applyAttempts < :maxAttempts "
            + "ORDER BY r.reviewedAt ASC")
    List<SyncRequest> findUnappliedApprovals(@Param("maxAttempts") int maxAttempts);

    /**
     * Approved-but-exhausted: apply to backend failed {@code maxAttempts}
     * times so the request dropped out of {@link #findUnappliedApprovals}.
     * Without surfacing these they are silently lost (stuck APPROVED +
     * appliedToBackend=false) — used by the parked-approvals warner/alert.
     */
    @Query("SELECT r FROM SyncRequest r WHERE r.status = com.academic.broker.domain.SyncRequestStatus.APPROVED "
            + "AND r.appliedToBackend = false AND r.applyAttempts >= :maxAttempts "
            + "ORDER BY r.reviewedAt ASC")
    List<SyncRequest> findParkedApprovals(@Param("maxAttempts") int maxAttempts);

    long countByStatus(SyncRequestStatus status);

    long countByStatusIn(List<SyncRequestStatus> statuses);

    /** Returns reviewed sync requests since the given cutoff (for performance widgets). */
    @Query("SELECT r FROM SyncRequest r WHERE r.reviewedAt IS NOT NULL AND r.reviewedAt >= :cutoff")
    List<SyncRequest> findReviewedSince(@Param("cutoff") Instant cutoff);

    /** Atomic state transition. Use sparingly — JPA dirty-check covers most cases. */
    @Modifying
    @Query("UPDATE SyncRequest r SET r.status = :next, r.updatedAt = CURRENT_TIMESTAMP "
            + "WHERE r.id = :id AND r.status = :expected")
    int compareAndSetStatus(@Param("id") UUID id,
                            @Param("expected") SyncRequestStatus expected,
                            @Param("next") SyncRequestStatus next);
}

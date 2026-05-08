package com.academic.broker.repository;

import com.academic.broker.domain.PlumxTask;
import com.academic.broker.domain.TaskStatus;
import jakarta.persistence.LockModeType;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Lock;
import org.springframework.data.domain.Pageable;
import org.springframework.data.jpa.repository.Modifying;
import org.springframework.data.jpa.repository.Query;
import org.springframework.data.repository.query.Param;

import java.time.Instant;
import java.util.List;
import java.util.Optional;
import java.util.UUID;

public interface PlumxTaskRepository extends JpaRepository<PlumxTask, Long> {

    boolean existsByDoiAndStatusIn(String doi, List<TaskStatus> statuses);

    Optional<PlumxTask> findFirstByDoiAndStatusIn(String doi, List<TaskStatus> statuses);

    /**
     * All PlumX tasks tagged with a given sync request id. Used by the
     * worker bridge to gate "READY_FOR_REVIEW" transition until every PlumX
     * fan-out submitted for the request has reached a terminal status.
     */
    List<PlumxTask> findBySyncRequestId(UUID syncRequestId);

    /**
     * Deletes PlumX tasks for a sync request that are still PENDING /
     * PROCESSING. Called when the request reaches a terminal state so
     * stragglers don't keep the worker busy after the operator closed it.
     */
    @Modifying
    @Query("DELETE FROM PlumxTask t WHERE t.syncRequestId = :reqId AND t.status IN :statuses")
    int deleteBySyncRequestIdAndStatusIn(@Param("reqId") UUID syncRequestId,
                                          @Param("statuses") List<TaskStatus> statuses);

    /** PlumX tasks not linked to any active (PENDING_SCRAPE) sync request. */
    @Query("SELECT t FROM PlumxTask t WHERE t.status IN :statuses AND " +
           "(t.syncRequestId IS NULL OR t.syncRequestId NOT IN " +
           "  (SELECT s.id FROM SyncRequest s WHERE s.status = com.academic.broker.domain.SyncRequestStatus.PENDING_SCRAPE))")
    List<PlumxTask> findOrphans(@Param("statuses") List<TaskStatus> statuses);

    /**
     * Poll a batch of PENDING PlumX tasks and lock them for processing.
     *
     * <p>Same priority-queue semantics as {@code ArticleTaskRepository
     * .findOnePendingBySourceForUpdate}: tasks linked to a sync request
     * with the closest {@code expiresAt} go first; orphan tasks (no
     * syncRequestId) come last, ordered by createdAt FIFO.
     */
    @Lock(LockModeType.PESSIMISTIC_WRITE)
    @Query("""
        SELECT t FROM PlumxTask t
        WHERE t.status = com.academic.broker.domain.TaskStatus.PENDING
        ORDER BY
          CASE WHEN t.syncRequestId IS NULL THEN 1 ELSE 0 END ASC,
          (SELECT s.expiresAt FROM SyncRequest s WHERE s.id = t.syncRequestId) ASC,
          t.createdAt ASC
        """)
    List<PlumxTask> findPendingForUpdate(Pageable pageable);

    @Lock(LockModeType.PESSIMISTIC_WRITE)
    @Query("SELECT t FROM PlumxTask t WHERE t.id = :id")
    Optional<PlumxTask> findByIdForUpdate(@Param("id") Long id);

    /**
     * Claim all COMPLETED PlumX tasks atomically — race condition fix.
     */
    @Lock(LockModeType.PESSIMISTIC_WRITE)
    @Query("SELECT t FROM PlumxTask t WHERE t.status = com.academic.broker.domain.TaskStatus.COMPLETED ORDER BY t.createdAt ASC")
    List<PlumxTask> findCompletedForConsume();

    @Query("SELECT t FROM PlumxTask t WHERE t.status = com.academic.broker.domain.TaskStatus.PROCESSING AND t.updatedAt < :cutoff")
    List<PlumxTask> findStuckProcessing(@Param("cutoff") Instant cutoff);

    Optional<PlumxTask> findTopByDoiOrderByIdDesc(String doi);

    @Modifying
    @Query("UPDATE PlumxTask t SET t.status = 'PENDING', t.updatedAt = CURRENT_TIMESTAMP WHERE t.status = 'FAILED'")
    int resetAllFailedToPending();

    @Modifying
    @Query("DELETE FROM PlumxTask")
    int deleteAllPlumx();

    /**
     * Deletes all PENDING PlumX tasks. Used to clear leftover tasks from a
     * prior sync so they don't keep the worker busy after a new sync starts
     * or after the user cancels.
     */
    @Modifying
    @Query("DELETE FROM PlumxTask t WHERE t.status = com.academic.broker.domain.TaskStatus.PENDING")
    int deletePendingPlumx();
}

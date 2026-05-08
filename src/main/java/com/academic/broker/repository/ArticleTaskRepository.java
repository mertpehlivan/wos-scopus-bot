package com.academic.broker.repository;

import com.academic.broker.domain.ArticleTask;
import com.academic.broker.domain.TaskStatus;
import com.academic.broker.domain.TargetSource;
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

public interface ArticleTaskRepository extends JpaRepository<ArticleTask, Long> {

    boolean existsByTargetSourceAndExternalIdAndStatusIn(
            TargetSource targetSource,
            String externalId,
            List<TaskStatus> statuses);

    @Modifying
    @Query("DELETE FROM ArticleTask t WHERE t.targetSource = :targetSource AND t.externalId = :externalId AND t.status IN :statuses")
    void deleteByTargetSourceAndExternalIdAndStatusIn(
            @Param("targetSource") TargetSource targetSource,
            @Param("externalId") String externalId,
            @Param("statuses") List<TaskStatus> statuses);

    /**
     * Worker poll: select one PENDING task for the given source and lock it
     * ({@code PESSIMISTIC_WRITE}) to avoid race conditions. Caller must run
     * in a transaction and then update status to PROCESSING.
     *
     * <p>Ordering — <b>least-time-remaining first</b>. Tasks attached to a
     * sync request are sorted by the request's {@code expiresAt} ASC, so
     * the request closest to its 24h SLA deadline gets serviced first;
     * tasks with no sync request id (legacy / one-off refreshes) come
     * after, ordered by their own createdAt for FIFO fairness.
     *
     * <p>The {@code COALESCE} returns the parent request's expiresAt
     * when present, falling back to the task's own createdAt — which is
     * a far-past timestamp relative to expiresAt, putting orphan tasks
     * at the front. We don't want orphans first; the
     * {@code CASE WHEN ... IS NULL} prefix bumps them to the end.
     */
    @Lock(LockModeType.PESSIMISTIC_WRITE)
    @Query("""
        SELECT t FROM ArticleTask t
        WHERE t.targetSource = :source
          AND t.status = com.academic.broker.domain.TaskStatus.PENDING
        ORDER BY
          CASE WHEN t.syncRequestId IS NULL THEN 1 ELSE 0 END ASC,
          (SELECT s.expiresAt FROM SyncRequest s WHERE s.id = t.syncRequestId) ASC,
          t.createdAt ASC
        """)
    List<ArticleTask> findOnePendingBySourceForUpdate(@Param("source") TargetSource source, Pageable pageable);

    @Lock(LockModeType.PESSIMISTIC_WRITE)
    @Query("SELECT t FROM ArticleTask t WHERE t.id = :id")
    Optional<ArticleTask> findByIdForUpdate(@Param("id") Long id);

    /**
     * Claim all COMPLETED tasks atomically — PESSIMISTIC_WRITE prevents two concurrent
     * consume() calls from returning the same tasks (race condition fix).
     */
    @Lock(LockModeType.PESSIMISTIC_WRITE)
    @Query("SELECT t FROM ArticleTask t WHERE t.status = com.academic.broker.domain.TaskStatus.COMPLETED ORDER BY t.createdAt ASC")
    List<ArticleTask> findCompletedForConsume();

    /**
     * Find tasks stuck in PROCESSING longer than the given cutoff (for timeout
     * job).
     */
    @Query("SELECT t FROM ArticleTask t WHERE t.status = com.academic.broker.domain.TaskStatus.PROCESSING AND t.updatedAt < :cutoff")
    List<ArticleTask> findStuckProcessing(@Param("cutoff") Instant cutoff);

    /**
     * Returns the most recent task for a given source+externalId (any status).
     * Used by GET /api/tasks/status to check task history.
     */
    Optional<ArticleTask> findTopByTargetSourceAndExternalIdOrderByIdDesc(
            TargetSource targetSource,
            String externalId);

    @Modifying
    @Query("UPDATE ArticleTask t SET t.status = 'PENDING', t.updatedAt = CURRENT_TIMESTAMP WHERE t.targetSource = :source AND t.status = 'FAILED'")
    int resetFailedToPendingBySource(@Param("source") TargetSource source);

    @Modifying
    @Query("DELETE FROM ArticleTask t WHERE t.targetSource = :source")
    int deleteAllBySource(@Param("source") TargetSource source);

    @Modifying
    @Query("DELETE FROM ArticleTask t")
    int deleteAllTasks();

    /**
     * Wipes all PENDING article tasks. PROCESSING ones are preserved so the
     * worker can finish what it has in flight without confusing it with a
     * sudden missing-row.
     */
    @Modifying
    @Query("DELETE FROM ArticleTask t WHERE t.status = com.academic.broker.domain.TaskStatus.PENDING")
    int deletePendingArticles();

    /** All article-tasks linked to a given sync request. */
    List<ArticleTask> findBySyncRequestId(java.util.UUID syncRequestId);

    /**
     * Deletes article-tasks for a given sync request that are still PENDING
     * or PROCESSING. Used when the request transitions to a terminal state
     * (APPROVED / REJECTED / EXPIRED) so the worker doesn't keep scraping
     * for a sync the operator already closed.
     */
    @Modifying
    @Query("DELETE FROM ArticleTask t WHERE t.syncRequestId = :reqId AND t.status IN :statuses")
    int deleteBySyncRequestIdAndStatusIn(@Param("reqId") java.util.UUID syncRequestId,
                                          @Param("statuses") List<TaskStatus> statuses);

    /**
     * Article-tasks that are NOT linked to any sync request still in
     * PENDING_SCRAPE state. These are leftovers from approved / rejected /
     * expired requests, or from one-off operator refreshes whose sync
     * request never opened. Used by ensureCleanSlate to wipe them when a
     * new request starts.
     */
    @Query("SELECT t FROM ArticleTask t WHERE t.status IN :statuses AND " +
           "(t.syncRequestId IS NULL OR t.syncRequestId NOT IN " +
           "  (SELECT s.id FROM SyncRequest s WHERE s.status = com.academic.broker.domain.SyncRequestStatus.PENDING_SCRAPE))")
    List<ArticleTask> findOrphans(@Param("statuses") List<TaskStatus> statuses);
}

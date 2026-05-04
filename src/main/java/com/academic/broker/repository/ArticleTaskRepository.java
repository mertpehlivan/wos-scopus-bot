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
     * (PESSIMISTIC_WRITE)
     * to avoid race conditions. Caller must run in a transaction and then update
     * status to PROCESSING.
     */
    @Lock(LockModeType.PESSIMISTIC_WRITE)
    @Query("SELECT t FROM ArticleTask t WHERE t.targetSource = :source AND t.status = com.academic.broker.domain.TaskStatus.PENDING ORDER BY t.createdAt ASC")
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
}

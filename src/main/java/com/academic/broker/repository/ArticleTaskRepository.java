package com.academic.broker.repository;

import com.academic.broker.domain.ArticleTask;
import com.academic.broker.domain.TaskStatus;
import com.academic.broker.domain.TargetSource;
import jakarta.persistence.LockModeType;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Lock;
import org.springframework.data.domain.Pageable;
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

    List<ArticleTask> findByStatusOrderByCreatedAtAsc(TaskStatus status);

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
}

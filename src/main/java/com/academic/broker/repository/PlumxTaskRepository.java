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

public interface PlumxTaskRepository extends JpaRepository<PlumxTask, Long> {

    boolean existsByDoiAndStatusIn(String doi, List<TaskStatus> statuses);

    /**
     * Poll a batch of PENDING PlumX tasks and lock them for processing.
     */
    @Lock(LockModeType.PESSIMISTIC_WRITE)
    @Query("SELECT t FROM PlumxTask t WHERE t.status = com.academic.broker.domain.TaskStatus.PENDING ORDER BY t.createdAt ASC")
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

package com.academic.broker.repository;

import com.academic.broker.domain.PlumxTask;
import com.academic.broker.domain.TaskStatus;
import jakarta.persistence.LockModeType;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Lock;
import org.springframework.data.domain.Pageable;
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

    List<PlumxTask> findByStatusOrderByCreatedAtAsc(TaskStatus status);

    @Query("SELECT t FROM PlumxTask t WHERE t.status = com.academic.broker.domain.TaskStatus.PROCESSING AND t.updatedAt < :cutoff")
    List<PlumxTask> findStuckProcessing(@Param("cutoff") Instant cutoff);

    Optional<PlumxTask> findTopByDoiOrderByIdDesc(String doi);
}

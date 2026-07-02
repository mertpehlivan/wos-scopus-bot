package com.academic.broker.repository;

import com.academic.broker.domain.CitationReportTask;
import com.academic.broker.domain.TaskStatus;
import jakarta.persistence.LockModeType;
import org.springframework.data.domain.Pageable;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Lock;
import org.springframework.data.jpa.repository.Modifying;
import org.springframework.data.jpa.repository.Query;
import org.springframework.data.repository.query.Param;

import java.time.Instant;
import java.util.List;
import java.util.Optional;
import java.util.UUID;

public interface CitationReportTaskRepository extends JpaRepository<CitationReportTask, Long> {

    /**
     * All citation report tasks tagged with a sync request — used by the
     * bridge readiness gate and by the operator panel to display the
     * citation-report status next to a request.
     */
    List<CitationReportTask> findBySyncRequestId(UUID syncRequestId);

    Optional<CitationReportTask> findFirstBySyncRequestIdOrderByIdDesc(UUID syncRequestId);

    @Lock(LockModeType.PESSIMISTIC_WRITE)
    @Query("SELECT t FROM CitationReportTask t WHERE t.id = :id")
    Optional<CitationReportTask> findByIdForUpdate(@Param("id") Long id);

    /**
     * Pull a batch of PENDING citation-report tasks for the worker, in
     * sync-request expiry order (closest expiry first). Mirrors the
     * priority-queue used for {@code PlumxTask} so the worker doesn't
     * starve a sync request that's about to time out.
     */
    @Lock(LockModeType.PESSIMISTIC_WRITE)
    @Query("""
        SELECT t FROM CitationReportTask t
        WHERE t.status = com.academic.broker.domain.TaskStatus.PENDING
        ORDER BY
          (SELECT s.expiresAt FROM SyncRequest s WHERE s.id = t.syncRequestId) ASC,
          t.createdAt ASC
        """)
    List<CitationReportTask> findPendingForUpdate(Pageable pageable);

    /**
     * Drops PENDING/PROCESSING tasks for a sync request that just reached
     * a terminal state. Symmetric with the cleanup we already do for
     * PlumxTask — keeps the worker from churning on requests the operator
     * already closed.
     */
    @Modifying
    @Query("DELETE FROM CitationReportTask t WHERE t.syncRequestId = :reqId AND t.status IN :statuses")
    int deleteBySyncRequestIdAndStatusIn(@Param("reqId") UUID syncRequestId,
                                          @Param("statuses") List<TaskStatus> statuses);

    /**
     * Watchdog query (derived — no custom JPQL, so it can't break app startup):
     * tasks in a given status not touched since {@code cutoff}. The watchdog
     * calls this with PROCESSING and filters out terminal-sync tasks in Java.
     */
    List<CitationReportTask> findByStatusAndUpdatedAtBefore(TaskStatus status, Instant cutoff);
}

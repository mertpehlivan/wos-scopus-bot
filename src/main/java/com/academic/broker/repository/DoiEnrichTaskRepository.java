package com.academic.broker.repository;

import com.academic.broker.domain.DoiEnrichTask;
import com.academic.broker.domain.TaskStatus;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Query;
import org.springframework.data.repository.query.Param;
import org.springframework.stereotype.Repository;

import java.util.List;
import java.util.Optional;

@Repository
public interface DoiEnrichTaskRepository extends JpaRepository<DoiEnrichTask, Long> {

    /** Check if a PENDING or PROCESSING task exists for this DOI + source. */
    boolean existsByDoiAndSourceAndStatusIn(String doi, String source, List<TaskStatus> statuses);

    /** Claim up to N PENDING tasks of a given source (atomically). */
    @Query(value = """
            SELECT * FROM doi_enrich_tasks
            WHERE source = :source AND status = 'PENDING'
            ORDER BY created_at ASC
            LIMIT :batchSize
            FOR UPDATE SKIP LOCKED
            """, nativeQuery = true)
    List<DoiEnrichTask> claimPending(@Param("source") String source,
            @Param("batchSize") int batchSize);

    Optional<DoiEnrichTask> findByDoiAndSource(String doi, String source);

    List<DoiEnrichTask> findByStatus(TaskStatus status);
}

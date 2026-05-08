package com.academic.broker.repository;

import com.academic.broker.domain.SyncAuditLog;
import org.springframework.data.domain.Page;
import org.springframework.data.domain.Pageable;
import org.springframework.data.jpa.repository.JpaRepository;

import java.util.List;
import java.util.UUID;

public interface SyncAuditLogRepository extends JpaRepository<SyncAuditLog, Long> {
    List<SyncAuditLog> findBySyncRequestIdOrderByCreatedAtAsc(UUID syncRequestId);
    Page<SyncAuditLog> findByActorUserIdOrderByCreatedAtDesc(UUID actorUserId, Pageable pageable);
}

package com.academic.broker.service;

import com.academic.broker.domain.SyncRequest;
import com.academic.broker.domain.SyncRequestStatus;
import com.academic.broker.domain.TaskStatus;
import com.academic.broker.repository.ArticleTaskRepository;
import com.academic.broker.repository.PlumxTaskRepository;
import com.academic.broker.repository.SyncRequestRepository;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;
import org.springframework.transaction.annotation.Transactional;

import java.time.Instant;
import java.util.List;
import java.util.Map;

/**
 * Marks any sync request that has overstayed its 24h review window as
 * {@code EXPIRED}. Runs every 5 minutes — countdown precision in the
 * operator UI is minute-grained, this is plenty often.
 */
@Slf4j
@Component
@RequiredArgsConstructor
public class SyncRequestExpirySweeper {

    private final SyncRequestRepository repository;
    private final SyncRequestService service;
    private final ArticleTaskRepository articleTaskRepository;
    private final PlumxTaskRepository plumxTaskRepository;

    @Scheduled(fixedDelay = 300_000L, initialDelay = 60_000L)
    @Transactional
    public void sweep() {
        List<SyncRequest> overdue = repository.findOverdue(
                List.of(SyncRequestStatus.PENDING_SCRAPE,
                        SyncRequestStatus.READY_FOR_REVIEW,
                        SyncRequestStatus.FAILED),
                Instant.now());
        if (overdue.isEmpty()) return;

        Instant now = Instant.now();
        List<TaskStatus> activeTaskStatuses = List.of(TaskStatus.PENDING, TaskStatus.PROCESSING);
        for (SyncRequest r : overdue) {
            r.setStatus(SyncRequestStatus.EXPIRED);
            r.setRejectionReason("24 saatlik inceleme süresi doldu");
            r.setReviewedAt(now);
            r.touch();
            service.audit(r.getId(), null, "SYSTEM", "EXPIRE",
                    Map.of("originalStatus", r.getStatus().name()));
            // Wipe any worker tasks still chasing this request — same
            // cleanup the approve/reject paths run inline. Otherwise an
            // expired request can keep the worker busy on its leftovers
            // for hours, blocking new sync requests from getting through
            // the addTasks "already in flight" check.
            try {
                articleTaskRepository.deleteBySyncRequestIdAndStatusIn(r.getId(), activeTaskStatuses);
                plumxTaskRepository.deleteBySyncRequestIdAndStatusIn(r.getId(), activeTaskStatuses);
            } catch (Exception e) {
                log.warn("[SyncRequest] {} EXPIRED task cleanup failed: {}",
                        r.getId(), e.getMessage());
            }
        }
        repository.saveAll(overdue);
        log.warn("[SyncRequest] Expired {} overdue requests", overdue.size());
    }
}

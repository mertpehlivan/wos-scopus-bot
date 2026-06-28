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

    /**
     * Minutes a request may sit in PENDING_SCRAPE with NO worker engagement
     * before the watchdog gives up. With the worker's heartbeat polling a task
     * is normally claimed within ~1 min; 30 min means the worker is genuinely
     * offline / not running OpenAlex. Kept well above the worst-case legitimate
     * startup (WoS login flow + a large profile) so an active scrape is never
     * failed.
     */
    private static final long SCRAPE_WATCHDOG_MINUTES = 30L;

    /**
     * Scrape-start watchdog. The 24h expiry sweep is otherwise the only thing
     * that moves a request out of PENDING_SCRAPE without worker progress, so a
     * request whose worker never engaged would hang for a full day. This marks
     * a PENDING_SCRAPE request older than {@link #SCRAPE_WATCHDOG_MINUTES} whose
     * linked tasks show NO progress as FAILED, surfacing it promptly.
     *
     * <p>Progress-based, NOT pure elapsed time: if any linked task advanced to
     * PROCESSING/COMPLETED/FAILED the scrape IS active (just slow) and is left
     * alone — only the per-task timeouts and the 24h SLA apply to it.
     */
    @Scheduled(fixedDelay = 300_000L, initialDelay = 120_000L)
    @Transactional
    public void scrapeWatchdog() {
        Instant cutoff = Instant.now().minus(java.time.Duration.ofMinutes(SCRAPE_WATCHDOG_MINUTES));
        List<SyncRequest> stalled = repository.findStalledScrapes(cutoff);
        if (stalled.isEmpty()) return;

        List<TaskStatus> activeTaskStatuses = List.of(TaskStatus.PENDING, TaskStatus.PROCESSING);
        int failed = 0;
        for (SyncRequest r : stalled) {
            List<com.academic.broker.domain.ArticleTask> tasks =
                    articleTaskRepository.findBySyncRequestId(r.getId());
            // Engaged = the worker picked up at least one task (now PROCESSING
            // or reached a terminal status). If so, the scrape is genuinely in
            // progress — leave it to the per-task timeouts / 24h SLA.
            boolean engaged = tasks.stream().anyMatch(t ->
                    t.getStatus() == TaskStatus.PROCESSING
                            || t.getStatus() == TaskStatus.COMPLETED
                            || t.getStatus() == TaskStatus.FAILED);
            if (engaged) continue;

            // No engagement after the window (worker offline, or no task ever
            // queued). Fail it so it's surfaced, then wipe leftover tasks.
            r.setStatus(SyncRequestStatus.FAILED);
            r.setRejectionReason("Senkronizasyon başlatılamadı — çalışan (worker) "
                    + SCRAPE_WATCHDOG_MINUTES + " dk içinde göreve başlamadı");
            r.touch();
            service.audit(r.getId(), null, "SYSTEM", "SCRAPE_WATCHDOG_FAILED",
                    Map.of("ageMinutes", SCRAPE_WATCHDOG_MINUTES, "linkedTasks", tasks.size()));
            try {
                articleTaskRepository.deleteBySyncRequestIdAndStatusIn(r.getId(), activeTaskStatuses);
                plumxTaskRepository.deleteBySyncRequestIdAndStatusIn(r.getId(), activeTaskStatuses);
            } catch (Exception e) {
                log.warn("[SyncRequest] {} watchdog task cleanup failed: {}", r.getId(), e.getMessage());
            }
            repository.save(r);
            failed++;
        }
        if (failed > 0) {
            log.warn("[SyncRequest] Scrape watchdog FAILED {} stalled request(s) (no worker engagement in {} min)",
                    failed, SCRAPE_WATCHDOG_MINUTES);
        }
    }
}

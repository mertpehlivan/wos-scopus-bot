package com.academic.broker.service;

import com.academic.broker.api.dto.AddTasksResponse;
import com.academic.broker.api.dto.ConsumedTaskDto;
import com.academic.broker.api.dto.ConsumeTasksResponse;
import com.academic.broker.api.dto.AuthorMetricsRequest;
import com.academic.broker.api.dto.CompleteTaskRequest;
import com.academic.broker.api.dto.PollTaskResponse;
import com.academic.broker.domain.ArticleTask;
import com.academic.broker.domain.TaskStatus;
import com.academic.broker.domain.TaskType;
import com.academic.broker.domain.TargetSource;
import com.academic.broker.exception.TaskNotFoundException;
import com.academic.broker.exception.TaskNotProcessableException;
import com.academic.broker.domain.PlumxTask;
import com.academic.broker.repository.ArticleTaskRepository;
import com.academic.broker.repository.DoiEnrichTaskRepository;
import com.academic.broker.repository.PlumxTaskRepository;
import com.academic.broker.repository.SyncRequestRepository;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.data.domain.PageRequest;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.time.Instant;
import java.util.ArrayList;
import java.util.List;
import java.util.UUID;
import java.util.stream.Collectors;

@Slf4j
@Service
@RequiredArgsConstructor
public class ArticleTaskService {

    private final ArticleTaskRepository repository;
    private final PlumxTaskRepository plumxRepository;
    private final DoiEnrichTaskRepository doiEnrichRepository;
    /**
     * Used by addTasks to inspect the OWNER of a leftover PENDING task —
     * if its owning sync request is no longer active, the row is wiped
     * and re-created for the current sync (prevents the leftover-Scholar
     * bug from blocking new requests).
     */
    private final SyncRequestRepository syncRequestRepository;
    /**
     * Optional bridge that pushes worker output into a {@code SyncRequest}'s
     * stagedData. Marked optional so the article-task pipeline still works
     * for callers who don't go through the operator-panel staging flow.
     */
    private final org.springframework.beans.factory.ObjectProvider<SyncRequestWorkerBridge> syncBridge;

    @Value("${broker.processing-timeout-minutes:5}")
    private int processingTimeoutMinutes;

    private static final List<TaskStatus> ACTIVE_STATUSES = List.of(
            TaskStatus.PENDING,
            TaskStatus.PROCESSING);

    /**
     * Ana sistem: WoS/Scopus ID'lerini PENDING olarak ekler. Zaten
     * PENDING/PROCESSING olanlar atlanır.
     */
    @Transactional
    public AddTasksResponse addTasks(TargetSource source, List<String> externalIds, String redirectUrl, boolean force,
            TaskType taskType) {
        return addTasks(source, externalIds, redirectUrl, force, taskType, null);
    }

    /**
     * Creates worker tasks for the given externalIds. If {@code syncRequestId}
     * is non-null, the new tasks are stamped with it so the worker bridge
     * routes their results into that request's staged data on completion.
     */
    @Transactional
    public AddTasksResponse addTasks(TargetSource source, List<String> externalIds, String redirectUrl, boolean force,
            TaskType taskType, java.util.UUID syncRequestId) {
        TaskType resolvedType = taskType != null ? taskType : TaskType.FULL_SCRAPE;
        List<String> addedIds = new ArrayList<>();
        List<Long> addedTaskIds = new ArrayList<>();
        for (String externalId : externalIds) {
            if (force) {
                // Remove existing active tasks for this externalId to prevent duplicate processing
                repository.deleteByTargetSourceAndExternalIdAndStatusIn(source, externalId, ACTIVE_STATUSES);
            } else if (repository.existsByTargetSourceAndExternalIdAndStatusIn(source, externalId, ACTIVE_STATUSES)) {
                // exists() found at least one PENDING/PROCESSING row for
                // this {source, externalId}. Decide based on the OWNER of
                // the row that's actually still active.
                //
                //   • Owner is the SAME sync request as us → idempotent
                //     duplicate call; leave it alone.
                //   • Owner is a sync request still in PENDING_SCRAPE →
                //     same idea; the parallel addTasks for the same active
                //     request just shouldn't double-create.
                //   • Owner is null OR points to a CLOSED sync request →
                //     stragglel from a previous run. Wipe and recreate so
                //     the worker doesn't complete it into the wrong sync
                //     (the historical leftover-Scholar bug).
                //   • findTop returned null OR a non-active row → there's
                //     a state inconsistency (older PENDING with newer
                //     COMPLETED). Wipe and recreate to be safe — without
                //     this we'd silently skip creation and the orchestrator
                //     would think there's nothing to do for this source.
                ArticleTask existing = repository
                        .findTopByTargetSourceAndExternalIdOrderByIdDesc(source, externalId)
                        .orElse(null);

                boolean shouldKeepExisting = false;
                if (existing != null && ACTIVE_STATUSES.contains(existing.getStatus())) {
                    UUID existingOwner = existing.getSyncRequestId();
                    boolean ownerIsActive = existingOwner != null
                            && syncRequestRepository.findById(existingOwner)
                                    .map(s -> s.getStatus() == com.academic.broker.domain.SyncRequestStatus.PENDING_SCRAPE)
                                    .orElse(false);
                    boolean sameOwner = syncRequestId != null && syncRequestId.equals(existingOwner);

                    if (sameOwner || ownerIsActive) {
                        // Idempotent — keep, optionally attach our id if
                        // the row had none.
                        if (syncRequestId != null && existingOwner == null) {
                            existing.setSyncRequestId(syncRequestId);
                            repository.save(existing);
                        }
                        shouldKeepExisting = true;
                    } else {
                        log.info("[Tasks] {} task for {} owned by closed sync {}; replacing with fresh row for {}",
                                source, externalId, existingOwner, syncRequestId);
                    }
                } else {
                    // exists() said yes but findTop returned null/non-active
                    // — older PENDING rows exist that the most-recent-id
                    // query can't see. Wipe and recreate.
                    log.info("[Tasks] {} task for {} has stale PENDING row(s) without a most-recent active twin; replacing for {}",
                            source, externalId, syncRequestId);
                }

                if (shouldKeepExisting) {
                    continue; // skip the create path
                }
                // Wipe any active rows we don't want to keep, then fall
                // through to the create block below.
                repository.deleteByTargetSourceAndExternalIdAndStatusIn(source, externalId, ACTIVE_STATUSES);
            }
            ArticleTask task = ArticleTask.builder()
                    .targetSource(source)
                    .externalId(externalId)
                    .redirectUrl(redirectUrl)
                    .taskType(resolvedType)
                    .status(TaskStatus.PENDING)
                    .syncRequestId(syncRequestId)
                    .updatedAt(Instant.now())
                    .build();
            ArticleTask saved = repository.save(task);
            addedIds.add(externalId);
            addedTaskIds.add(saved.getId());
        }

        // Seed sourceProgress on the sync request so the operator panel
        // shows "Çekiliyor" instead of "Bilinmiyor" while the worker is
        // mid-flight. Done once per addTasks call (not per externalId)
        // since all externalIds in a single call share the source.
        if (syncRequestId != null && !addedIds.isEmpty()) {
            SyncRequestWorkerBridge bridge = syncBridge.getIfAvailable();
            if (bridge != null) bridge.markSourcePending(syncRequestId, source.name());
        }
        return AddTasksResponse.builder()
                .added(addedIds.size())
                .skipped(externalIds.size() - addedIds.size())
                .addedIds(addedIds)
                .addedTaskIds(addedTaskIds)
                .build();
    }

    /**
     * Eklenti (worker): Kaynak için bir PENDING task alır, PESSIMISTIC_WRITE ile
     * kilitleyip PROCESSING yapar.
     * Task yoksa null döner.
     */
    @Transactional
    public PollTaskResponse pollTask(TargetSource source) {
        List<ArticleTask> pending = repository.findOnePendingBySourceForUpdate(source, PageRequest.of(0, 1));
        if (pending.isEmpty()) {
            return null;
        }
        ArticleTask task = pending.get(0);
        task.setStatus(TaskStatus.PROCESSING);
        task.touch();
        repository.save(task);
        log.info("Task {} polled by extension (source={}, externalId={})", task.getId(), task.getTargetSource(), task.getExternalId());
        return PollTaskResponse.builder()
                .taskId(task.getId())
                .source(task.getTargetSource())
                .externalId(task.getExternalId())
                .redirectUrl(task.getRedirectUrl())
                .taskType(task.getTaskType())
                .syncRequestId(task.getSyncRequestId())
                .build();
    }

    /**
     * Eklenti: Scrape tamamlandı, raw data gönderilir; durum COMPLETED olur.
     */
    @Transactional
    public void completeTask(Long taskId, CompleteTaskRequest request) {
        ArticleTask task = repository.findByIdForUpdate(taskId)
                .orElseThrow(() -> new TaskNotFoundException(taskId));
        if (task.getStatus() == TaskStatus.PENDING) {
            // Task was reset by timeout scheduler before worker could complete.
            // Reclaim it so the worker can finish.
            log.warn("Task {} was reset to PENDING by scheduler. Reclaiming and completing.", taskId);
            task.setStatus(TaskStatus.PROCESSING);
        }
        if (task.getStatus() != TaskStatus.PROCESSING) {
            throw new TaskNotProcessableException(taskId, task.getStatus(), "complete");
        }
        task.setRawData(request.getRawData());
        task.setStatus(TaskStatus.COMPLETED);
        task.touch();
        repository.save(task);
        log.info("Task {} completed by extension (source={}, externalId={})", taskId, task.getTargetSource(), task.getExternalId());
        // If this task was created for a SyncRequest, push the result into staging.
        if (task.getSyncRequestId() != null) {
            SyncRequestWorkerBridge bridge = syncBridge.getIfAvailable();
            if (bridge != null) bridge.ingestTaskCompletion(task);
        }
    }

    /**
     * Eklenti: Yazar metrikleri (h-index, publications, citations) ayrı olarak
     * kaydedilir.
     * Task durumu PROCESSING'de kalır.
     */
    @Transactional
    public void saveAuthorMetrics(Long taskId, AuthorMetricsRequest request) {
        ArticleTask task = repository.findByIdForUpdate(taskId)
                .orElseThrow(() -> new TaskNotFoundException(taskId));
        if (task.getStatus() == TaskStatus.PENDING) {
            log.warn("Task {} was reset to PENDING before author-metrics. Reclaiming.", taskId);
            task.setStatus(TaskStatus.PROCESSING);
        }
        if (task.getStatus() != TaskStatus.PROCESSING) {
            throw new TaskNotProcessableException(taskId, task.getStatus(), "save author metrics");
        }
        task.setAuthorMetricsData(request.getAuthorMetrics());
        task.touch();
        repository.save(task);
        log.info("Author metrics saved for task {} (source={})", taskId, task.getTargetSource());
    }

    /**
     * Eklenti: Scrape başarısız; durum FAILED olur.
     */
    @Transactional
    public void failTask(Long taskId) {
        ArticleTask task = repository.findByIdForUpdate(taskId)
                .orElseThrow(() -> new TaskNotFoundException(taskId));
        if (task.getStatus() != TaskStatus.PROCESSING) {
            throw new TaskNotProcessableException(taskId, task.getStatus(), "fail");
        }
        task.setStatus(TaskStatus.FAILED);
        task.touch();
        repository.save(task);
        if (task.getSyncRequestId() != null) {
            SyncRequestWorkerBridge bridge = syncBridge.getIfAvailable();
            if (bridge != null) bridge.ingestTaskCompletion(task);
        }
    }

    /**
     * Ana sistem: COMPLETED task'ları döndürür ve hemen siler (ephemeral).
     * PESSIMISTIC_WRITE lock ile aynı anda gelen iki consume çağrısı aynı task'ları alamaz.
     */
    @Transactional
    public ConsumeTasksResponse consumeCompletedTasks() {
        List<ArticleTask> completed = repository.findCompletedForConsume();
        List<ConsumedTaskDto> dtos = completed.stream()
                .map(this::toConsumedDto)
                .collect(Collectors.toList());
        for (ArticleTask task : completed) {
            task.setStatus(TaskStatus.PROCESSING);
            task.touch();
            repository.save(task);
        }
        return ConsumeTasksResponse.builder().tasks(dtos).build();
    }

    /**
     * Main backend acknowledges that a consumed task has been persisted locally.
     */
    @Transactional
    public void ackConsumedTask(Long taskId) {
        ArticleTask task = repository.findByIdForUpdate(taskId)
                .orElseThrow(() -> new TaskNotFoundException(taskId));
        if (task.getStatus() != TaskStatus.PROCESSING && task.getStatus() != TaskStatus.COMPLETED) {
            throw new TaskNotProcessableException(taskId, task.getStatus(), "ack");
        }
        repository.delete(task);
        log.info("Task {} acknowledged by backend and deleted", taskId);
    }

    /**
     * Zaman aşımı: PROCESSING'de 5 dakikadan uzun kalan task'ları tekrar PENDING
     * yapar.
     */
    @Scheduled(fixedDelay = 60_000, initialDelay = 60_000) // every 1 min, timeout threshold from config
    @Transactional
    public void resetStuckProcessingTasks() {
        Instant cutoff = Instant.now().minusSeconds(processingTimeoutMinutes * 60L);
        List<ArticleTask> stuck = repository.findStuckProcessing(cutoff);
        if (!stuck.isEmpty()) {
            for (ArticleTask task : stuck) {
                if (task.getRawData() != null) {
                    task.setStatus(TaskStatus.COMPLETED);
                } else {
                    task.setStatus(TaskStatus.PENDING);
                }
                task.touch();
                repository.save(task);
            }
            log.info("Reset {} stuck PROCESSING task(s) to PENDING", stuck.size());
        }
    }

    private ConsumedTaskDto toConsumedDto(ArticleTask t) {
        return ConsumedTaskDto.builder()
                .taskId(t.getId())
                .source(t.getTargetSource())
                .externalId(t.getExternalId())
                .redirectUrl(t.getRedirectUrl())
                .taskType(t.getTaskType())
                .authorMetricsData(t.getAuthorMetricsData())
                .rawData(t.getRawData())
                .build();
    }

    /**
     * Returns the latest task status for a given source+externalId,
     * ordered by ID descending (newest first). Used by GET /api/tasks/status.
     */
    @Transactional(readOnly = true)
    public java.util.Optional<java.util.Map<String, Object>> findLatestStatus(TargetSource source, String externalId) {
        return repository
                .findTopByTargetSourceAndExternalIdOrderByIdDesc(source, externalId)
                .map(t -> java.util.Map.of(
                        "taskId", t.getId(),
                        "source", t.getTargetSource().name(),
                        "externalId", t.getExternalId(),
                        "status", t.getStatus().name(),
                        "updatedAt", t.getUpdatedAt() != null ? t.getUpdatedAt().toString() : ""));
    }

    /**
     * Reset FAILED tasks to PENDING for a given source group.
     */
    @Transactional
    public int refreshGroup(String group) {
        int updated = 0;
        switch (group.toUpperCase()) {
            case "WOS":
                updated = repository.resetFailedToPendingBySource(TargetSource.WOS);
                doiEnrichRepository.resetFailedToPendingBySource("WOS");
                break;
            case "SCOPUS":
                updated = repository.resetFailedToPendingBySource(TargetSource.SCOPUS);
                break;
            case "SCHOLAR":
                updated = repository.resetFailedToPendingBySource(TargetSource.SCHOLAR);
                doiEnrichRepository.resetFailedToPendingBySource("SCHOLAR");
                break;
            case "PLUMX":
                updated = plumxRepository.resetAllFailedToPending();
                break;
            case "ALL":
                updated += repository.resetFailedToPendingBySource(TargetSource.WOS);
                updated += repository.resetFailedToPendingBySource(TargetSource.SCOPUS);
                updated += repository.resetFailedToPendingBySource(TargetSource.SCHOLAR);
                updated += plumxRepository.resetAllFailedToPending();
                doiEnrichRepository.resetFailedToPendingBySource("WOS");
                doiEnrichRepository.resetFailedToPendingBySource("SCHOLAR");
                break;
            default:
                log.warn("Unknown refresh group: {}", group);
        }
        log.info("Refreshed {} task(s) for group: {}", updated, group);
        return updated;
    }

    /**
     * Delete ALL tasks from every table. Use with extreme caution.
     */
    @Transactional
    public int resetAll() {
        int deleted = 0;
        deleted += repository.deleteAllTasks();
        deleted += plumxRepository.deleteAllPlumx();
        deleted += doiEnrichRepository.deleteAllTasks();
        log.warn("RESET-ALL executed: {} total task records deleted", deleted);
        return deleted;
    }

    /*
     * ═══════════════════════════════════════════════
     * PlumX Task Methods (separate plumx_tasks table)
     * ═══════════════════════════════════════════════
     */

    /**
     * Add PlumX DOI tasks in batch. Skips already PENDING/PROCESSING DOIs.
     */
    @Transactional
    public AddTasksResponse addPlumxTasks(List<String> dois) {
        return addPlumxTasks(dois, null);
    }

    /**
     * Add PlumX DOI tasks in batch, optionally stamping each task with the
     * sync request id that requested them. When stamped, the worker bridge
     * folds the citation counts into that sync request's publications on
     * completion (matched by DOI).
     */
    @Transactional
    public AddTasksResponse addPlumxTasks(List<String> dois, java.util.UUID syncRequestId) {
        List<String> addedDois = new ArrayList<>();
        for (String doi : dois) {
            if (plumxRepository.existsByDoiAndStatusIn(doi, ACTIVE_STATUSES)) {
                // If a sync request id came in but the existing task isn't
                // stamped, attach it so the bridge still sees the result.
                if (syncRequestId != null) {
                    plumxRepository.findFirstByDoiAndStatusIn(doi, ACTIVE_STATUSES)
                            .ifPresent(t -> {
                                if (t.getSyncRequestId() == null) {
                                    t.setSyncRequestId(syncRequestId);
                                    plumxRepository.save(t);
                                }
                            });
                }
                continue;
            }
            PlumxTask task = PlumxTask.builder()
                    .doi(doi)
                    .status(TaskStatus.PENDING)
                    .syncRequestId(syncRequestId)
                    .updatedAt(Instant.now())
                    .build();
            plumxRepository.save(task);
            addedDois.add(doi);
        }
        // Seed PLUMX progress on the sync request so the panel shows the
        // PlumX side-channel as "Çekiliyor" while DOIs drain.
        if (syncRequestId != null && !addedDois.isEmpty()) {
            SyncRequestWorkerBridge bridge = syncBridge.getIfAvailable();
            if (bridge != null) bridge.markSourcePending(syncRequestId, "PLUMX");
        }
        return AddTasksResponse.builder()
                .added(addedDois.size())
                .skipped(dois.size() - addedDois.size())
                .addedIds(addedDois)
                .build();
    }

    /**
     * Poll a batch of PlumX tasks (claim multiple PENDING→PROCESSING at once).
     */
    @Transactional
    public List<PollTaskResponse> pollPlumxBatch(int batchSize) {
        List<PlumxTask> pending = plumxRepository.findPendingForUpdate(
                PageRequest.of(0, batchSize));
        List<PollTaskResponse> results = new ArrayList<>();
        for (PlumxTask task : pending) {
            task.setStatus(TaskStatus.PROCESSING);
            task.touch();
            plumxRepository.save(task);
            results.add(PollTaskResponse.builder()
                    .taskId(task.getId())
                    .source(TargetSource.PLUMX)
                    .externalId(task.getDoi())
                    .redirectUrl(null)
                    .taskType(TaskType.CITATION_SYNC)
                    .syncRequestId(task.getSyncRequestId())
                    .build());
        }
        return results;
    }

    /**
     * Operator-panel per-publication "Tekrar Çek" entry point. Wipes any
     * still-active (PENDING / PROCESSING) PlumX row for {@code doi} and
     * inserts a fresh PENDING one stamped with {@code syncRequestId} so
     * the worker bridge routes the citation overlay back into the right
     * sync request when the lookup finishes.
     *
     * <p>Different from {@link #addPlumxTasks(List, UUID)} which dedupes
     * — operator explicitly asked for a re-fetch, so the dedupe check
     * would skip the work. We force a wipe + insert.
     */
    @Transactional
    public void forcePlumxRefresh(String doi, UUID syncRequestId) {
        if (doi == null || doi.isBlank()) return;
        // Wipe whatever's currently active for this DOI.
        plumxRepository.findFirstByDoiAndStatusIn(doi, ACTIVE_STATUSES)
                .ifPresent(plumxRepository::delete);
        PlumxTask fresh = PlumxTask.builder()
                .doi(doi)
                .status(TaskStatus.PENDING)
                .syncRequestId(syncRequestId)
                .updatedAt(Instant.now())
                .build();
        plumxRepository.save(fresh);
        // Surface a "Çekiliyor" chip on the operator panel so the operator
        // sees their click landed.
        if (syncRequestId != null) {
            SyncRequestWorkerBridge bridge = syncBridge.getIfAvailable();
            if (bridge != null) bridge.markSourcePending(syncRequestId, "PLUMX");
        }
        log.info("[Tasks] PlumX refresh queued for doi={} sync={}", doi, syncRequestId);
    }

    @Transactional
    public void completePlumxTask(Long taskId, CompleteTaskRequest request) {
        PlumxTask task = plumxRepository.findByIdForUpdate(taskId)
                .orElseThrow(() -> new TaskNotFoundException(taskId));
        if (task.getStatus() != TaskStatus.PROCESSING) {
            throw new TaskNotProcessableException(taskId, task.getStatus(), "complete");
        }
        task.setRawData(request.getRawData());
        task.setStatus(TaskStatus.COMPLETED);
        task.touch();
        plumxRepository.save(task);

        // If this PlumX lookup was kicked off as part of a sync request, fold
        // the citation counts (Scopus / Mendeley / CrossRef) into that
        // request's stagedData publications — matched by DOI. Mirrors the
        // historical SmartPublicationService.triggerPlumxCitationEnrichment
        // post-processing, but in the broker so backend never sees PlumX raw.
        if (task.getSyncRequestId() != null) {
            SyncRequestWorkerBridge bridge = syncBridge.getIfAvailable();
            if (bridge != null) bridge.ingestPlumxCompletion(task);
        }
    }

    @Transactional
    public void failPlumxTask(Long taskId) {
        PlumxTask task = plumxRepository.findByIdForUpdate(taskId)
                .orElseThrow(() -> new TaskNotFoundException(taskId));
        if (task.getStatus() != TaskStatus.PROCESSING) {
            throw new TaskNotProcessableException(taskId, task.getStatus(), "fail");
        }
        task.setStatus(TaskStatus.FAILED);
        task.touch();
        plumxRepository.save(task);
    }

    /**
     * Deletes all PENDING PlumX tasks. PROCESSING tasks are preserved so the
     * worker can finish them cleanly. Returns the number of deleted rows.
     */
    @Transactional
    public int deletePendingPlumxTasks() {
        return plumxRepository.deletePendingPlumx();
    }

    /**
     * Deletes all PENDING article tasks (WOS / SCOPUS / SCHOLAR). PROCESSING
     * preserved. Returns the number of deleted rows.
     */
    @Transactional
    public int deletePendingArticleTasks() {
        return repository.deletePendingArticles();
    }

    @Transactional
    public ConsumeTasksResponse consumeCompletedPlumxTasks() {
        List<PlumxTask> completed = plumxRepository.findCompletedForConsume();
        List<ConsumedTaskDto> dtos = completed.stream()
                .map(t -> ConsumedTaskDto.builder()
                        .taskId(t.getId())
                        .source(TargetSource.PLUMX)
                        .externalId(t.getDoi())
                        .rawData(t.getRawData())
                        .build())
                .collect(Collectors.toList());
        for (PlumxTask task : completed) {
            task.setStatus(TaskStatus.PROCESSING);
            task.touch();
            plumxRepository.save(task);
        }
        return ConsumeTasksResponse.builder().tasks(dtos).build();
    }

    @Transactional
    public void ackConsumedPlumxTask(Long taskId) {
        PlumxTask task = plumxRepository.findByIdForUpdate(taskId)
                .orElseThrow(() -> new TaskNotFoundException(taskId));
        if (task.getStatus() != TaskStatus.PROCESSING && task.getStatus() != TaskStatus.COMPLETED) {
            throw new TaskNotProcessableException(taskId, task.getStatus(), "ack");
        }
        plumxRepository.delete(task);
        log.info("PlumX task {} acknowledged by backend and deleted", taskId);
    }

    /**
     * Timeout: Reset stuck PlumX PROCESSING tasks back to PENDING.
     */
    @Scheduled(fixedDelay = 60_000, initialDelay = 90_000)
    @Transactional
    public void resetStuckPlumxTasks() {
        Instant cutoff = Instant.now().minusSeconds(processingTimeoutMinutes * 60L);
        List<PlumxTask> stuck = plumxRepository.findStuckProcessing(cutoff);
        if (!stuck.isEmpty()) {
            for (PlumxTask task : stuck) {
                if (task.getRawData() != null) {
                    task.setStatus(TaskStatus.COMPLETED);
                } else {
                    task.setStatus(TaskStatus.PENDING);
                }
                task.touch();
                plumxRepository.save(task);
            }
            log.info("Reset {} stuck PlumX PROCESSING task(s) to PENDING", stuck.size());
        }
    }
}

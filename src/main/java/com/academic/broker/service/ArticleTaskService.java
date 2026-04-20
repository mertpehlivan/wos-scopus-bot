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
import com.academic.broker.repository.PlumxTaskRepository;
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
import java.util.stream.Collectors;

@Slf4j
@Service
@RequiredArgsConstructor
public class ArticleTaskService {

    private final ArticleTaskRepository repository;
    private final PlumxTaskRepository plumxRepository;

    @Value("${broker.processing-timeout-minutes:5}")
    private int processingTimeoutMinutes;

    private static final List<TaskStatus> ACTIVE_STATUSES = List.of(TaskStatus.PENDING, TaskStatus.PROCESSING);

    /**
     * Ana sistem: WoS/Scopus ID'lerini PENDING olarak ekler. Zaten
     * PENDING/PROCESSING olanlar atlanır.
     */
    @Transactional
    public AddTasksResponse addTasks(TargetSource source, List<String> externalIds, String redirectUrl, boolean force,
            TaskType taskType) {
        TaskType resolvedType = taskType != null ? taskType : TaskType.FULL_SCRAPE;
        List<String> addedIds = new ArrayList<>();
        for (String externalId : externalIds) {
            if (!force
                    && repository.existsByTargetSourceAndExternalIdAndStatusIn(source, externalId, ACTIVE_STATUSES)) {
                continue;
            }
            ArticleTask task = ArticleTask.builder()
                    .targetSource(source)
                    .externalId(externalId)
                    .redirectUrl(redirectUrl)
                    .taskType(resolvedType)
                    .status(TaskStatus.PENDING)
                    .updatedAt(Instant.now())
                    .build();
            repository.save(task);
            addedIds.add(externalId);
        }
        return AddTasksResponse.builder()
                .added(addedIds.size())
                .skipped(externalIds.size() - addedIds.size())
                .addedIds(addedIds)
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
        return PollTaskResponse.builder()
                .taskId(task.getId())
                .source(task.getTargetSource())
                .externalId(task.getExternalId())
                .redirectUrl(task.getRedirectUrl())
                .taskType(task.getTaskType())
                .build();
    }

    /**
     * Eklenti: Scrape tamamlandı, raw data gönderilir; durum COMPLETED olur.
     */
    @Transactional
    public void completeTask(Long taskId, CompleteTaskRequest request) {
        ArticleTask task = repository.findByIdForUpdate(taskId)
                .orElseThrow(() -> new TaskNotFoundException(taskId));
        if (task.getStatus() != TaskStatus.PROCESSING) {
            throw new TaskNotProcessableException(taskId, task.getStatus(), "complete");
        }
        task.setRawData(request.getRawData());
        task.setStatus(TaskStatus.COMPLETED);
        task.touch();
        repository.save(task);
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
        if (task.getStatus() != TaskStatus.PROCESSING) {
            throw new TaskNotProcessableException(taskId, task.getStatus(), "save author metrics");
        }
        task.setAuthorMetricsData(request.getAuthorMetrics());
        task.touch();
        repository.save(task);
        log.info("Author metrics saved for task {}", taskId);
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
    }

    /**
     * Ana sistem: COMPLETED task'ları döndürür ve hemen siler (ephemeral).
     */
    @Transactional
    public ConsumeTasksResponse consumeCompletedTasks() {
        List<ArticleTask> completed = repository.findByStatusOrderByCreatedAtAsc(TaskStatus.COMPLETED);
        List<ConsumedTaskDto> dtos = completed.stream()
                .map(this::toConsumedDto)
                .collect(Collectors.toList());
        repository.deleteAll(completed);
        return ConsumeTasksResponse.builder().tasks(dtos).build();
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
        if (stuck.isEmpty()) {
            return;
        }
        for (ArticleTask task : stuck) {
            task.setStatus(TaskStatus.PENDING);
            task.touch();
            repository.save(task);
        }
        log.info("Reset {} stuck PROCESSING task(s) to PENDING", stuck.size());
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
        List<String> addedDois = new ArrayList<>();
        for (String doi : dois) {
            if (plumxRepository.existsByDoiAndStatusIn(doi, ACTIVE_STATUSES)) {
                continue;
            }
            PlumxTask task = PlumxTask.builder()
                    .doi(doi)
                    .status(TaskStatus.PENDING)
                    .updatedAt(Instant.now())
                    .build();
            plumxRepository.save(task);
            addedDois.add(doi);
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
                    .build());
        }
        return results;
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

    @Transactional
    public ConsumeTasksResponse consumeCompletedPlumxTasks() {
        List<PlumxTask> completed = plumxRepository.findByStatusOrderByCreatedAtAsc(TaskStatus.COMPLETED);
        List<ConsumedTaskDto> dtos = completed.stream()
                .map(t -> ConsumedTaskDto.builder()
                        .taskId(t.getId())
                        .source(TargetSource.PLUMX)
                        .externalId(t.getDoi())
                        .rawData(t.getRawData())
                        .build())
                .collect(Collectors.toList());
        plumxRepository.deleteAll(completed);
        return ConsumeTasksResponse.builder().tasks(dtos).build();
    }

    /**
     * Timeout: Reset stuck PlumX PROCESSING tasks back to PENDING.
     */
    @Scheduled(fixedDelay = 60_000, initialDelay = 90_000)
    @Transactional
    public void resetStuckPlumxTasks() {
        Instant cutoff = Instant.now().minusSeconds(processingTimeoutMinutes * 60L);
        List<PlumxTask> stuck = plumxRepository.findStuckProcessing(cutoff);
        if (stuck.isEmpty())
            return;
        for (PlumxTask task : stuck) {
            task.setStatus(TaskStatus.PENDING);
            task.touch();
            plumxRepository.save(task);
        }
        log.info("Reset {} stuck PlumX PROCESSING task(s) to PENDING", stuck.size());
    }
}

package com.academic.broker.service;

import com.academic.broker.domain.ArticleTask;
import com.academic.broker.domain.TargetSource;
import com.academic.broker.domain.TaskStatus;
import com.academic.broker.exception.TaskNotFoundException;
import com.academic.broker.repository.ArticleTaskRepository;
import com.academic.broker.repository.DoiEnrichTaskRepository;
import com.academic.broker.repository.PlumxTaskRepository;
import com.academic.broker.repository.SyncRequestRepository;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.test.util.ReflectionTestUtils;

import java.time.Instant;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.UUID;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

class ArticleTaskServiceWatchdogTest {

    private ArticleTaskRepository repo;
    private SyncRequestWorkerBridge bridge;
    private ArticleTaskService service;

    @BeforeEach
    @SuppressWarnings("unchecked")
    void setUp() {
        repo = mock(ArticleTaskRepository.class);
        bridge = mock(SyncRequestWorkerBridge.class);
        ObjectProvider<SyncRequestWorkerBridge> provider = mock(ObjectProvider.class);
        when(provider.getIfAvailable()).thenReturn(bridge);
        service = new ArticleTaskService(repo, mock(PlumxTaskRepository.class),
                mock(DoiEnrichTaskRepository.class), mock(SyncRequestRepository.class), provider);
        ReflectionTestUtils.setField(service, "processingTimeoutMinutes", 120);
        ReflectionTestUtils.setField(service, "heartbeatStaleMinutes", 20);
        when(repo.save(any())).thenAnswer(inv -> inv.getArgument(0));
    }

    private static ArticleTask processing(long id, int minutesSinceUpdate, boolean heartbeat) {
        ArticleTask t = ArticleTask.builder()
                .id(id).targetSource(TargetSource.WOS).externalId("X-" + id)
                .status(TaskStatus.PROCESSING)
                .updatedAt(Instant.now().minusSeconds(minutesSinceUpdate * 60L))
                .build();
        if (heartbeat) {
            t.setLastHeartbeatAt(t.getUpdatedAt());
            t.setProgressPhase("DETAILS");
            t.setProgressCurrent(3);
            t.setProgressTotal(10);
        }
        return t;
    }

    @Test
    void heartbeatTask_silentFor25Min_isRequeued() {
        ArticleTask t = processing(1, 25, true);
        when(repo.findStuckProcessing(any())).thenReturn(List.of(t));

        service.resetStuckProcessingTasks();

        assertThat(t.getStatus()).isEqualTo(TaskStatus.PENDING);
        assertThat(t.getErrorMessage()).contains("ilerleme yok").contains("DETAILS");
        assertThat(t.getLastHeartbeatAt()).isNull();
        assertThat(t.getProgressPhase()).isNull();
    }

    @Test
    void legacyTask_silentFor25Min_isLeftAlone() {
        ArticleTask t = processing(2, 25, false);
        when(repo.findStuckProcessing(any())).thenReturn(List.of(t));

        service.resetStuckProcessingTasks();

        assertThat(t.getStatus()).isEqualTo(TaskStatus.PROCESSING);
        verify(repo, never()).save(t);
    }

    @Test
    void legacyTask_silentFor130Min_isRequeued() {
        ArticleTask t = processing(3, 130, false);
        when(repo.findStuckProcessing(any())).thenReturn(List.of(t));

        service.resetStuckProcessingTasks();

        assertThat(t.getStatus()).isEqualTo(TaskStatus.PENDING);
    }

    @Test
    void staleTaskWithPayload_isCompletedAndIngested() {
        ArticleTask t = processing(4, 30, true);
        t.setRawData(Map.of("articles", List.of()));
        t.setSyncRequestId(UUID.randomUUID());
        when(repo.findStuckProcessing(any())).thenReturn(List.of(t));

        service.resetStuckProcessingTasks();

        assertThat(t.getStatus()).isEqualTo(TaskStatus.COMPLETED);
        assertThat(t.getFinishedAt()).isNotNull();
        verify(bridge).ingestTaskCompletion(t);
    }

    @Test
    void heartbeat_recordsProgress_andReclaimsPending() {
        ArticleTask t = processing(5, 5, false);
        t.setStatus(TaskStatus.PENDING);
        when(repo.findByIdForUpdate(5L)).thenReturn(Optional.of(t));

        Map<String, Object> resp = service.heartbeat(5L, "DETAILS", 7, 20);

        assertThat(resp).containsEntry("ok", true).containsEntry("cancel", false);
        assertThat(t.getStatus()).isEqualTo(TaskStatus.PROCESSING);
        assertThat(t.getLastHeartbeatAt()).isNotNull();
        assertThat(t.getProgressCurrent()).isEqualTo(7);
        assertThat(t.getProgressTotal()).isEqualTo(20);
    }

    @Test
    void heartbeat_onFinishedTask_reportsStatus() {
        ArticleTask t = processing(6, 1, false);
        t.setStatus(TaskStatus.COMPLETED);
        when(repo.findByIdForUpdate(6L)).thenReturn(Optional.of(t));

        assertThat(service.heartbeat(6L, "DETAILS", 1, 2))
                .containsEntry("ok", false).containsEntry("status", "COMPLETED");
    }

    @Test
    void heartbeat_unknownTask_throwsNotFound() {
        when(repo.findByIdForUpdate(7L)).thenReturn(Optional.empty());
        assertThatThrownBy(() -> service.heartbeat(7L, null, null, null))
                .isInstanceOf(TaskNotFoundException.class);
    }
}

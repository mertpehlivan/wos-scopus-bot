package com.academic.broker.service;

import com.academic.broker.domain.ArticleTask;
import com.academic.broker.domain.SyncRequest;
import com.academic.broker.domain.SyncRequestStatus;
import com.academic.broker.domain.TargetSource;
import com.academic.broker.domain.TaskStatus;
import com.academic.broker.repository.ArticleTaskRepository;
import com.academic.broker.repository.PlumxTaskRepository;
import com.academic.broker.repository.SyncRequestRepository;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

import java.time.Instant;
import java.util.List;
import java.util.Map;
import java.util.UUID;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

class SyncRequestExpirySweeperTest {

    private SyncRequestRepository repo;
    private ArticleTaskRepository tasks;
    private WorkerHealthService health;
    private SyncRequestExpirySweeper sweeper;
    private SyncRequest req;

    @BeforeEach
    void setUp() {
        repo = mock(SyncRequestRepository.class);
        tasks = mock(ArticleTaskRepository.class);
        health = new WorkerHealthService();
        sweeper = new SyncRequestExpirySweeper(repo, mock(SyncRequestService.class), tasks,
                mock(PlumxTaskRepository.class), health);
        req = new SyncRequest();
        req.setId(UUID.randomUUID());
        req.setStatus(SyncRequestStatus.PENDING_SCRAPE);
        when(repo.findStalledScrapes(any())).thenReturn(List.of(req));
    }

    private ArticleTask pendingTask(Instant createdAt) {
        ArticleTask t = ArticleTask.builder().id(1L).targetSource(TargetSource.WOS).externalId("X")
                .status(TaskStatus.PENDING).syncRequestId(req.getId()).build();
        t.setCreatedAt(createdAt);
        return t;
    }

    @Test
    void workerOffline_oldUnclaimedTasks_failsRequest() {
        when(tasks.findBySyncRequestId(req.getId())).thenReturn(List.of(pendingTask(Instant.now().minusSeconds(3600))));

        sweeper.scrapeWatchdog();

        assertThat(req.getStatus()).isEqualTo(SyncRequestStatus.FAILED);
    }

    @Test
    void freshTasksAfterRescrape_areGivenTheirOwnWindow() {
        when(tasks.findBySyncRequestId(req.getId())).thenReturn(List.of(pendingTask(Instant.now().minusSeconds(120))));

        sweeper.scrapeWatchdog();

        assertThat(req.getStatus()).isEqualTo(SyncRequestStatus.PENDING_SCRAPE);
    }

    @Test
    void workerOnline_longQueue_isNotFailed() {
        when(tasks.findBySyncRequestId(req.getId())).thenReturn(List.of(pendingTask(Instant.now().minusSeconds(3600))));
        health.recordPing(Map.of("extensionVersion", "1.9.2"));

        sweeper.scrapeWatchdog();

        assertThat(req.getStatus()).isEqualTo(SyncRequestStatus.PENDING_SCRAPE);
    }
}

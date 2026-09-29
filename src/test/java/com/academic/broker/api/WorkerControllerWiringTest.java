package com.academic.broker.api;

import com.academic.broker.repository.ArticleTaskRepository;
import com.academic.broker.repository.CitationReportTaskRepository;
import com.academic.broker.service.SessionStateService;
import com.academic.broker.service.WorkerHealthService;
import org.junit.jupiter.api.Test;
import org.springframework.boot.test.context.runner.ApplicationContextRunner;

import com.academic.broker.domain.ArticleTask;
import com.academic.broker.domain.TargetSource;
import com.academic.broker.domain.TaskStatus;

import java.util.List;
import java.util.Map;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

/** Boot-time wiring guard for the worker health beans (see the R1 deploy crash). */
class WorkerControllerWiringTest {

    @Test
    void beansCreate_andPingShowsUpInHealth() {
        new ApplicationContextRunner()
                .withBean(ArticleTaskRepository.class, () -> mock(ArticleTaskRepository.class))
                .withBean(CitationReportTaskRepository.class, () -> mock(CitationReportTaskRepository.class))
                .withUserConfiguration(WorkerHealthService.class, SessionStateService.class, WorkerController.class)
                .run(ctx -> {
                    assertThat(ctx).hasNotFailed();
                    WorkerController c = ctx.getBean(WorkerController.class);
                    c.ping(Map.of("extensionVersion", "1.9.1", "windowVisible", true, "junk", "x"));
                    Map<String, Object> h = c.workerHealth();
                    assertThat(h.get("online")).isEqualTo(true);
                    @SuppressWarnings("unchecked")
                    Map<String, Object> ping = (Map<String, Object>) h.get("ping");
                    assertThat(ping).containsEntry("extensionVersion", "1.9.1").doesNotContainKey("junk");
                });
    }

    @Test
    @SuppressWarnings("unchecked")
    void ping_listsTasksTheBrokerNoLongerWants() {
        ArticleTaskRepository repo = mock(ArticleTaskRepository.class);
        ArticleTask running = ArticleTask.builder().id(1L).targetSource(TargetSource.WOS).externalId("A")
                .status(TaskStatus.PROCESSING).build();
        ArticleTask done = ArticleTask.builder().id(2L).targetSource(TargetSource.WOS).externalId("B")
                .status(TaskStatus.COMPLETED).build();
        ArticleTask requeued = ArticleTask.builder().id(4L).targetSource(TargetSource.WOS).externalId("D")
                .status(TaskStatus.PENDING).build();
        when(repo.findAllById(any())).thenReturn(List.of(running, done, requeued)); // 3 = deleted

        WorkerController c = new WorkerController(new WorkerHealthService(), new SessionStateService(),
                repo, mock(CitationReportTaskRepository.class));
        Map<String, Object> body = c.ping(Map.of("activeTasks", List.of(
                Map.of("taskId", 1), Map.of("taskId", 2), Map.of("taskId", 3), Map.of("taskId", 4)))).getBody();

        // PENDING (watchdog re-queue while alive) is NOT cancelled — heartbeat reclaims it.
        assertThat((List<Long>) body.get("cancel")).containsExactly(2L, 3L);
    }
}

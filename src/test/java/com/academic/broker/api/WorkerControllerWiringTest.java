package com.academic.broker.api;

import com.academic.broker.repository.ArticleTaskRepository;
import com.academic.broker.repository.CitationReportTaskRepository;
import com.academic.broker.service.SessionStateService;
import com.academic.broker.service.WorkerHealthService;
import org.junit.jupiter.api.Test;
import org.springframework.boot.test.context.runner.ApplicationContextRunner;

import java.util.Map;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.Mockito.mock;

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
}

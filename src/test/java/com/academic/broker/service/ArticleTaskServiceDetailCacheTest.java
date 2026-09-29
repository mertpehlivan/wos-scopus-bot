package com.academic.broker.service;

import com.academic.broker.domain.ArticleTask;
import com.academic.broker.domain.TargetSource;
import com.academic.broker.domain.TaskStatus;
import com.academic.broker.repository.ArticleTaskRepository;
import com.academic.broker.repository.DoiEnrichTaskRepository;
import com.academic.broker.repository.PlumxTaskRepository;
import com.academic.broker.repository.SyncRequestRepository;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.test.util.ReflectionTestUtils;

import java.time.Instant;
import java.util.List;
import java.util.Map;
import java.util.Optional;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

class ArticleTaskServiceDetailCacheTest {

    @SuppressWarnings("unchecked")
    private ArticleTaskService service(ArticleTaskRepository repo, int days) {
        ArticleTaskService s = new ArticleTaskService(repo, mock(PlumxTaskRepository.class),
                mock(DoiEnrichTaskRepository.class), mock(SyncRequestRepository.class), mock(ObjectProvider.class));
        ReflectionTestUtils.setField(s, "detailCacheDays", days);
        return s;
    }

    private static ArticleTask task(long id, Instant finished, List<Map<String, Object>> articles) {
        ArticleTask t = ArticleTask.builder().id(id).targetSource(TargetSource.WOS).externalId("ABE-1")
                .status(TaskStatus.COMPLETED).build();
        t.setFinishedAt(finished);
        if (articles != null) t.setRawData(Map.of("articles", articles));
        return t;
    }

    @Test
    @SuppressWarnings("unchecked")
    void reusesRecentDetails_newestWins_withoutCitations() {
        ArticleTaskRepository repo = mock(ArticleTaskRepository.class);
        ArticleTask current = task(10, null, null);
        current.setStatus(TaskStatus.PROCESSING);
        when(repo.findById(10L)).thenReturn(Optional.of(current));

        String url1 = "https://www.webofscience.com/wos/woscc/full-record/WOS:1";
        ArticleTask newer = task(9, Instant.now().minusSeconds(86_400), List.of(
                Map.of("articleUrl", url1 + "#wos-task-id=9", "accession", "WOS:1", "indexType", "Q1",
                        "wosCitations", 9, "authors", List.of("Kaplan, Erdar", "Soykasap, Omer")),
                Map.of("articleUrl", "https://x/full-record/WOS:2", "accession", "")));      // no detail
        ArticleTask older = task(8, Instant.now().minusSeconds(5 * 86_400), List.of(
                Map.of("articleUrl", url1, "accession", "WOS:1", "indexType", "Q3"),
                Map.of("articleUrl", "https://x/full-record/WOS:3", "accession", "WOS:3")));
        ArticleTask stale = task(7, Instant.now().minusSeconds(60 * 86_400), List.of(
                Map.of("articleUrl", "https://x/full-record/WOS:4", "accession", "WOS:4")));
        when(repo.findTop10ByTargetSourceAndExternalIdAndStatusOrderByIdDesc(TargetSource.WOS, "ABE-1", TaskStatus.COMPLETED))
                .thenReturn(List.of(newer, older, stale));

        Map<String, Object> out = service(repo, 30).detailCache(10L);
        Map<String, Map<String, Object>> details = (Map<String, Map<String, Object>>) out.get("details");

        assertThat(details).containsOnlyKeys(url1, "https://x/full-record/WOS:3");
        assertThat(details.get(url1)).containsEntry("indexType", "Q1")      // newest run wins
                .containsEntry("authors", "Kaplan, Erdar; Soykasap, Omer")
                .doesNotContainKey("wosCitations");
        assertThat((List<Long>) out.get("sourceTaskIds")).containsExactly(9L, 8L);
    }

    @Test
    @SuppressWarnings("unchecked")
    void disabledOrNonWos_returnsEmpty() {
        ArticleTaskRepository repo = mock(ArticleTaskRepository.class);
        ArticleTask current = task(10, null, null);
        when(repo.findById(10L)).thenReturn(Optional.of(current));
        assertThat((Map<String, Object>) service(repo, 0).detailCache(10L).get("details")).isEmpty();
    }
}

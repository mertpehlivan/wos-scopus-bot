package com.academic.broker.api;

import com.academic.broker.api.dto.AddTasksRequest;
import com.academic.broker.api.dto.AddTasksResponse;
import com.academic.broker.api.dto.AuthorMetricsRequest;
import com.academic.broker.api.dto.CompleteTaskRequest;
import com.academic.broker.api.dto.ConsumeTasksResponse;
import com.academic.broker.api.dto.PollTaskResponse;
import com.academic.broker.domain.TargetSource;
import com.academic.broker.service.ArticleTaskService;
import jakarta.validation.Valid;
import lombok.RequiredArgsConstructor;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

@RestController
@RequestMapping("/api/tasks")
@RequiredArgsConstructor
public class ArticleTaskController {

    private final ArticleTaskService taskService;

    /**
     * Ana sistem: Yeni WoS/Scopus ID'lerini kuyruğa ekler.
     * force=true ise PENDING/PROCESSING kontrolü atlanır (yenileme modu).
     */
    @PostMapping(consumes = MediaType.APPLICATION_JSON_VALUE, produces = MediaType.APPLICATION_JSON_VALUE)
    public ResponseEntity<AddTasksResponse> addTasks(
            @Valid @RequestBody AddTasksRequest request,
            @RequestParam(name = "force", defaultValue = "false") boolean force) {
        AddTasksResponse response = taskService.addTasks(request.getSource(), request.getExternalIds(),
                request.getRedirectUrl(), force, request.getTaskType());
        return ResponseEntity.status(HttpStatus.CREATED).body(response);
    }

    /**
     * Eklenti: İşlenmemiş (PENDING) bir ID talep eder. source=WOS veya
     * source=SCOPUS.
     * Yoksa 204 No Content döner.
     */
    @GetMapping(value = "/poll", produces = MediaType.APPLICATION_JSON_VALUE)
    public ResponseEntity<PollTaskResponse> pollTask(@RequestParam("source") TargetSource source) {
        PollTaskResponse response = taskService.pollTask(source);
        if (response == null) {
            return ResponseEntity.noContent().build();
        }
        return ResponseEntity.ok(response);
    }

    /**
     * Eklenti: Scrape tamamlandı, raw JSON gönderilir; durum COMPLETED olur.
     */
    @PostMapping(value = "/{taskId}/complete", consumes = MediaType.APPLICATION_JSON_VALUE)
    public ResponseEntity<Void> completeTask(
            @PathVariable Long taskId,
            @Valid @RequestBody CompleteTaskRequest request) {
        taskService.completeTask(taskId, request);
        return ResponseEntity.ok().build();
    }

    /**
     * Eklenti: Yazar metrikleri (h-index, publications, citations) ayrı olarak
     * gönderilir.
     * Task durumu değişmez (PROCESSING kalır).
     */
    @PostMapping(value = "/{taskId}/author-metrics", consumes = MediaType.APPLICATION_JSON_VALUE)
    public ResponseEntity<Void> saveAuthorMetrics(
            @PathVariable Long taskId,
            @Valid @RequestBody AuthorMetricsRequest request) {
        taskService.saveAuthorMetrics(taskId, request);
        return ResponseEntity.ok().build();
    }

    /**
     * Eklenti: Scrape başarısız; durum FAILED olur.
     */
    @PostMapping(value = "/{taskId}/fail")
    public ResponseEntity<Void> failTask(@PathVariable Long taskId) {
        taskService.failTask(taskId);
        return ResponseEntity.ok().build();
    }

    /**
     * Ana sistem: COMPLETED task'ları alır; response'tan sonra veritabanından
     * silinir (ephemeral).
     */
    @GetMapping(value = "/consume", produces = MediaType.APPLICATION_JSON_VALUE)
    public ResponseEntity<ConsumeTasksResponse> consumeCompletedTasks() {
        ConsumeTasksResponse response = taskService.consumeCompletedTasks();
        return ResponseEntity.ok(response);
    }

    /**
     * Ana sistem: Belirli bir externalId için mevcut task durumunu sorgular.
     * Aktif görev yoksa 204 döner. Görev varsa { taskId, status } döner.
     */
    @GetMapping(value = "/status", produces = MediaType.APPLICATION_JSON_VALUE)
    public ResponseEntity<?> getTaskStatus(
            @RequestParam("source") TargetSource source,
            @RequestParam("externalId") String externalId) {
        return taskService.findLatestStatus(source, externalId)
                .map(ResponseEntity::ok)
                .orElseGet(() -> ResponseEntity.noContent().build());
    }
}

package com.academic.broker.api;

import com.academic.broker.api.dto.AddTasksResponse;
import com.academic.broker.api.dto.CompleteTaskRequest;
import com.academic.broker.api.dto.ConsumeTasksResponse;
import com.academic.broker.api.dto.PollTaskResponse;
import com.academic.broker.service.ArticleTaskService;
import jakarta.validation.Valid;
import lombok.RequiredArgsConstructor;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;

import java.util.List;
import java.util.Map;

@RestController
@RequestMapping("/api/plumx-tasks")
@RequiredArgsConstructor
public class PlumxTaskController {

    private final ArticleTaskService taskService;

    /**
     * Add PlumX DOI tasks in batch.
     * <p>Accepts:
     * <pre>{ "dois": ["10.1234/...", "10.5678/..."], "syncRequestId": "uuid-or-null" }</pre>
     * The {@code syncRequestId} can also be passed as a query parameter — useful
     * when the worker submits PlumX tasks itself as a follow-on to an OpenAlex
     * completion and wants to keep the request payload minimal.
     */
    @PostMapping(consumes = MediaType.APPLICATION_JSON_VALUE, produces = MediaType.APPLICATION_JSON_VALUE)
    public ResponseEntity<AddTasksResponse> addPlumxTasks(
            @RequestBody Map<String, Object> request,
            @RequestParam(name = "syncRequestId", required = false) java.util.UUID syncRequestIdQuery) {
        @SuppressWarnings("unchecked")
        List<String> dois = (List<String>) request.getOrDefault("dois",
                request.getOrDefault("externalIds", List.of()));

        java.util.UUID syncRequestId = syncRequestIdQuery;
        Object bodyId = request.get("syncRequestId");
        if (bodyId instanceof String s && !s.isBlank()) {
            try { syncRequestId = java.util.UUID.fromString(s); } catch (Exception ignored) {}
        } else if (bodyId instanceof java.util.UUID u) {
            syncRequestId = u;
        }

        AddTasksResponse response = taskService.addPlumxTasks(dois, syncRequestId);
        return ResponseEntity.status(HttpStatus.CREATED).body(response);
    }

    /**
     * Poll a batch of PlumX tasks (claim N PENDING→PROCESSING at once).
     */
    @GetMapping(value = "/poll", produces = MediaType.APPLICATION_JSON_VALUE)
    public ResponseEntity<List<PollTaskResponse>> pollPlumxBatch(
            @RequestParam(name = "batchSize", defaultValue = "3") int batchSize) {
        List<PollTaskResponse> tasks = taskService.pollPlumxBatch(batchSize);
        if (tasks.isEmpty()) {
            return ResponseEntity.noContent().build();
        }
        return ResponseEntity.ok(tasks);
    }

    @PostMapping(value = "/{taskId}/complete", consumes = MediaType.APPLICATION_JSON_VALUE)
    public ResponseEntity<Void> completePlumxTask(
            @PathVariable Long taskId,
            @Valid @RequestBody CompleteTaskRequest request) {
        taskService.completePlumxTask(taskId, request);
        return ResponseEntity.ok().build();
    }

    @PostMapping(value = "/{taskId}/fail")
    public ResponseEntity<Void> failPlumxTask(@PathVariable Long taskId) {
        taskService.failPlumxTask(taskId);
        return ResponseEntity.ok().build();
    }

    @PostMapping(value = "/{taskId}/ack")
    public ResponseEntity<Void> ackPlumxTask(@PathVariable Long taskId) {
        taskService.ackConsumedPlumxTask(taskId);
        return ResponseEntity.ok().build();
    }

    @GetMapping(value = "/consume", produces = MediaType.APPLICATION_JSON_VALUE)
    public ResponseEntity<ConsumeTasksResponse> consumeCompletedPlumxTasks() {
        ConsumeTasksResponse response = taskService.consumeCompletedPlumxTasks();
        return ResponseEntity.ok(response);
    }

    /**
     * Deletes all PENDING PlumX tasks. Used by the backend when a new sync
     * starts (so leftover tasks from prior runs don't keep the worker busy)
     * or when the user cancels a sync. Currently in-progress (PROCESSING)
     * tasks are left alone so the worker can finish them cleanly.
     *
     * <p>Returns the count of deleted tasks.
     */
    @DeleteMapping("/pending")
    public ResponseEntity<Map<String, Object>> deletePendingPlumxTasks() {
        int deleted = taskService.deletePendingPlumxTasks();
        return ResponseEntity.ok(Map.of("deleted", deleted));
    }
}

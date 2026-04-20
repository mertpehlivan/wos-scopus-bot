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
     * Accepts: { "dois": ["10.1234/...", "10.5678/..."] }
     */
    @PostMapping(consumes = MediaType.APPLICATION_JSON_VALUE, produces = MediaType.APPLICATION_JSON_VALUE)
    public ResponseEntity<AddTasksResponse> addPlumxTasks(
            @RequestBody Map<String, List<String>> request) {
        List<String> dois = request.getOrDefault("dois",
                request.getOrDefault("externalIds", List.of()));
        AddTasksResponse response = taskService.addPlumxTasks(dois);
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

    @GetMapping(value = "/consume", produces = MediaType.APPLICATION_JSON_VALUE)
    public ResponseEntity<ConsumeTasksResponse> consumeCompletedPlumxTasks() {
        ConsumeTasksResponse response = taskService.consumeCompletedPlumxTasks();
        return ResponseEntity.ok(response);
    }
}

package com.academic.broker.api.dto;

import com.academic.broker.domain.TargetSource;
import com.academic.broker.domain.TaskType;
import jakarta.validation.constraints.NotEmpty;
import jakarta.validation.constraints.NotNull;
import lombok.AllArgsConstructor;
import lombok.Builder;
import lombok.Data;
import lombok.NoArgsConstructor;

import java.util.List;

@Data
@Builder
@NoArgsConstructor
@AllArgsConstructor
public class AddTasksRequest {

    @NotNull(message = "source is required")
    private TargetSource source;

    @NotEmpty(message = "externalIds must not be empty")
    private List<String> externalIds;

    /**
     * Optional. The exact profile URL the Chrome extension should open.
     * If provided, this URL is stored and returned in the poll/consume responses.
     * If not provided the worker builds the URL from externalId + source.
     */
    private String redirectUrl;

    /**
     * Optional. METRICS_ONLY = only scrape author metrics,
     * FULL_SCRAPE (default) = metrics + article details.
     */
    private TaskType taskType;
}

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
import java.util.UUID;

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

    /**
     * Optional. When set, every task created by this call is stamped with the
     * given {@code SyncRequest} id; the worker bridge then routes the scraped
     * payload into that request's {@code stagedData} when the task completes.
     * Backend's "Senkronize Et" flow always passes this; one-off operator
     * refreshes typically don't.
     */
    private UUID syncRequestId;
}

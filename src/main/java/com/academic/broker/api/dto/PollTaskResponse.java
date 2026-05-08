package com.academic.broker.api.dto;

import com.academic.broker.domain.TargetSource;
import com.academic.broker.domain.TaskType;
import lombok.AllArgsConstructor;
import lombok.Builder;
import lombok.Data;
import lombok.NoArgsConstructor;

import java.util.UUID;

@Data
@Builder
@NoArgsConstructor
@AllArgsConstructor
public class PollTaskResponse {

    private Long taskId;
    private TargetSource source;
    private String externalId;

    /**
     * The exact URL the worker should open; may be null if not specified when task
     * was added.
     */
    private String redirectUrl;

    /**
     * METRICS_ONLY or FULL_SCRAPE — tells the worker what to do.
     */
    private TaskType taskType;

    /**
     * The sync request this task belongs to (if any). The worker forwards
     * this back when it submits follow-on work — e.g. PlumX fan-out after an
     * OpenAlex completion — so the broker can stamp the new tasks with the
     * same request id and route their results into the same staged data.
     */
    private UUID syncRequestId;
}

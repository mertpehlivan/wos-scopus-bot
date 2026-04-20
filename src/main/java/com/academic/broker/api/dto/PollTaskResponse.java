package com.academic.broker.api.dto;

import com.academic.broker.domain.TargetSource;
import com.academic.broker.domain.TaskType;
import lombok.AllArgsConstructor;
import lombok.Builder;
import lombok.Data;
import lombok.NoArgsConstructor;

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
}

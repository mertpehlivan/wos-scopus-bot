package com.academic.broker.api.dto;

import com.academic.broker.domain.TargetSource;
import lombok.AllArgsConstructor;
import lombok.Builder;
import lombok.Data;
import lombok.NoArgsConstructor;

import java.util.Map;

@Data
@Builder
@NoArgsConstructor
@AllArgsConstructor
public class ConsumedTaskDto {

    private Long taskId;
    private TargetSource source;
    private String externalId;
    private String redirectUrl;
    private com.academic.broker.domain.TaskType taskType;
    private Map<String, Object> authorMetricsData;
    private Map<String, Object> rawData;
}

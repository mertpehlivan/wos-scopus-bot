package com.academic.broker.api.dto;

import jakarta.validation.constraints.NotNull;
import lombok.AllArgsConstructor;
import lombok.Builder;
import lombok.Data;
import lombok.NoArgsConstructor;

import java.util.Map;

/**
 * Raw scraped data from the browser extension (JSON body).
 */
@Data
@Builder
@NoArgsConstructor
@AllArgsConstructor
public class CompleteTaskRequest {

    @NotNull(message = "rawData is required")
    private Map<String, Object> rawData;
}

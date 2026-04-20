package com.academic.broker.api.dto;

import jakarta.validation.constraints.NotNull;
import lombok.AllArgsConstructor;
import lombok.Builder;
import lombok.Data;
import lombok.NoArgsConstructor;

import java.util.Map;

/**
 * Author-level metrics sent separately from publication data.
 * Contains h-index, publication count, sum of times cited, citing articles, and
 * profile URL.
 */
@Data
@Builder
@NoArgsConstructor
@AllArgsConstructor
public class AuthorMetricsRequest {

    @NotNull(message = "authorMetrics is required")
    private Map<String, Object> authorMetrics;

    private String url;
}

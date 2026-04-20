package com.academic.broker.api.dto;

import lombok.AllArgsConstructor;
import lombok.Data;
import lombok.NoArgsConstructor;

/**
 * Poll response for DOI-enrichment tasks.
 * Simpler structure than PollTaskResponse — DOI-based tasks don't need
 * redirectUrl or taskType.
 */
@Data
@NoArgsConstructor
@AllArgsConstructor
public class DoiPollResponse {
    /** Broker-assigned task ID */
    private Long taskId;

    /** The DOI to enrich — used as externalId by the Chrome extension */
    private String externalId;

    /** Source: WOS or SCHOLAR */
    private String source;
}

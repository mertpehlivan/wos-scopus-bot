package com.academic.broker.service;

import org.junit.jupiter.api.Test;

import java.util.HashMap;
import java.util.Map;

import static org.assertj.core.api.Assertions.assertThat;

class CanonicalizeMetricsTest {

    @Test
    void wosDocumentsPreferCoreCollectionOverTotalDocuments() {
        Map<String, Object> summary = new HashMap<>();
        summary.put("totalDocuments", 25);
        summary.put("wosCoreCollectionPublications", 15);
        Map<String, Object> raw = new HashMap<>();
        raw.put("hIndex", 5);
        raw.put("publications", 25);
        raw.put("sumOfTimesCited", 117);
        raw.put("profileSummary", summary);

        Map<String, Object> out = SyncRequestWorkerBridge.canonicalizeMetrics(raw);

        assertThat(out.get("documents")).isEqualTo(15);
        assertThat(out.get("citations")).isEqualTo(117);
    }

    @Test
    void fallsBackToPublicationsWhenCoreCollectionMissing() {
        Map<String, Object> summary = new HashMap<>();
        summary.put("wosCoreCollectionPublications", null);
        Map<String, Object> raw = new HashMap<>();
        raw.put("publications", 25);
        raw.put("profileSummary", summary);

        assertThat(SyncRequestWorkerBridge.canonicalizeMetrics(raw).get("documents")).isEqualTo(25);
    }

    @Test
    void nonWosPayloadUnchanged() {
        Map<String, Object> raw = new HashMap<>();
        raw.put("documents", 14);
        raw.put("citations", 116);

        assertThat(SyncRequestWorkerBridge.canonicalizeMetrics(raw).get("documents")).isEqualTo(14);
    }
}

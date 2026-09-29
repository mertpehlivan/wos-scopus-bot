package com.academic.broker.service;

import org.junit.jupiter.api.Test;

import java.util.HashMap;
import java.util.List;
import java.util.Map;

import static org.assertj.core.api.Assertions.assertThat;

class BackendApplyServiceOverrideTest {

    @SuppressWarnings("unchecked")
    private static Map<String, Object> metricsOf(Map<String, Object> staged) {
        return (Map<String, Object>) ((Map<String, Object>) staged.get("OPENALEX")).get("metrics");
    }

    @Test
    void operatorYearlyList_movesIntoStaged_keepingOtherMetrics() {
        Map<String, Object> stagedMetrics = new HashMap<>(Map.of(
                "hIndex", 3, "citations", 25,
                "yearlyStats", List.of(Map.of("year", 1934, "citations", 3), Map.of("year", 2020, "citations", 14))));
        Map<String, Object> staged = new HashMap<>(Map.of("OPENALEX", new HashMap<>(Map.of("metrics", stagedMetrics))));
        Map<String, Object> originalOa = (Map<String, Object>) staged.get("OPENALEX");

        List<Map<String, Object>> operatorList = List.of(Map.of("year", 2020, "citations", 14));
        Map<String, Object> edited = new HashMap<>(Map.of(
                "OPENALEX", Map.of("metrics", Map.of("yearlyStats", operatorList)),
                "WOS", Map.of("metrics", Map.of("hIndex", 9))));

        BackendApplyService.applyOperatorYearlyOverride(staged, edited);

        Map<String, Object> m = metricsOf(staged);
        assertThat(m).containsEntry("hIndex", 3).containsEntry("citations", 25);
        assertThat((List<?>) m.get("yearlyStats")).hasSize(1);
        assertThat(edited).doesNotContainKey("OPENALEX").containsKey("WOS");
        // the original staged block was not mutated (copies only)
        assertThat((List<?>) ((Map<String, Object>) originalOa.get("metrics")).get("yearlyStats")).hasSize(2);
    }

    @Test
    void otherOpenAlexEdits_stayInEditedData() {
        Map<String, Object> staged = new HashMap<>(Map.of("OPENALEX",
                new HashMap<>(Map.of("metrics", new HashMap<>(Map.of("hIndex", 3))))));
        Map<String, Object> edited = new HashMap<>(Map.of("OPENALEX",
                Map.of("metrics", Map.of("yearlyStats", List.of(), "hIndex", 4))));

        BackendApplyService.applyOperatorYearlyOverride(staged, edited);

        assertThat((Map<String, Object>) ((Map<String, Object>) edited.get("OPENALEX")).get("metrics"))
                .containsEntry("hIndex", 4).doesNotContainKey("yearlyStats");
    }

    @Test
    void noOverride_isANoOp() {
        Map<String, Object> staged = new HashMap<>(Map.of("OPENALEX", Map.of("metrics", Map.of("hIndex", 3))));
        Map<String, Object> edited = new HashMap<>(Map.of("WOS", Map.of("metrics", Map.of("hIndex", 9))));

        BackendApplyService.applyOperatorYearlyOverride(staged, edited);

        assertThat(edited).containsOnlyKeys("WOS");
        assertThat(metricsOf(staged)).containsOnlyKeys("hIndex");
    }
}

package com.academic.broker.service.yearly;

import org.junit.jupiter.api.Test;

import java.time.Clock;
import java.time.Instant;
import java.time.ZoneOffset;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;

import static org.assertj.core.api.Assertions.assertThat;

/** Works-based (citing-year) series — Erdar Kaplan's real OpenAlex works. */
class YearlyStatsWorksTest {

    private static final int NOW = 2026;

    private static Map<String, Object> work(Integer year, int[]... counts) {
        List<List<Integer>> c = new ArrayList<>();
        for (int[] p : counts) c.add(List.of(p[0], p[1]));
        Map<String, Object> m = new HashMap<>();
        m.put("year", year);
        m.put("counts", c);
        return m;
    }

    private static Map<String, Object> pub(String id, int year, int citations, String doi, String... sources) {
        Map<String, Object> p = new HashMap<>();
        p.put("openAlexId", id);
        p.put("year", year);
        p.put("doi", doi);
        p.put("title", "T-" + id);
        p.put("sources", List.of(sources));
        p.put("citations", Map.of("openalex", citations));
        return p;
    }

    private static Map<String, Object> works() {
        Map<String, Object> w = new LinkedHashMap<>();
        w.put("W2087067948", work(1934));                                   // namesake, lifetime 3
        w.put("W653079410", work(1968));                                    // namesake
        w.put("W7135235484", work(2012));
        w.put("W2128706315", work(2013, new int[]{2023, 1}, new int[]{2016, 1}, new int[]{2015, 1}));
        w.put("W2609226859", work(2014, new int[]{2015, 1}));
        w.put("W2791242563", work(2018, new int[]{2025, 1}, new int[]{2024, 1}, new int[]{2023, 2}));
        w.put("W3099167440", work(2020, new int[]{2026, 1}, new int[]{2025, 5}, new int[]{2024, 3},
                new int[]{2023, 3}, new int[]{2022, 2}));
        return w;
    }

    private static List<Map<String, Object>> pubs() {
        return List.of(
                pub("W2087067948", 1934, 3, "10.1/distill", "OPENALEX", "PLUMX"),
                pub("W653079410", 1968, 0, null, "OPENALEX"),
                pub("W7135235484", 2012, 0, null, "OPENALEX", "PLUMX"),
                pub("W2128706315", 2013, 3, "10.1/reflector", "OPENALEX", "WOS", "SCHOLAR"),
                pub("W2609226859", 2014, 1, null, "OPENALEX", "PLUMX"),
                pub("W2791242563", 2018, 4, "10.1/ptfe", "OPENALEX", "WOS", "SCHOLAR"),
                pub("W3099167440", 2020, 14, "10.1/tribo", "OPENALEX", "WOS", "SCHOLAR"));
    }

    private static List<Map<String, Object>> scholar() {
        return List.of(Map.of("year", 2016, "citations", 3), Map.of("year", 2023, "citations", 8));
    }

    private static Map<Integer, Integer> citationsByYear(List<Map<String, Object>> rows) {
        Map<Integer, Integer> m = new LinkedHashMap<>();
        for (Map<String, Object> r : rows) {
            int c = ((Number) r.get("citations")).intValue();
            if (c > 0) m.put(((Number) r.get("year")).intValue(), c);
        }
        return m;
    }

    @Test
    void kaplan_citingYearSeries_excludesNamesakeWorks() {
        var r = YearlyStatsSanitizer.sanitizeFromWorks(works(), pubs(), scholar(), null, Set.of(), NOW);

        assertThat(r.basis()).isEqualTo(YearlyStatsSanitizer.BASIS_WORKS);
        assertThat(r.window().start()).isEqualTo(2013);
        assertThat(citationsByYear(r.kept())).containsExactly(
                Map.entry(2015, 2), Map.entry(2016, 1), Map.entry(2022, 2), Map.entry(2023, 6),
                Map.entry(2024, 4), Map.entry(2025, 6), Map.entry(2026, 1));
        assertThat(r.kept()).extracting(m -> m.get("year")).doesNotContain(1934, 1968);
        assertThat(r.excludedWorks()).extracting(YearlyStatsSanitizer.WorkExclusion::id)
                .containsExactlyInAnyOrder("W2087067948", "W653079410");
        assertThat(r.excludedWorks()).allMatch(e -> e.reason().equals("SUSPICIOUS_WORK"));
        assertThat(r.citationsAll()).isEqualTo(25);
        assertThat(r.citationsIncluded()).isEqualTo(22);
        // full series keeps every work (restorable in the panel)
        assertThat(r.fullSeries()).extracting(m -> m.get("year")).contains(1934, 1968);
    }

    @Test
    void operatorExcludedWork_isLeftOut() {
        var r = YearlyStatsSanitizer.sanitizeFromWorks(works(), pubs(), scholar(), null, Set.of("W2791242563"), NOW);

        assertThat(r.citationsIncluded()).isEqualTo(18);
        assertThat(citationsByYear(r.kept())).containsEntry(2023, 4).containsEntry(2025, 5).containsEntry(2024, 3);
        assertThat(r.excludedWorks()).anyMatch(e -> e.id().equals("W2791242563") && e.reason().equals("OPERATOR"));
    }

    @Test
    void excludedWorkIds_mapsPanelPubKeys() {
        Map<String, Object> staged = Map.of("publications", pubs());
        Map<String, Object> approved = Map.of(
                "_pub:doi:10.1/ptfe", false,             // unticked → excluded
                "_pub:doi:10.1/tribo", true,
                "_pub:title:t-w653079410", false);       // title key (no DOI)
        assertThat(YearlyStatsSanitizerService.excludedWorkIds(staged, approved))
                .containsExactlyInAnyOrder("W2791242563", "W653079410");
    }

    // ── service ───────────────────────────────────────────────────────

    private static Clock clock() {
        return Clock.fixed(Instant.parse("2026-09-29T00:00:00Z"), ZoneOffset.UTC);
    }

    private static Map<String, Object> staged() {
        Map<String, Object> metrics = new HashMap<>();
        metrics.put("citations", 25);
        metrics.put("yearlyStats", List.of(Map.of("year", 1934, "citations", 3, "publications", 1),
                Map.of("year", 2020, "citations", 14, "publications", 1)));   // author-level, pub-year grouped
        metrics.put("worksCitingYears", works());
        Map<String, Object> scholarBlock = new HashMap<>(Map.of("metrics", Map.of("yearlyStats", scholar())));
        Map<String, Object> s = new HashMap<>();
        s.put("OPENALEX", new HashMap<>(Map.of("metrics", metrics)));
        s.put("SCHOLAR", scholarBlock);
        s.put("publications", pubs());
        return s;
    }

    @SuppressWarnings("unchecked")
    private static Map<String, Object> m(Map<String, Object> staged) {
        return (Map<String, Object>) ((Map<String, Object>) staged.get("OPENALEX")).get("metrics");
    }

    @Test
    @SuppressWarnings("unchecked")
    void onMode_worksPath_replacesSeries_keepsAuthorLevel_andIsIdempotent() {
        Map<String, Object> s = staged();
        var svc = new YearlyStatsSanitizerService(YearlyStatsSanitizerService.Mode.ON, clock());
        svc.apply(s);
        svc.apply(s);

        Map<String, Object> mm = m(s);
        assertThat(mm.get("yearlyStatsBasis")).isEqualTo(YearlyStatsSanitizer.BASIS_WORKS);
        assertThat((List<Map<String, Object>>) mm.get("yearlyStats")).extracting(r -> r.get("year"))
                .doesNotContain(1934).contains(2023, 2026);
        assertThat((List<?>) mm.get("yearlyStatsAuthorLevel")).hasSize(2);
        Map<String, Object> report = (Map<String, Object>) mm.get("yearlyStatsReport");
        assertThat(report.get("applied")).isEqualTo(true);
        assertThat(report.get("citationsAll")).isEqualTo(25);
        assertThat(report.get("citationsIncluded")).isEqualTo(22);
        assertThat((List<?>) report.get("excludedWorks")).hasSize(2);
        assertThat(mm.get("citations")).isEqualTo(25); // totals untouched
    }

    @Test
    void offMode_restoresAuthorLevelSeries() {
        Map<String, Object> s = staged();
        new YearlyStatsSanitizerService(YearlyStatsSanitizerService.Mode.ON, clock()).apply(s);
        new YearlyStatsSanitizerService(YearlyStatsSanitizerService.Mode.OFF, clock()).apply(s);

        Map<String, Object> mm = m(s);
        assertThat((List<?>) mm.get("yearlyStats")).hasSize(2);
        assertThat(mm).doesNotContainKeys("yearlyStatsRaw", "yearlyStatsReport", "yearlyStatsAuthorLevel", "yearlyStatsBasis")
                .containsKey("worksCitingYears");
    }

    @Test
    @SuppressWarnings("unchecked")
    void r1StagedData_withoutWorks_staysOnAuthorPath() {
        Map<String, Object> s = staged();
        m(s).remove("worksCitingYears");
        new YearlyStatsSanitizerService(YearlyStatsSanitizerService.Mode.ON, clock()).apply(s);

        Map<String, Object> mm = m(s);
        assertThat(mm.get("yearlyStatsBasis")).isEqualTo(YearlyStatsSanitizer.BASIS_AUTHOR);
        assertThat((List<Map<String, Object>>) mm.get("yearlyStats")).extracting(r -> r.get("year")).containsExactly(2020);
    }
}

package com.academic.broker.service.yearly;

import org.junit.jupiter.api.Test;

import java.time.Clock;
import java.time.Instant;
import java.time.ZoneOffset;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

import static org.assertj.core.api.Assertions.assertThat;

class YearlyStatsSanitizerTest {

    private static final int NOW = 2026;

    private static Map<String, Object> row(int year, int citations, int publications) {
        Map<String, Object> m = new HashMap<>();
        m.put("year", year);
        m.put("citations", citations);
        m.put("publications", publications);
        return m;
    }

    private static Map<String, Object> cit(int year, int citations) {
        Map<String, Object> m = new HashMap<>();
        m.put("year", year);
        m.put("citations", citations);
        return m;
    }

    private static Map<String, Object> pub(Object year, String... sources) {
        Map<String, Object> m = new HashMap<>();
        m.put("year", year);
        m.put("sources", List.of(sources));
        return m;
    }

    /** Real Gümüşhane case (Erdar Kaplan, sync e9873d5b), trimmed. */
    private static List<Map<String, Object>> kaplanOpenAlex() {
        return List.of(row(1934, 3, 1), row(1968, 0, 1), row(2012, 0, 1), row(2013, 3, 1),
                row(2014, 1, 3), row(2015, 0, 2), row(2018, 4, 1), row(2020, 14, 1), row(2025, 0, 1));
    }

    private static List<Map<String, Object>> kaplanPubs() {
        return List.of(
                pub(1934, "OPENALEX", "PLUMX"),                       // namesake — not his
                pub(2012, "OPENALEX", "PLUMX"),
                pub(2013, "OPENALEX", "WOS", "SCHOLAR", "PLUMX"),     // corroborated → C = 2013
                pub(2015, "OPENALEX", "SCHOLAR", "PLUMX"),
                pub(2020, "OPENALEX", "WOS", "SCHOLAR", "PLUMX"));
    }

    private static List<Map<String, Object>> kaplanScholar() {
        return List.of(cit(2016, 3), cit(2019, 1), cit(2021, 1), cit(2023, 8), cit(2024, 7), cit(2025, 7), cit(2026, 2));
    }

    @Test
    void kaplan_removesNamesakeYearsOnly() {
        var r = YearlyStatsSanitizer.sanitize(kaplanOpenAlex(), kaplanPubs(), kaplanScholar(), null, NOW);

        assertThat(r.window().start()).isEqualTo(2013);
        assertThat(r.window().corroboratedStart()).isEqualTo(2013);
        assertThat(r.window().scholarStart()).isEqualTo(2016);
        assertThat(r.removed()).extracting(YearlyStatsSanitizer.Decision::year).containsExactly(1934, 1968);
        assertThat(r.removed()).allMatch(d -> d.rule() == YearlyStatsSanitizer.Rule.BEFORE_CAREER);
        assertThat(r.kept()).extracting(m -> m.get("year"))
                .containsExactly(2012, 2013, 2014, 2015, 2018, 2020, 2025);
        assertThat(r.guardTriggered()).isFalse();
    }

    @Test
    void plumxAloneDoesNotCorroborate() {
        var pubs = List.of(pub(1934, "OPENALEX", "PLUMX"));
        assertThat(YearlyStatsSanitizer.corroboratedStart(pubs, NOW)).isNull();
    }

    @Test
    void seniorResearcher_keepsEveryRealYear() {
        var series = List.of(row(1975, 2, 1), row(1976, 5, 1), row(1990, 10, 2), row(2010, 20, 3));
        var pubs = List.of(pub(1975, "OPENALEX", "WOS"), pub(2010, "OPENALEX", "SCOPUS"));
        var r = YearlyStatsSanitizer.sanitize(series, pubs, List.of(cit(1978, 1)), null, NOW);

        assertThat(r.window().start()).isEqualTo(1975);
        assertThat(r.removed()).isEmpty();
        assertThat(r.kept()).hasSize(4);
    }

    @Test
    void scholarStartWidensWindowWhenEarlierThanCorroborated() {
        // Old but real paper missing from the corroborated list; Scholar knows it.
        var series = List.of(row(2001, 4, 1), row(2015, 9, 2));
        var pubs = List.of(pub(2015, "OPENALEX", "WOS"));
        var r = YearlyStatsSanitizer.sanitize(series, pubs, List.of(cit(2002, 1), cit(2016, 3)), null, NOW);

        assertThat(r.window().start()).isEqualTo(2002);
        assertThat(r.window().basis()).isEqualTo("SCHOLAR_START");
        assertThat(r.removed()).isEmpty(); // 2001 >= 2002 - TOL
    }

    @Test
    void noEvidence_onlyFlagsIsolatedRows_neverRemoves() {
        var series = List.of(row(1934, 3, 1), row(2012, 0, 1), row(2020, 14, 1));
        var r = YearlyStatsSanitizer.sanitize(series, List.of(pub(1934, "OPENALEX")), null, null, NOW);

        assertThat(r.window().start()).isNull();
        assertThat(r.window().basis()).isEqualTo("NONE");
        assertThat(r.removed()).isEmpty();
        assertThat(r.kept()).hasSize(3);
        assertThat(r.flagged()).extracting(YearlyStatsSanitizer.Decision::year).containsExactly(1934);
    }

    @Test
    void futureAndInvalidYearsRemovedEvenWithoutEvidence() {
        var series = List.of(row(0, 1, 0), row(2020, 5, 1), row(2031, 2, 0));
        var r = YearlyStatsSanitizer.sanitize(series, null, null, null, NOW);

        assertThat(r.removed()).extracting(YearlyStatsSanitizer.Decision::rule)
                .containsExactlyInAnyOrder(YearlyStatsSanitizer.Rule.INVALID_YEAR, YearlyStatsSanitizer.Rule.FUTURE);
        assertThat(r.kept()).extracting(m -> m.get("year")).containsExactly(2020);
    }

    @Test
    void neverRemovesTheWholeSeries() {
        var series = List.of(row(1934, 3, 1), row(1968, 0, 1));
        var pubs = List.of(pub(2015, "OPENALEX", "WOS"));
        var r = YearlyStatsSanitizer.sanitize(series, pubs, null, null, NOW);

        assertThat(r.guardTriggered()).isTrue();
        assertThat(r.removed()).isEmpty();
        assertThat(r.kept()).hasSize(2);
    }

    @Test
    void wosSeriesUsedOnlyAsFallback_andAcceptsTotalCitationsKey() {
        Map<String, Object> w = new HashMap<>();
        w.put("year", 2016);
        w.put("totalCitations", 1);
        var series = List.of(row(1934, 3, 1), row(2018, 4, 1));
        var r = YearlyStatsSanitizer.sanitize(series, null, null, List.of(w), NOW);

        assertThat(r.window().basis()).isEqualTo("WOS_START");
        assertThat(r.removed()).extracting(YearlyStatsSanitizer.Decision::year).containsExactly(1934);
    }

    @Test
    void stringYearsAreParsed() {
        var series = List.of(Map.<String, Object>of("year", "1934", "citations", "3"),
                Map.<String, Object>of("year", "2020", "citations", "14"));
        var pubs = List.of(pub("2013", "OPENALEX", "WOS"));
        var r = YearlyStatsSanitizer.sanitize(series, pubs, null, null, NOW);

        assertThat(r.removed()).extracting(YearlyStatsSanitizer.Decision::year).containsExactly(1934);
    }

    // ── Service (mode handling on the staged blob) ──────────────────────

    private static Clock fixedClock() {
        return Clock.fixed(Instant.parse("2026-09-29T00:00:00Z"), ZoneOffset.UTC);
    }

    private static Map<String, Object> kaplanStaged() {
        Map<String, Object> metrics = new HashMap<>();
        metrics.put("hIndex", 3);
        metrics.put("citations", 25);
        metrics.put("yearlyStats", new ArrayList<>(kaplanOpenAlex()));
        Map<String, Object> oa = new HashMap<>();
        oa.put("metrics", metrics);
        Map<String, Object> scholarMetrics = new HashMap<>();
        scholarMetrics.put("yearlyStats", kaplanScholar());
        Map<String, Object> scholar = new HashMap<>();
        scholar.put("metrics", scholarMetrics);
        Map<String, Object> staged = new HashMap<>();
        staged.put("OPENALEX", oa);
        staged.put("SCHOLAR", scholar);
        staged.put("publications", kaplanPubs());
        return staged;
    }

    @SuppressWarnings("unchecked")
    private static Map<String, Object> oaMetrics(Map<String, Object> staged) {
        return (Map<String, Object>) ((Map<String, Object>) staged.get("OPENALEX")).get("metrics");
    }

    @Test
    @SuppressWarnings("unchecked")
    void shadowMode_keepsSeries_writesRawAndReport_doesNotMutateInput() {
        Map<String, Object> staged = kaplanStaged();
        Map<String, Object> originalOa = (Map<String, Object>) staged.get("OPENALEX");
        var svc = new YearlyStatsSanitizerService(YearlyStatsSanitizerService.Mode.SHADOW, fixedClock());

        svc.apply(staged);

        Map<String, Object> m = oaMetrics(staged);
        assertThat((List<?>) m.get("yearlyStats")).hasSize(9);
        assertThat((List<?>) m.get("yearlyStatsRaw")).hasSize(9);
        Map<String, Object> report = (Map<String, Object>) m.get("yearlyStatsReport");
        assertThat(report.get("applied")).isEqualTo(false);
        assertThat((List<?>) report.get("removed")).hasSize(2);
        // Totals untouched, original block untouched (new maps were written).
        assertThat(m.get("citations")).isEqualTo(25);
        assertThat(((Map<String, Object>) originalOa.get("metrics"))).doesNotContainKey("yearlyStatsRaw");
    }

    @Test
    @SuppressWarnings("unchecked")
    void onMode_appliesAndIsIdempotent() {
        Map<String, Object> staged = kaplanStaged();
        var svc = new YearlyStatsSanitizerService(YearlyStatsSanitizerService.Mode.ON, fixedClock());

        svc.apply(staged);
        svc.apply(staged); // second pass restarts from yearlyStatsRaw

        Map<String, Object> m = oaMetrics(staged);
        assertThat((List<Map<String, Object>>) m.get("yearlyStats"))
                .extracting(r -> r.get("year")).doesNotContain(1934, 1968).hasSize(7);
        assertThat((List<?>) m.get("yearlyStatsRaw")).hasSize(9);
        assertThat(((Map<String, Object>) m.get("yearlyStatsReport")).get("applied")).isEqualTo(true);
    }

    @Test
    void offMode_restoresRawAndDropsHelperKeys() {
        Map<String, Object> staged = kaplanStaged();
        new YearlyStatsSanitizerService(YearlyStatsSanitizerService.Mode.ON, fixedClock()).apply(staged);
        new YearlyStatsSanitizerService(YearlyStatsSanitizerService.Mode.OFF, fixedClock()).apply(staged);

        Map<String, Object> m = oaMetrics(staged);
        assertThat((List<?>) m.get("yearlyStats")).hasSize(9);
        assertThat(m).doesNotContainKeys("yearlyStatsRaw", "yearlyStatsReport");
    }

    @Test
    void missingOpenAlexBlockIsANoOp() {
        Map<String, Object> staged = new HashMap<>();
        staged.put("WOS", Map.of("metrics", Map.of("hIndex", 1)));
        var svc = new YearlyStatsSanitizerService(YearlyStatsSanitizerService.Mode.ON, fixedClock());

        assertThat(svc.apply(staged)).isNull();
        assertThat(staged).doesNotContainKey("OPENALEX");
    }

    @Test
    void unknownModeFallsBackToShadow() {
        assertThat(YearlyStatsSanitizerService.parseMode("bogus")).isEqualTo(YearlyStatsSanitizerService.Mode.SHADOW);
        assertThat(YearlyStatsSanitizerService.parseMode(" On ")).isEqualTo(YearlyStatsSanitizerService.Mode.ON);
    }
}

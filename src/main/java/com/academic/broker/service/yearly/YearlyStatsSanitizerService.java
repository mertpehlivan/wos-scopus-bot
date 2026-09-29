package com.academic.broker.service.yearly;

import lombok.extern.slf4j.Slf4j;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Service;

import java.time.Clock;
import java.time.LocalDate;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;

/**
 * Applies {@link YearlyStatsSanitizer} to a sync request's {@code stagedData}
 * according to {@code broker.yearly-sanitize-mode} ({@code off | shadow | on}).
 *
 * <p>Contract with the tenant backend (rdlsis) is unchanged:
 * {@code OPENALEX.metrics.yearlyStats} keeps its name and shape. Two helper
 * keys are added next to it and are ignored by every tenant version
 * ({@code ApplySyncService} only reads known keys):
 * <ul>
 *   <li>{@code yearlyStatsRaw} — the untouched OpenAlex series (audit + rollback)</li>
 *   <li>{@code yearlyStatsReport} — window + removed/flagged rows, read by the operator panel</li>
 * </ul>
 *
 * <p>Idempotent: re-running always starts from {@code yearlyStatsRaw} when present,
 * so repeated rebuilds never compound removals. Always writes NEW maps for the
 * OPENALEX block and its metrics — never mutates maps it did not create, so a
 * caller may pass a shallow copy of an entity's JSON without dirtying it.
 */
@Slf4j
@Service
public class YearlyStatsSanitizerService {

    public enum Mode { OFF, SHADOW, ON }

    static final String RAW_KEY = "yearlyStatsRaw";
    static final String REPORT_KEY = "yearlyStatsReport";
    static final String SERIES_KEY = "yearlyStats";
    /** Per-work citing-year counts sent by extension ≥ 1.9.3. */
    static final String WORKS_KEY = "worksCitingYears";
    /** Original author-level series, preserved once the works path replaced it. */
    static final String AUTHOR_KEY = "yearlyStatsAuthorLevel";
    static final String BASIS_KEY = "yearlyStatsBasis";
    private static final String BASIS_WORKS_MARK = YearlyStatsSanitizer.BASIS_WORKS;

    private final Mode mode;
    private final Clock clock;

    // Two constructors (this + the test one) → Spring needs to be told which to use.
    @Autowired
    public YearlyStatsSanitizerService(@Value("${broker.yearly-sanitize-mode:shadow}") String mode) {
        this(parseMode(mode), Clock.systemUTC());
    }

    YearlyStatsSanitizerService(Mode mode, Clock clock) {
        this.mode = mode;
        this.clock = clock;
        log.info("[YearlyStats] sanitizer mode = {}", mode);
    }

    public Mode getMode() {
        return mode;
    }

    static Mode parseMode(String raw) {
        if (raw == null) return Mode.SHADOW;
        try {
            return Mode.valueOf(raw.trim().toUpperCase(Locale.ROOT));
        } catch (IllegalArgumentException e) {
            return Mode.SHADOW;
        }
    }

    /**
     * Sanitizes {@code staged.OPENALEX.metrics.yearlyStats} in place (replacing
     * the OPENALEX block with a new map). Safe to call on any staged shape;
     * returns the result (or null when there was nothing to do).
     */
    /** Sanitize without operator exclusions (ingest-time, no approval context). */
    public YearlyStatsSanitizer.Result apply(Map<String, Object> staged) {
        return apply(staged, Set.of());
    }

    /**
     * @param operatorExcludedWorks OpenAlex work ids the operator unticked in
     *        the publication list (see {@link #excludedWorkIds}); only used on
     *        the works-based path
     */
    @SuppressWarnings("unchecked")
    public YearlyStatsSanitizer.Result apply(Map<String, Object> staged, Set<String> operatorExcludedWorks) {
        if (staged == null) return null;
        if (!(staged.get("OPENALEX") instanceof Map<?, ?> oaBlock)) return null;
        if (!(oaBlock.get("metrics") instanceof Map<?, ?> metricsMap)) return null;

        Map<String, Object> oa = new HashMap<>((Map<String, Object>) oaBlock);
        Map<String, Object> metrics = new HashMap<>((Map<String, Object>) metricsMap);

        // The author-level series as OpenAlex sent it. Kept under AUTHOR_KEY
        // once the works path has replaced SERIES_KEY; under RAW_KEY on the
        // author path.
        Object authorObj = metrics.containsKey(AUTHOR_KEY) ? metrics.get(AUTHOR_KEY)
                : metrics.containsKey(RAW_KEY) && !BASIS_WORKS_MARK.equals(metrics.get(BASIS_KEY)) ? metrics.get(RAW_KEY)
                : metrics.get(SERIES_KEY);
        List<?> authorSeries = authorObj instanceof List<?> l ? l : List.of();
        Map<?, ?> works = metrics.get(WORKS_KEY) instanceof Map<?, ?> wm && !wm.isEmpty() ? wm : null;
        if (works == null && authorSeries.isEmpty()) return null;

        if (mode == Mode.OFF) {
            // Turning the feature off restores the original author-level series
            // on any not-yet-approved request that was sanitized earlier.
            if (metrics.containsKey(RAW_KEY) || metrics.containsKey(AUTHOR_KEY)) {
                metrics.put(SERIES_KEY, new ArrayList<>(authorSeries));
                metrics.remove(RAW_KEY);
                metrics.remove(REPORT_KEY);
                metrics.remove(AUTHOR_KEY);
                metrics.remove(BASIS_KEY);
                oa.put("metrics", metrics);
                staged.put("OPENALEX", oa);
            }
            return null;
        }

        int currentYear = LocalDate.now(clock).getYear();
        List<?> pubs = staged.get("publications") instanceof List<?> p ? p : null;
        YearlyStatsSanitizer.Result result = null;
        if (works != null) {
            result = YearlyStatsSanitizer.sanitizeFromWorks(works, pubs, seriesOf(staged, "SCHOLAR"),
                    wosSeries(staged), operatorExcludedWorks, currentYear);
            // Works carried no citations at all → nothing better than the author series.
            if (result.fullSeries() == null || result.fullSeries().isEmpty()) result = null;
        }

        boolean apply;
        if (result != null) {
            // Citing-year series from works: a semantic fix, so in ON mode it
            // replaces the author-level series even when no row was removed.
            apply = mode == Mode.ON;
            metrics.put(AUTHOR_KEY, new ArrayList<>(authorSeries));
            metrics.put(RAW_KEY, new ArrayList<>(result.fullSeries()));
            metrics.put(BASIS_KEY, BASIS_WORKS_MARK);
            metrics.put(SERIES_KEY, apply ? new ArrayList<>(result.kept()) : new ArrayList<>(authorSeries));
        } else {
            if (authorSeries.isEmpty()) return null;
            result = YearlyStatsSanitizer.sanitize(authorSeries, pubs, seriesOf(staged, "SCHOLAR"),
                    wosSeries(staged), currentYear);
            apply = mode == Mode.ON && result.changed();
            metrics.remove(AUTHOR_KEY);
            metrics.put(BASIS_KEY, YearlyStatsSanitizer.BASIS_AUTHOR);
            metrics.put(RAW_KEY, new ArrayList<>(authorSeries));
            metrics.put(SERIES_KEY, apply ? new ArrayList<>(result.kept()) : new ArrayList<>(authorSeries));
        }
        metrics.put(REPORT_KEY, report(result, apply));
        oa.put("metrics", metrics);
        staged.put("OPENALEX", oa);

        if (result.changed() || !result.flagged().isEmpty()) {
            log.info("[YearlyStats] mode={} applied={} window={} removed={} flagged={}",
                    mode, apply, result.window().start(),
                    result.removed().stream().map(YearlyStatsSanitizer.Decision::year).toList(),
                    result.flagged().stream().map(YearlyStatsSanitizer.Decision::year).toList());
        }
        return result;
    }

    private Map<String, Object> report(YearlyStatsSanitizer.Result r, boolean applied) {
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("version", 1);
        m.put("mode", mode.name());
        m.put("applied", applied);
        m.put("guardTriggered", r.guardTriggered());
        m.put("window", r.window().toMap());
        m.put("removed", r.removed().stream().map(YearlyStatsSanitizer.Decision::toMap).toList());
        m.put("flagged", r.flagged().stream().map(YearlyStatsSanitizer.Decision::toMap).toList());
        m.put("basis", r.basis());
        m.put("excludedWorks", r.excludedWorks().stream().map(YearlyStatsSanitizer.WorkExclusion::toMap).toList());
        if (r.citationsAll() != null) m.put("citationsAll", r.citationsAll());
        if (r.citationsIncluded() != null) m.put("citationsIncluded", r.citationsIncluded());
        return m;
    }

    /**
     * OpenAlex ids of publications the operator unticked in the panel
     * ({@code approvedFields["_pub:<key>"] == false}). The key mirrors the
     * panel's pubKey(): {@code doi:<doi>} else {@code title:<title>}, lower-case.
     */
    public static Set<String> excludedWorkIds(Map<String, Object> staged, Map<String, Object> approvedFields) {
        if (staged == null || approvedFields == null || approvedFields.isEmpty()) return Set.of();
        if (!(staged.get("publications") instanceof List<?> pubs)) return Set.of();
        java.util.HashSet<String> out = new java.util.HashSet<>();
        for (Object o : pubs) {
            if (!(o instanceof Map<?, ?> p) || p.get("openAlexId") == null) continue;
            String key = pubKey(p);
            if (key != null && Boolean.FALSE.equals(approvedFields.get("_pub:" + key))) {
                out.add(String.valueOf(p.get("openAlexId")));
            }
        }
        return out;
    }

    private static String pubKey(Map<?, ?> p) {
        Object doi = p.get("doi");
        if (doi != null && !String.valueOf(doi).isBlank()) return "doi:" + String.valueOf(doi).trim().toLowerCase(Locale.ROOT);
        Object title = p.get("title");
        if (title != null && !String.valueOf(title).isBlank()) return "title:" + String.valueOf(title).trim().toLowerCase(Locale.ROOT);
        return null;
    }

    @SuppressWarnings("unchecked")
    private static List<?> seriesOf(Map<String, Object> staged, String source) {
        if (!(staged.get(source) instanceof Map<?, ?> block)) return null;
        if (!(((Map<String, Object>) block).get("metrics") instanceof Map<?, ?> metrics)) return null;
        return ((Map<String, Object>) metrics).get(SERIES_KEY) instanceof List<?> l ? l : null;
    }

    /** WoS per-year citations: Citation Report blob first, then WOS.metrics.yearlyStats. */
    @SuppressWarnings("unchecked")
    private static List<?> wosSeries(Map<String, Object> staged) {
        if (staged.get("WOS") instanceof Map<?, ?> wos
                && ((Map<String, Object>) wos).get("citationReport") instanceof Map<?, ?> cr
                && ((Map<String, Object>) cr).get("data") instanceof Map<?, ?> data
                && ((Map<String, Object>) data).get(SERIES_KEY) instanceof List<?> l
                && !l.isEmpty()) {
            return l;
        }
        return seriesOf(staged, "WOS");
    }
}

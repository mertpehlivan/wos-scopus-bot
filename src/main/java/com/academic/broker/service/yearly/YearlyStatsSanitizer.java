package com.academic.broker.service.yearly;

import java.util.ArrayList;
import java.util.Collection;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;

/**
 * Pure (no Spring, no I/O, no clock) sanitizer for the OpenAlex per-year
 * histogram carried at {@code stagedData.OPENALEX.metrics.yearlyStats}.
 *
 * <p>Why: OpenAlex regularly attaches works of a namesake author to a profile
 * (e.g. a 1934 paper on a researcher whose career starts in 2013). The worker
 * forwards OpenAlex's author-level {@code counts_by_year} verbatim, so the
 * tenant renders "3 citations in 1934". The tenant (rdlsis) is intentionally
 * left untouched — the broker cleans the series before approval instead.
 *
 * <p>The career window is derived from evidence the broker already has:
 * <ul>
 *   <li><b>C</b> — earliest year of a staged publication that another source
 *       besides OpenAlex (and PlumX, which attaches by DOI to anything)
 *       corroborated: WoS / Scopus / Scholar / TR Dizin / PubMed…</li>
 *   <li><b>S</b> — first year with citations in the Google Scholar histogram.
 *       The researcher curates their own Scholar profile, so its start is the
 *       strongest signal of when their citation record really begins.</li>
 *   <li><b>W</b> — first year with citations in the WoS histogram (fallback).</li>
 * </ul>
 * {@code L = min(C, S)} (or whichever exists; W only if neither). Rows with
 * {@code year < L - TOLERANCE}, {@code year > currentYear} or an invalid year
 * are removed. Without any evidence nothing is removed — rows far detached
 * from the rest are only <i>flagged</i>. If every row would be removed the
 * series is left untouched (the window is evidently wrong).
 */
public final class YearlyStatsSanitizer {

    public static final int TOLERANCE_YEARS = 2;
    public static final int ISOLATION_GAP_YEARS = 10;
    public static final int MIN_VALID_YEAR = 1900;

    /** Sources that corroborate a publication. OPENALEX and PLUMX deliberately excluded. */
    private static final Set<String> CORROBORATING_SOURCES =
            Set.of("WOS", "SCOPUS", "SCHOLAR", "TRDIZIN", "PUBMED", "CROSSREF", "ARXIV", "MANUAL");

    private YearlyStatsSanitizer() {}

    /** Rule that caused a row to be removed or flagged. */
    public enum Rule { BEFORE_CAREER, FUTURE, INVALID_YEAR, ISOLATED }

    public record Window(Integer start, int end, String basis,
                         Integer corroboratedStart, Integer scholarStart, Integer wosStart) {
        public Map<String, Object> toMap() {
            Map<String, Object> m = new LinkedHashMap<>();
            m.put("start", start);
            m.put("end", end);
            m.put("basis", basis);
            m.put("corroboratedStart", corroboratedStart);
            m.put("scholarStart", scholarStart);
            m.put("wosStart", wosStart);
            m.put("toleranceYears", TOLERANCE_YEARS);
            return m;
        }
    }

    public record Decision(int year, int citations, int publications, Rule rule, String detail) {
        public Map<String, Object> toMap() {
            Map<String, Object> m = new LinkedHashMap<>();
            m.put("year", year);
            m.put("citations", citations);
            m.put("publications", publications);
            m.put("rule", rule.name());
            m.put("detail", detail);
            return m;
        }
    }

    /**
     * @param kept    rows to keep, original maps in input order
     * @param removed rows the rules removed
     * @param flagged rows kept but worth an operator's look
     * @param guardTriggered true when the "never remove everything" guard fired
     *                       (then {@code kept} is the full input and {@code removed} is empty)
     */
    /** How the series was built. */
    public static final String BASIS_AUTHOR = "AUTHOR_COUNTS_SANITIZED";
    public static final String BASIS_WORKS = "WORKS_CITING_YEAR";

    /** A work left out of a works-based series. */
    public record WorkExclusion(String id, Integer year, String title, int citations, String reason) {
        public Map<String, Object> toMap() {
            Map<String, Object> m = new LinkedHashMap<>();
            m.put("id", id);
            m.put("year", year);
            m.put("title", title);
            m.put("citations", citations);
            m.put("reason", reason);
            return m;
        }
    }

    /**
     * @param fullSeries works mode only: the series built from ALL works (no
     *                   exclusions, no row rules) — what the operator may
     *                   restore rows from; null in author mode
     */
    public record Result(List<Map<String, Object>> kept,
                         List<Decision> removed,
                         List<Decision> flagged,
                         Window window,
                         boolean guardTriggered,
                         String basis,
                         List<WorkExclusion> excludedWorks,
                         Integer citationsAll,
                         Integer citationsIncluded,
                         List<Map<String, Object>> fullSeries) {
        public boolean changed() { return !removed.isEmpty(); }
    }

    /**
     * Author-level series (OpenAlex {@code counts_by_year}, which for some
     * authors is grouped by PUBLICATION year) cleaned by the row rules.
     *
     * @param rawSeries    OpenAlex rows {@code [{year, citations, publications?}]}; may be null
     * @param publications staged unified publications ({@code year}, {@code sources}); may be null
     * @param scholarSeries Scholar rows {@code [{year, citations}]}; may be null
     * @param wosSeries    WoS rows (citationReport or metrics); keys {@code citations} or {@code totalCitations}
     * @param currentYear  "today" — passed in so the class stays deterministic in tests
     */
    public static Result sanitize(List<?> rawSeries,
                                  Collection<?> publications,
                                  List<?> scholarSeries,
                                  List<?> wosSeries,
                                  int currentYear) {
        List<Map<String, Object>> rows = asRowMaps(rawSeries);
        Window window = computeWindow(publications, scholarSeries, wosSeries, currentYear);
        RowPass pass = applyRowRules(rows, window, currentYear);
        if (pass.kept().isEmpty() && !rows.isEmpty()) {
            return new Result(rows, List.of(), List.of(), window, true, BASIS_AUTHOR, List.of(), null, null, null);
        }
        List<Decision> flagged = window.start() == null ? isolatedRows(pass.kept()) : List.of();
        return new Result(pass.kept(), pass.removed(), flagged, window, false, BASIS_AUTHOR, List.of(), null, null, null);
    }

    /**
     * Series built from per-work citations by CITING year (same meaning as
     * Scholar / WoS). Works are left out when the operator excluded them or
     * when they look misattributed: not corroborated by any source besides
     * OpenAlex/PlumX AND published before the career window. Row rules then
     * run on the remaining series.
     *
     * @param works            {@code {openAlexId: {year, counts: [[year, citations], …]}}}
     * @param operatorExcluded OpenAlex ids the operator took out of the approval
     */
    public static Result sanitizeFromWorks(Map<?, ?> works,
                                           Collection<?> publications,
                                           List<?> scholarSeries,
                                           List<?> wosSeries,
                                           Set<String> operatorExcluded,
                                           int currentYear) {
        Window window = computeWindow(publications, scholarSeries, wosSeries, currentYear);
        Integer start = window.start();
        Map<String, Map<?, ?>> pubById = indexByOpenAlexId(publications);

        java.util.TreeMap<Integer, int[]> all = new java.util.TreeMap<>();
        java.util.TreeMap<Integer, int[]> included = new java.util.TreeMap<>();
        List<WorkExclusion> excluded = new ArrayList<>();
        int citAll = 0, citIncluded = 0;

        for (Map.Entry<?, ?> e : works.entrySet()) {
            if (!(e.getValue() instanceof Map<?, ?> w)) continue;
            String id = String.valueOf(e.getKey());
            Integer pubYear = toInt(w.get("year"));
            List<int[]> counts = countsOf(w.get("counts"));
            Map<?, ?> pub = pubById.get(id);
            // Lifetime total from the work itself: OpenAlex's per-work
            // counts_by_year only covers recent years (a 1934 paper's 3
            // citations are not in it), so summing it would undercount.
            Integer lifetime = openAlexCitations(pub);
            int total = 0;
            for (int[] c : counts) total += c[1];
            if (lifetime != null && lifetime > total) total = lifetime;
            citAll += total;
            accumulate(all, pubYear, counts, currentYear);

            String reason = null;
            if (operatorExcluded != null && operatorExcluded.contains(id)) {
                reason = "OPERATOR";
            } else if (start != null && pubYear != null && pubYear < start - TOLERANCE_YEARS
                    && !isCorroborated(pub == null ? null : pub.get("sources"))) {
                reason = "SUSPICIOUS_WORK";
            }
            if (reason != null) {
                Object t = pub == null ? null : pub.get("title");
                excluded.add(new WorkExclusion(id, pubYear, t == null ? null : String.valueOf(t), total, reason));
                continue;
            }
            citIncluded += total;
            accumulate(included, pubYear, counts, currentYear);
        }

        List<Map<String, Object>> fullSeries = toRows(all);
        List<Map<String, Object>> rows = toRows(included);
        RowPass pass = applyRowRules(rows, window, currentYear);
        boolean guard = pass.kept().isEmpty() && !rows.isEmpty();
        return new Result(guard ? rows : pass.kept(), guard ? List.of() : pass.removed(), List.of(), window,
                guard, BASIS_WORKS, excluded, citAll, citIncluded, fullSeries);
    }

    // ── shared building blocks ──────────────────────────────────────────

    private record RowPass(List<Map<String, Object>> kept, List<Decision> removed) {}

    static Window computeWindow(Collection<?> publications, List<?> scholarSeries, List<?> wosSeries, int currentYear) {
        Integer c = corroboratedStart(publications, currentYear);
        Integer s = firstCitedYear(scholarSeries, currentYear);
        Integer w = firstCitedYear(wosSeries, currentYear);
        Integer start;
        String basis;
        if (c != null && s != null) {
            start = Math.min(c, s);
            basis = c <= s ? "CORROBORATED_PUBLICATIONS" : "SCHOLAR_START";
        } else if (c != null) {
            start = c; basis = "CORROBORATED_PUBLICATIONS";
        } else if (s != null) {
            start = s; basis = "SCHOLAR_START";
        } else if (w != null) {
            start = w; basis = "WOS_START";
        } else {
            start = null; basis = "NONE";
        }
        return new Window(start, currentYear, basis, c, s, w);
    }

    private static RowPass applyRowRules(List<Map<String, Object>> rows, Window window, int currentYear) {
        Integer start = window.start();
        List<Map<String, Object>> kept = new ArrayList<>();
        List<Decision> removed = new ArrayList<>();
        for (Map<String, Object> row : rows) {
            Integer year = toInt(row.get("year"));
            int cit = orZero(toInt(row.get("citations")));
            int pubs = orZero(toInt(row.get("publications")));
            if (year == null || year < MIN_VALID_YEAR) {
                removed.add(new Decision(year == null ? 0 : year, cit, pubs, Rule.INVALID_YEAR,
                        "Geçersiz yıl"));
            } else if (year > currentYear) {
                removed.add(new Decision(year, cit, pubs, Rule.FUTURE,
                        "Gelecek yıl (" + year + " > " + currentYear + ")"));
            } else if (start != null && year < start - TOLERANCE_YEARS) {
                removed.add(new Decision(year, cit, pubs, Rule.BEFORE_CAREER,
                        "Kariyer başlangıcından (" + start + ", " + basisLabel(window.basis()) + ") çok önce"));
            } else {
                kept.add(row);
            }
        }
        return new RowPass(kept, removed);
    }

    private static Map<String, Map<?, ?>> indexByOpenAlexId(Collection<?> publications) {
        Map<String, Map<?, ?>> out = new java.util.HashMap<>();
        if (publications == null) return out;
        for (Object o : publications) {
            if (o instanceof Map<?, ?> p && p.get("openAlexId") != null) {
                out.put(String.valueOf(p.get("openAlexId")), p);
            }
        }
        return out;
    }

    private static Integer openAlexCitations(Map<?, ?> pub) {
        if (pub == null || !(pub.get("citations") instanceof Map<?, ?> c)) return null;
        return toInt(c.get("openalex"));
    }

    private static List<int[]> countsOf(Object raw) {
        List<int[]> out = new ArrayList<>();
        if (!(raw instanceof List<?> list)) return out;
        for (Object o : list) {
            if (o instanceof List<?> pair && pair.size() >= 2) {
                Integer y = toInt(pair.get(0));
                Integer n = toInt(pair.get(1));
                if (y != null && n != null && n > 0) out.add(new int[]{y, n});
            }
        }
        return out;
    }

    /** citations by citing year; publications counted in the work's publication year. */
    private static void accumulate(java.util.TreeMap<Integer, int[]> acc, Integer pubYear, List<int[]> counts, int currentYear) {
        for (int[] c : counts) acc.computeIfAbsent(c[0], k -> new int[2])[0] += c[1];
        if (pubYear != null && pubYear >= MIN_VALID_YEAR && pubYear <= currentYear) {
            acc.computeIfAbsent(pubYear, k -> new int[2])[1] += 1;
        }
    }

    private static List<Map<String, Object>> toRows(java.util.TreeMap<Integer, int[]> acc) {
        List<Map<String, Object>> rows = new ArrayList<>();
        for (Map.Entry<Integer, int[]> e : acc.entrySet()) {
            Map<String, Object> m = new LinkedHashMap<>();
            m.put("year", e.getKey());
            m.put("citations", e.getValue()[0]);
            m.put("publications", e.getValue()[1]);
            rows.add(m);
        }
        return rows;
    }

    // ── helpers ─────────────────────────────────────────────────────────

    private static String basisLabel(String basis) {
        return switch (basis) {
            case "CORROBORATED_PUBLICATIONS" -> "doğrulanmış ilk yayın";
            case "SCHOLAR_START" -> "Google Scholar başlangıcı";
            case "WOS_START" -> "WoS başlangıcı";
            default -> basis;
        };
    }

    /**
     * Rows separated from the main (largest) cluster by at least
     * {@link #ISOLATION_GAP_YEARS} and lying before it. Flag only — used when
     * there is no evidence-based window to remove against.
     */
    private static List<Decision> isolatedRows(List<Map<String, Object>> rows) {
        List<int[]> ys = new ArrayList<>(); // {year, citations, publications}
        for (Map<String, Object> r : rows) {
            Integer y = toInt(r.get("year"));
            if (y != null) ys.add(new int[]{y, orZero(toInt(r.get("citations"))), orZero(toInt(r.get("publications")))});
        }
        if (ys.size() < 2) return List.of();
        ys.sort((a, b) -> Integer.compare(a[0], b[0]));

        // Split into clusters on large gaps, pick the heaviest (latest on tie).
        List<List<int[]>> clusters = new ArrayList<>();
        List<int[]> cur = new ArrayList<>();
        for (int[] y : ys) {
            if (!cur.isEmpty() && y[0] - cur.get(cur.size() - 1)[0] >= ISOLATION_GAP_YEARS) {
                clusters.add(cur);
                cur = new ArrayList<>();
            }
            cur.add(y);
        }
        clusters.add(cur);
        if (clusters.size() < 2) return List.of();

        int mainIdx = 0;
        long best = -1;
        for (int i = 0; i < clusters.size(); i++) {
            long weight = 0;
            for (int[] y : clusters.get(i)) weight += 1 + y[1] + y[2];
            if (weight >= best) { best = weight; mainIdx = i; }
        }
        int mainStart = clusters.get(mainIdx).get(0)[0];
        List<Decision> out = new ArrayList<>();
        for (int i = 0; i < mainIdx; i++) {
            for (int[] y : clusters.get(i)) {
                out.add(new Decision(y[0], y[1], y[2], Rule.ISOLATED,
                        "Diğer yıllardan kopuk (ana dönem " + mainStart + "+), başka yazara ait olabilir"));
            }
        }
        return out;
    }

    static Integer corroboratedStart(Collection<?> publications, int currentYear) {
        if (publications == null) return null;
        Integer min = null;
        for (Object o : publications) {
            if (!(o instanceof Map<?, ?> p)) continue;
            Integer year = toInt(p.get("year"));
            if (year == null || year < MIN_VALID_YEAR || year > currentYear) continue;
            if (!isCorroborated(p.get("sources"))) continue;
            if (min == null || year < min) min = year;
        }
        return min;
    }

    private static boolean isCorroborated(Object sources) {
        if (!(sources instanceof Collection<?> list)) return false;
        for (Object s : list) {
            if (s != null && CORROBORATING_SOURCES.contains(String.valueOf(s).trim().toUpperCase(Locale.ROOT))) {
                return true;
            }
        }
        return false;
    }

    static Integer firstCitedYear(List<?> series, int currentYear) {
        if (series == null) return null;
        Integer min = null;
        for (Object o : series) {
            if (!(o instanceof Map<?, ?> r)) continue;
            Integer year = toInt(r.get("year"));
            if (year == null || year < MIN_VALID_YEAR || year > currentYear) continue;
            Integer cit = toInt(r.get("citations"));
            if (cit == null) cit = toInt(r.get("totalCitations"));
            if (cit == null || cit <= 0) continue;
            if (min == null || year < min) min = year;
        }
        return min;
    }

    @SuppressWarnings("unchecked")
    private static List<Map<String, Object>> asRowMaps(List<?> series) {
        List<Map<String, Object>> out = new ArrayList<>();
        if (series == null) return out;
        for (Object o : series) {
            if (o instanceof Map<?, ?> m) out.add((Map<String, Object>) m);
        }
        return out;
    }

    static Integer toInt(Object v) {
        if (v == null) return null;
        if (v instanceof Number n) return n.intValue();
        if (v instanceof String s) {
            String t = s.trim();
            if (t.isEmpty()) return null;
            try {
                return (int) Double.parseDouble(t);
            } catch (NumberFormatException ignored) {
                return null;
            }
        }
        return null;
    }

    private static int orZero(Integer v) {
        return v == null ? 0 : v;
    }
}

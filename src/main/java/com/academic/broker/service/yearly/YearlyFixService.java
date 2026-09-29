package com.academic.broker.service.yearly;

import com.academic.broker.domain.SyncRequest;
import com.academic.broker.domain.SyncRequestStatus;
import com.academic.broker.repository.SyncAuditLogRepository;
import com.academic.broker.repository.SyncRequestRepository;
import com.academic.broker.service.BackendApplyService;
import com.academic.broker.service.SyncRequestService;
import lombok.extern.slf4j.Slf4j;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.data.domain.PageRequest;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.net.http.HttpResponse;
import java.time.Instant;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.Set;
import java.util.UUID;

/**
 * R5 — corrects the OpenAlex yearly citation series of profiles that were
 * approved BEFORE the sanitizer was switched on, without touching the tenant
 * (rdlsis) code: the fix is a minimal apply-sync patch that carries only
 * {@code stagedData.OPENALEX.metrics.yearlyStats} with
 * {@code approvedFields = {"rdldb.yearlyStats": true}}.
 *
 * <p>Verified against the tenant's ApplySyncService/InternalApplySyncController:
 * with only that key present, every other block is skipped (null metrics are
 * not written, absent publications/identifiers/PlumX/citation report are
 * no-ops, no publication is deleted). Side effects: rdlLastUpdated is bumped,
 * the idempotent published-publication refresh runs, the async TR Dizin /
 * PubMed enrichers are triggered, and open UI sessions get a SYNC_APPLIED
 * WebSocket ping (no e-mail).
 *
 * <p>A request is a candidate when it is the researcher's latest APPLIED
 * request carrying an OpenAlex series, was approved before
 * {@code broker.yearly-fix.applied-before}, has no operator override of the
 * series, was not fixed before (audit YEARLY_FIX), and the sanitizer would
 * change its series today.
 */
@Slf4j
@Service
public class YearlyFixService {

    static final String AUDIT_ACTION = "YEARLY_FIX";

    private final SyncRequestRepository repository;
    private final SyncAuditLogRepository auditRepository;
    private final SyncRequestService syncService;
    private final BackendApplyService applyService;
    private final YearlyStatsSanitizerService sanitizer;
    private final Instant appliedBefore;

    public YearlyFixService(SyncRequestRepository repository,
                            SyncAuditLogRepository auditRepository,
                            SyncRequestService syncService,
                            BackendApplyService applyService,
                            YearlyStatsSanitizerService sanitizer,
                            @Value("${broker.yearly-fix.applied-before:2026-09-28T23:02:00Z}") String appliedBefore) {
        this.repository = repository;
        this.auditRepository = auditRepository;
        this.syncService = syncService;
        this.applyService = applyService;
        this.sanitizer = sanitizer;
        this.appliedBefore = Instant.parse(appliedBefore);
    }

    @Transactional(readOnly = true)
    public List<Map<String, Object>> candidates() {
        List<Map<String, Object>> out = new ArrayList<>();
        for (Candidate c : findCandidates()) out.add(view(c));
        return out;
    }

    /** Sends the correction for one request. Re-validates it is still a candidate. */
    public Map<String, Object> apply(UUID syncRequestId, UUID operatorId) {
        Optional<Candidate> c = findCandidates().stream()
                .filter(x -> x.request().getId().equals(syncRequestId)).findFirst();
        if (c.isEmpty()) {
            return Map.of("ok", false, "id", syncRequestId.toString(),
                    "error", "Bu talep düzeltme adayı değil (zaten düzeltilmiş, daha yeni bir talep var ya da değişiklik gerekmiyor)");
        }
        return send(c.get(), operatorId);
    }

    /** Sends every current correction; one failure doesn't stop the rest. */
    public Map<String, Object> applyAll(UUID operatorId) {
        List<Map<String, Object>> results = new ArrayList<>();
        int ok = 0;
        for (Candidate c : findCandidates()) {
            Map<String, Object> r = send(c, operatorId);
            if (Boolean.TRUE.equals(r.get("ok"))) ok++;
            results.add(r);
        }
        return Map.of("ok", true, "applied", ok, "total", results.size(), "results", results);
    }

    // ────────────────────────────────────────────────────────────────────

    record Candidate(SyncRequest request, Map<String, Object> preview) {}

    List<Candidate> findCandidates() {
        List<SyncRequest> approved = repository.findByStatusOrderByRequestedAtDesc(
                SyncRequestStatus.APPROVED, PageRequest.of(0, 5000)).getContent();
        Set<String> seenResearchers = new HashSet<>();
        List<Candidate> out = new ArrayList<>();
        for (SyncRequest r : approved) {
            if (!r.isAppliedToBackend() || !hasOpenAlexSeries(r.getStagedData())) continue;
            String key = (r.getBackendBaseUrl() == null ? "" : r.getBackendBaseUrl()) + "|" + r.getRequesterUserId();
            // Only the researcher's latest applied series matters — a newer
            // apply already overwrote whatever an older one wrote.
            if (!seenResearchers.add(key)) continue;
            Instant when = r.getReviewedAt() != null ? r.getReviewedAt() : r.getRequestedAt();
            if (when != null && !when.isBefore(appliedBefore)) continue; // applied with the sanitizer on
            if (hasOperatorYearlyOverride(r.getEditedData())) continue;  // operator decided
            if (auditRepository.existsBySyncRequestIdAndAction(r.getId(), AUDIT_ACTION)) continue;
            sanitizer.previewFix(r.getStagedData(), r.getApprovedFields())
                    .ifPresent(p -> out.add(new Candidate(r, p)));
        }
        return out;
    }

    @SuppressWarnings("unchecked")
    private Map<String, Object> send(Candidate c, UUID operatorId) {
        SyncRequest r = c.request();
        List<?> fixed = (List<?>) c.preview().get("fixed");
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("syncRequestId", r.getId().toString());
        body.put("requesterUserId", r.getRequesterUserId().toString());
        body.put("origin", r.getOrigin() == null ? null : r.getOrigin().name());
        body.put("stagedData", Map.of("OPENALEX", Map.of("metrics", Map.of("yearlyStats", fixed))));
        body.put("editedData", Map.of());
        body.put("approvedFields", Map.of("rdldb.yearlyStats", true));
        body.put("reviewerNotes", "Yıllık atıf serisi düzeltmesi (broker R5)");
        try {
            HttpResponse<String> resp = applyService.postToTenant(r, body);
            int code = resp.statusCode();
            if (code >= 200 && code < 300) {
                Map<String, Object> details = new LinkedHashMap<>();
                details.put("removedYears", removedYears(c.preview()));
                details.put("excludedWorks", excludedWorkIds(c.preview()));
                details.put("fixedRows", fixed.size());
                syncService.audit(r.getId(), operatorId, "OPERATOR", AUDIT_ACTION, details);
                log.info("[YearlyFix] {} corrected on {} (removed years {})",
                        r.getId(), r.getBackendBaseUrl(), details.get("removedYears"));
                return Map.of("ok", true, "id", r.getId().toString());
            }
            String body0 = resp.body() == null ? "" : resp.body();
            log.warn("[YearlyFix] {} tenant answered HTTP {}: {}", r.getId(), code,
                    body0.length() > 200 ? body0.substring(0, 200) : body0);
            return Map.of("ok", false, "id", r.getId().toString(), "error", "Kurum sistemi HTTP " + code + " döndü");
        } catch (Exception e) {
            log.warn("[YearlyFix] {} send failed: {}", r.getId(), e.getMessage());
            return Map.of("ok", false, "id", r.getId().toString(), "error", "Gönderilemedi: " + e.getMessage());
        }
    }

    @SuppressWarnings("unchecked")
    private Map<String, Object> view(Candidate c) {
        SyncRequest r = c.request();
        Map<String, Object> snap = r.getRequesterProfileSnapshot() == null ? Map.of() : r.getRequesterProfileSnapshot();
        String name = (str(snap.get("firstName")) + " " + str(snap.get("lastName"))).trim();
        Map<String, Object> report = c.preview().get("report") instanceof Map<?, ?> m ? (Map<String, Object>) m : Map.of();
        Map<String, Object> v = new LinkedHashMap<>();
        v.put("id", r.getId().toString());
        v.put("backendBaseUrl", r.getBackendBaseUrl());
        v.put("researcher", name.isBlank() ? str(snap.get("email")) : name);
        v.put("email", str(snap.get("email")));
        v.put("approvedAt", r.getReviewedAt() == null ? null : r.getReviewedAt().toString());
        v.put("removedYears", removedYears(c.preview()));
        v.put("basis", report.get("basis"));
        v.put("excludedWorks", report.get("excludedWorks"));
        v.put("original", c.preview().get("original"));
        v.put("fixed", c.preview().get("fixed"));
        return v;
    }

    @SuppressWarnings("unchecked")
    private static List<Object> removedYears(Map<String, Object> preview) {
        List<Object> years = new ArrayList<>();
        if (preview.get("report") instanceof Map<?, ?> rep && rep.get("removed") instanceof List<?> rm) {
            for (Object o : rm) if (o instanceof Map<?, ?> d) years.add(d.get("year"));
        }
        return years;
    }

    private static List<Object> excludedWorkIds(Map<String, Object> preview) {
        List<Object> ids = new ArrayList<>();
        if (preview.get("report") instanceof Map<?, ?> rep && rep.get("excludedWorks") instanceof List<?> ex) {
            for (Object o : ex) if (o instanceof Map<?, ?> w) ids.add(w.get("id"));
        }
        return ids;
    }

    @SuppressWarnings("unchecked")
    private static boolean hasOpenAlexSeries(Map<String, Object> staged) {
        return staged != null && staged.get("OPENALEX") instanceof Map<?, ?> oa
                && ((Map<String, Object>) oa).get("metrics") instanceof Map<?, ?> m
                && ((Map<String, Object>) m).get("yearlyStats") instanceof List<?> l && !l.isEmpty();
    }

    @SuppressWarnings("unchecked")
    private static boolean hasOperatorYearlyOverride(Map<String, Object> edited) {
        return edited != null && edited.get("OPENALEX") instanceof Map<?, ?> oa
                && ((Map<String, Object>) oa).get("metrics") instanceof Map<?, ?> m
                && ((Map<String, Object>) m).get("yearlyStats") instanceof List<?>;
    }

    private static String str(Object o) {
        return o == null ? "" : String.valueOf(o);
    }
}

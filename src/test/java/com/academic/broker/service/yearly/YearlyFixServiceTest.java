package com.academic.broker.service.yearly;

import com.academic.broker.domain.SyncRequest;
import com.academic.broker.domain.SyncRequestOrigin;
import com.academic.broker.domain.SyncRequestStatus;
import com.academic.broker.repository.SyncAuditLogRepository;
import com.academic.broker.repository.SyncRequestRepository;
import com.academic.broker.service.BackendApplyService;
import com.academic.broker.service.SyncRequestService;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.mockito.ArgumentCaptor;
import org.springframework.data.domain.PageImpl;

import java.net.http.HttpResponse;
import java.time.Instant;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

class YearlyFixServiceTest {

    private static final Instant BEFORE = Instant.parse("2026-09-20T10:00:00Z");
    private static final Instant AFTER = Instant.parse("2026-09-29T10:00:00Z");

    private SyncRequestRepository repo;
    private SyncAuditLogRepository audit;
    private SyncRequestService syncService;
    private BackendApplyService apply;
    private YearlyFixService service;

    @BeforeEach
    void setUp() {
        repo = mock(SyncRequestRepository.class);
        audit = mock(SyncAuditLogRepository.class);
        syncService = mock(SyncRequestService.class);
        apply = mock(BackendApplyService.class);
        service = new YearlyFixService(repo, audit, syncService, apply,
                new YearlyStatsSanitizerService("on"), "2026-09-28T23:02:00Z");
    }

    /** Kaplan-like staged data: namesake 1934 row, corroborated career from 2013. */
    private static Map<String, Object> kaplanStaged() {
        Map<String, Object> metrics = new HashMap<>();
        metrics.put("yearlyStats", List.of(Map.of("year", 1934, "citations", 3, "publications", 1),
                Map.of("year", 2020, "citations", 14, "publications", 1)));
        Map<String, Object> staged = new HashMap<>();
        staged.put("OPENALEX", Map.of("metrics", metrics));
        staged.put("publications", List.of(Map.of("year", 2013, "sources", List.of("OPENALEX", "WOS"))));
        return staged;
    }

    private static SyncRequest req(UUID user, Instant reviewedAt, Map<String, Object> staged) {
        SyncRequest r = new SyncRequest();
        r.setId(UUID.randomUUID());
        r.setRequesterUserId(user);
        r.setStatus(SyncRequestStatus.APPROVED);
        r.setAppliedToBackend(true);
        r.setReviewedAt(reviewedAt);
        r.setRequestedAt(reviewedAt);
        r.setBackendBaseUrl("https://rdlsis.example.edu.tr");
        r.setOrigin(SyncRequestOrigin.values()[0]);
        r.setStagedData(staged);
        r.setRequesterProfileSnapshot(Map.of("firstName", "Erdar", "lastName", "Kaplan"));
        return r;
    }

    private void approved(SyncRequest... rs) {
        when(repo.findByStatusOrderByRequestedAtDesc(eq(SyncRequestStatus.APPROVED), any()))
                .thenReturn(new PageImpl<>(List.of(rs)));
    }

    @Test
    void preCutoverApply_isACandidate_withCleanedSeries() {
        approved(req(UUID.randomUUID(), BEFORE, kaplanStaged()));

        List<Map<String, Object>> c = service.candidates();

        assertThat(c).hasSize(1);
        assertThat(c.get(0).get("researcher")).isEqualTo("Erdar Kaplan");
        assertThat(c.get(0).get("removedYears")).isEqualTo(List.of(1934));
        assertThat((List<?>) c.get(0).get("fixed")).hasSize(1);
    }

    @Test
    void newerApplyAfterCutover_hidesOlderOne() {
        UUID user = UUID.randomUUID();
        approved(req(user, AFTER, kaplanStaged()), req(user, BEFORE, kaplanStaged()));  // newest first
        assertThat(service.candidates()).isEmpty();
    }

    @Test
    void operatorOverride_orAlreadyFixed_isSkipped() {
        SyncRequest edited = req(UUID.randomUUID(), BEFORE, kaplanStaged());
        edited.setEditedData(Map.of("OPENALEX", Map.of("metrics", Map.of("yearlyStats", List.of()))));
        SyncRequest fixed = req(UUID.randomUUID(), BEFORE, kaplanStaged());
        when(audit.existsBySyncRequestIdAndAction(fixed.getId(), "YEARLY_FIX")).thenReturn(true);
        approved(edited, fixed);

        assertThat(service.candidates()).isEmpty();
    }

    @Test
    void nothingToFix_isSkipped() {
        Map<String, Object> clean = kaplanStaged();
        clean.put("OPENALEX", Map.of("metrics", Map.of("yearlyStats",
                List.of(Map.of("year", 2020, "citations", 14, "publications", 1)))));
        approved(req(UUID.randomUUID(), BEFORE, clean));
        assertThat(service.candidates()).isEmpty();
    }

    @Test
    @SuppressWarnings("unchecked")
    void apply_sendsOnlyTheYearlySeries_andAudits() throws Exception {
        SyncRequest r = req(UUID.randomUUID(), BEFORE, kaplanStaged());
        approved(r);
        HttpResponse<String> ok = mock(HttpResponse.class);
        when(ok.statusCode()).thenReturn(200);
        when(apply.postToTenant(eq(r), any())).thenReturn(ok);

        Map<String, Object> result = service.apply(r.getId(), UUID.randomUUID());

        assertThat(result).containsEntry("ok", true);
        ArgumentCaptor<Map<String, Object>> body = ArgumentCaptor.forClass(Map.class);
        verify(apply).postToTenant(eq(r), body.capture());
        Map<String, Object> staged = (Map<String, Object>) body.getValue().get("stagedData");
        assertThat(staged).containsOnlyKeys("OPENALEX");
        Map<String, Object> metrics = (Map<String, Object>) ((Map<String, Object>) staged.get("OPENALEX")).get("metrics");
        assertThat(metrics).containsOnlyKeys("yearlyStats");
        assertThat((List<Map<String, Object>>) metrics.get("yearlyStats")).extracting(m -> m.get("year")).containsExactly(2020);
        assertThat(body.getValue().get("approvedFields")).isEqualTo(Map.of("rdldb.yearlyStats", true));
        assertThat(body.getValue().get("editedData")).isEqualTo(Map.of());
        verify(syncService).audit(eq(r.getId()), any(), eq("OPERATOR"), eq("YEARLY_FIX"), any());
    }

    @Test
    @SuppressWarnings("unchecked")
    void apply_tenantError_isReported_notAudited() throws Exception {
        SyncRequest r = req(UUID.randomUUID(), BEFORE, kaplanStaged());
        approved(r);
        HttpResponse<String> err = mock(HttpResponse.class);
        when(err.statusCode()).thenReturn(500);
        when(err.body()).thenReturn("boom");
        when(apply.postToTenant(eq(r), any())).thenReturn(err);

        assertThat(service.apply(r.getId(), UUID.randomUUID())).containsEntry("ok", false);
        verify(syncService, never()).audit(any(), any(), anyString(), anyString(), any());
    }
}

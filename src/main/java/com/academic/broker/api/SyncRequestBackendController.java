package com.academic.broker.api;

import com.academic.broker.api.dto.SyncRequestDtos;
import com.academic.broker.domain.SyncRequest;
import com.academic.broker.service.SyncRequestService;
import lombok.RequiredArgsConstructor;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;

import java.util.UUID;

/**
 * Endpoints called by the main backend (rdl-sis) — protected by the
 * existing X-Api-Key header. Researcher-flow only:
 * <ul>
 *   <li>create a new sync request</li>
 *   <li>look up the active request for a researcher (countdown UI feeder)</li>
 *   <li>cancel a pending request (researcher self-service)</li>
 * </ul>
 *
 * <p>Operator-only endpoints live in {@link SyncRequestOperatorController}.
 */
@RestController
@RequestMapping("/api/sync-requests")
@RequiredArgsConstructor
public class SyncRequestBackendController {

    private final SyncRequestService service;

    @PostMapping
    public ResponseEntity<SyncRequestDtos.CallerView> create(
            @RequestBody SyncRequestDtos.CreateFromBackendReq req) {
        if (req.getRequesterUserId() == null) {
            return ResponseEntity.badRequest().build();
        }
        try {
            SyncRequest created = service.createFromBackend(
                    req.getRequesterUserId(), req.getProfileSnapshot());
            return ResponseEntity.status(HttpStatus.CREATED)
                    .body(SyncRequestDtos.CallerView.from(created));
        } catch (IllegalStateException e) {
            // Already an active request — return 409 with the existing one
            SyncRequest existing = service.findActive(req.getRequesterUserId()).orElseThrow();
            return ResponseEntity.status(HttpStatus.CONFLICT)
                    .body(SyncRequestDtos.CallerView.from(existing));
        }
    }

    @GetMapping("/active")
    public ResponseEntity<SyncRequestDtos.CallerView> active(@RequestParam UUID userId) {
        return service.findActive(userId)
                .map(SyncRequestDtos.CallerView::from)
                .map(ResponseEntity::ok)
                .orElseGet(() -> ResponseEntity.noContent().build());
    }

    @GetMapping("/{id}")
    public ResponseEntity<SyncRequestDtos.CallerView> get(@PathVariable UUID id) {
        return ResponseEntity.ok(SyncRequestDtos.CallerView.from(service.get(id)));
    }

    /** Researcher self-service cancel — backend wraps this. */
    @PostMapping("/{id}/cancel")
    public ResponseEntity<SyncRequestDtos.CallerView> cancel(@PathVariable UUID id,
                                                             @RequestParam UUID userId) {
        SyncRequest req = service.get(id);
        if (!req.getRequesterUserId().equals(userId)) {
            return ResponseEntity.status(HttpStatus.FORBIDDEN).build();
        }
        SyncRequest updated = service.reject(id, null /* system */, "İstek sahibi tarafından iptal edildi");
        return ResponseEntity.ok(SyncRequestDtos.CallerView.from(updated));
    }

    /**
     * Backend-driven source data ingestion. Used when the data isn't coming
     * from the Chrome extension — e.g. OpenAlex public API, ROR, ORCID
     * record, or any other server-side fetcher. The backend POSTs a
     * normalised source blob and the broker folds it into stagedData,
     * setting that source's progress to OK.
     *
     * <p>Body shape:
     * <pre>
     *   {
     *     "source": "OPENALEX",
     *     "metrics": { "hIndex": 14, "citations": 750, "documents": 26 },
     *     "publications": [ { "doi": "...", "title": "...", ... }, ... ],
     *     "scrapedAt": "ISO-8601",
     *     "provenance": "BACKEND"
     *   }
     * </pre>
     */
    @PostMapping("/{id}/source-data")
    public ResponseEntity<java.util.Map<String, Object>> writeSourceData(
            @PathVariable UUID id,
            @RequestBody java.util.Map<String, Object> body) {
        Object src = body.get("source");
        if (!(src instanceof String s) || s.isBlank()) {
            return ResponseEntity.badRequest().body(java.util.Map.of("ok", false, "error", "source required"));
        }
        java.util.Map<String, Object> blob = new java.util.HashMap<>(body);
        blob.remove("source");
        service.writeSourceData(id, s, blob);
        return ResponseEntity.ok(java.util.Map.of("ok", true, "source", s.toUpperCase()));
    }
}

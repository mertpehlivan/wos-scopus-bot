package com.academic.broker.api;

import com.academic.broker.service.SessionStateService;
import com.fasterxml.jackson.annotation.JsonProperty;
import jakarta.validation.constraints.NotBlank;
import lombok.RequiredArgsConstructor;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;

import java.util.Map;

/**
 * HTTP surface for per-source login/session state.
 *
 * <ul>
 *   <li>{@code GET /api/session-status?source=WOS} — backend polls this to decide
 *       whether to keep waiting on a stuck task.</li>
 *   <li>{@code POST /api/session-events} — Chrome extension reports state
 *       transitions ({@code LOGIN_DETECTED}, {@code LOGIN_IN_PROGRESS},
 *       {@code LOGIN_SUCCESS}, {@code LOGIN_FAILED}).</li>
 * </ul>
 */
@RestController
@RequestMapping("/api")
@RequiredArgsConstructor
public class SessionStateController {

    private final SessionStateService sessionStateService;

    @GetMapping("/session-status")
    public ResponseEntity<Map<String, Object>> getStatus(@RequestParam("source") String source) {
        SessionStateService.Snapshot snap = sessionStateService.snapshot(source);
        return ResponseEntity.ok(snap.toMap());
    }

    @PostMapping("/session-events")
    public ResponseEntity<Map<String, Object>> postEvent(@RequestBody SessionEventRequest body) {
        sessionStateService.recordEvent(body.source(), body.event(), body.detail());
        SessionStateService.Snapshot snap = sessionStateService.snapshot(body.source());
        return ResponseEntity.ok(Map.of(
                "ok", true,
                "state", snap.state().name(),
                "since", snap.since().toString()
        ));
    }

    public record SessionEventRequest(
            @NotBlank @JsonProperty("source") String source,
            @NotBlank @JsonProperty("event") String event,
            @JsonProperty("detail") String detail
    ) {}
}

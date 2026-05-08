package com.academic.broker.api;

import com.academic.broker.service.BackendProxyService;
import lombok.RequiredArgsConstructor;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

import java.util.Map;

/**
 * Researcher typeahead for the operator panel's manual-entry wizard.
 * Forwards through the broker so the operator never holds the main
 * backend's internal key directly. Protected by the operator-token filter
 * (path starts with {@code /api/operator/}).
 */
@RestController
@RequestMapping("/api/operator/researchers")
@RequiredArgsConstructor
public class OperatorResearcherController {

    private final BackendProxyService backendProxy;

    @GetMapping("/search")
    public ResponseEntity<Map<String, Object>> search(
            @RequestParam(name = "q", required = false, defaultValue = "") String q,
            @RequestParam(name = "limit", required = false, defaultValue = "10") int limit) {
        return ResponseEntity.ok(backendProxy.searchResearchers(q, limit));
    }
}

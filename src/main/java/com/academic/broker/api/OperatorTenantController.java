package com.academic.broker.api;

import com.academic.broker.config.TenantRegistry;
import lombok.RequiredArgsConstructor;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

import java.util.List;

/**
 * Exposes the configured multi-tenant backends to the operator panel so the
 * manual-entry wizard can pick which backend a hand-created sync targets.
 * Operator-token protected (path under {@code /api/operator/}). Returns only
 * id/name/url — never the inbound key or callback token.
 */
@RestController
@RequestMapping("/api/operator/tenants")
@RequiredArgsConstructor
public class OperatorTenantController {

    private final TenantRegistry tenantRegistry;

    @GetMapping
    public ResponseEntity<List<TenantRegistry.TenantView>> list() {
        return ResponseEntity.ok(tenantRegistry.publicList());
    }
}

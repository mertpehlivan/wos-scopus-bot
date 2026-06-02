package com.academic.broker.service;

import com.fasterxml.jackson.databind.ObjectMapper;
import lombok.extern.slf4j.Slf4j;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Service;

import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.time.Duration;
import java.util.List;
import java.util.Map;

/**
 * Calls the main backend (rdl-sis) on the operator panel's behalf — the
 * operator never has the backend's internal API key, so the broker proxies
 * the lookups (researcher search, profile-by-id) using its own credential.
 */
@Slf4j
@Service
public class BackendProxyService {

    private static final HttpClient HTTP = HttpClient.newBuilder()
            .connectTimeout(Duration.ofSeconds(8))
            .build();

    @Value("${broker.backend-url}")
    private String backendUrl;

    @Value("${broker.backend-api-key:${broker.api-key}}")
    private String backendApiKey;

    private final ObjectMapper objectMapper;
    private final com.academic.broker.config.TenantRegistry tenantRegistry;

    public BackendProxyService(ObjectMapper objectMapper,
                               com.academic.broker.config.TenantRegistry tenantRegistry) {
        this.objectMapper = objectMapper;
        this.tenantRegistry = tenantRegistry;
    }

    /** Typeahead search used by the manual-entry wizard (global backend). */
    public Map<String, Object> searchResearchers(String q, int limit) {
        return searchResearchers(q, limit, null);
    }

    /**
     * Multi-tenant variant: search a specific backend by base URL. When the URL
     * matches a registered tenant, that tenant's URL + callback token are used;
     * otherwise falls back to the global backend (single-tenant / unknown URL).
     */
    public Map<String, Object> searchResearchers(String q, int limit, String backendBaseUrlOverride) {
        try {
            String base = backendUrl;
            String token = backendApiKey;
            if (backendBaseUrlOverride != null && !backendBaseUrlOverride.isBlank()) {
                var tenant = tenantRegistry.byUrl(backendBaseUrlOverride);
                if (tenant.isPresent()) {
                    base = tenant.get().url;
                    token = tenant.get().callbackToken;
                }
            }
            String url = trim(base) + "/api/v1/internal/researchers/search?q="
                    + java.net.URLEncoder.encode(q == null ? "" : q, java.nio.charset.StandardCharsets.UTF_8)
                    + "&limit=" + Math.max(1, Math.min(limit, 25));
            HttpRequest req = HttpRequest.newBuilder()
                    .uri(URI.create(url))
                    .header("X-Internal-Key", token)
                    .GET()
                    .timeout(Duration.ofSeconds(10))
                    .build();
            HttpResponse<String> resp = HTTP.send(req, HttpResponse.BodyHandlers.ofString());
            if (resp.statusCode() == 200) {
                @SuppressWarnings("unchecked")
                Map<String, Object> body = objectMapper.readValue(resp.body(), Map.class);
                return body;
            }
            log.warn("[BackendProxy] researcher search HTTP {}", resp.statusCode());
        } catch (Exception e) {
            log.warn("[BackendProxy] researcher search failed: {}", e.getMessage());
        }
        return Map.of("total", 0, "results", List.of());
    }

    private static String trim(String s) {
        if (s == null) return "";
        return s.endsWith("/") ? s.substring(0, s.length() - 1) : s;
    }
}

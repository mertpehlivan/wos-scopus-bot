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

    public BackendProxyService(ObjectMapper objectMapper) {
        this.objectMapper = objectMapper;
    }

    /** Typeahead search used by the manual-entry wizard. */
    public Map<String, Object> searchResearchers(String q, int limit) {
        try {
            String url = trim(backendUrl) + "/api/v1/internal/researchers/search?q="
                    + java.net.URLEncoder.encode(q == null ? "" : q, java.nio.charset.StandardCharsets.UTF_8)
                    + "&limit=" + Math.max(1, Math.min(limit, 25));
            HttpRequest req = HttpRequest.newBuilder()
                    .uri(URI.create(url))
                    .header("X-Internal-Key", backendApiKey)
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

package com.academic.broker.config;

import com.fasterxml.jackson.databind.ObjectMapper;
import jakarta.annotation.PostConstruct;
import lombok.Getter;
import lombok.extern.slf4j.Slf4j;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Component;

import java.util.ArrayList;
import java.util.List;
import java.util.Optional;

/**
 * Multi-tenant registry. Configured via the {@code BROKER_TENANTS_JSON} env var
 * (a JSON array of {@code {id,name,url,inboundKey,callbackToken}}). Empty/unset
 * = single-tenant mode — no behaviour change.
 *
 * <p>Enables:
 * <ul>
 *   <li>per-tenant inbound API keys (in addition to the shared {@code broker.api-key}),</li>
 *   <li>resolving a tenant's callback URL + token for operator-created (MANUAL)
 *       syncs and researcher-search routing,</li>
 *   <li>implicitly allowing each registered tenant's URL as a callback target.</li>
 * </ul>
 *
 * <p>Secrets ({@code inboundKey}, {@code callbackToken}) are NEVER exposed via
 * {@link #publicList()} — only id/name/url leave the broker.
 */
@Slf4j
@Component
public class TenantRegistry {

    /** One registered backend. Public fields so Jackson binds the JSON array directly. */
    public static class Tenant {
        public String id;
        public String name;
        public String url;
        public String inboundKey;
        public String callbackToken;
    }

    /** Public projection for the operator panel — no secrets. */
    public record TenantView(String id, String name, String url) {}

    @Value("${broker.tenants-json:[]}")
    private String tenantsJson;

    private final ObjectMapper objectMapper;

    @Getter
    private volatile List<Tenant> tenants = List.of();

    public TenantRegistry(ObjectMapper objectMapper) {
        this.objectMapper = objectMapper;
    }

    @PostConstruct
    void load() {
        try {
            if (tenantsJson != null && !tenantsJson.isBlank()) {
                Tenant[] arr = objectMapper.readValue(tenantsJson, Tenant[].class);
                List<Tenant> parsed = new ArrayList<>();
                for (Tenant t : arr) {
                    if (t != null && t.url != null && !t.url.isBlank()) {
                        t.url = trimSlash(t.url.trim());
                        parsed.add(t);
                    }
                }
                this.tenants = List.copyOf(parsed);
            }
        } catch (Exception e) {
            // Never crash on bad config — fall back to single-tenant mode.
            log.error("[TenantRegistry] Failed to parse BROKER_TENANTS_JSON; running with NO tenants "
                    + "(single-tenant mode). Error: {}", e.getMessage());
            this.tenants = List.of();
        }
        log.info("[TenantRegistry] Loaded {} tenant(s){}", tenants.size(),
                tenants.isEmpty() ? " — single-tenant / shared-key mode" : "");
    }

    /** True if the given X-Api-Key belongs to a registered tenant. */
    public boolean isValidInboundKey(String key) {
        if (key == null || key.isBlank()) return false;
        for (Tenant t : tenants) {
            if (key.equals(t.inboundKey)) return true;
        }
        return false;
    }

    /** Look up a tenant by (trailing-slash-insensitive) base URL. */
    public Optional<Tenant> byUrl(String url) {
        if (url == null || url.isBlank()) return Optional.empty();
        String u = trimSlash(url.trim());
        for (Tenant t : tenants) {
            if (u.equalsIgnoreCase(t.url)) return Optional.of(t);
        }
        return Optional.empty();
    }

    /** Secret-free projection for the operator panel dropdown. */
    public List<TenantView> publicList() {
        List<TenantView> out = new ArrayList<>();
        for (Tenant t : tenants) {
            out.add(new TenantView(t.id, t.name, t.url));
        }
        return out;
    }

    private static String trimSlash(String s) {
        return s.endsWith("/") ? s.substring(0, s.length() - 1) : s;
    }
}

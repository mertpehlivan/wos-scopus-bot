package com.academic.broker.config;

import com.academic.broker.service.OperatorAuthService;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.security.config.annotation.web.builders.HttpSecurity;
import org.springframework.security.config.annotation.web.configuration.EnableWebSecurity;
import org.springframework.security.config.http.SessionCreationPolicy;
import org.springframework.security.web.SecurityFilterChain;
import org.springframework.security.web.authentication.UsernamePasswordAuthenticationFilter;
import org.springframework.web.cors.CorsConfiguration;
import org.springframework.web.cors.CorsConfigurationSource;
import org.springframework.web.cors.UrlBasedCorsConfigurationSource;

import java.util.Arrays;
import java.util.List;

/**
 * Broker security configuration.
 * All API endpoints are protected with a shared API key (X-Api-Key header).
 * Stateless — no sessions, no CSRF.
 */
@Configuration
@EnableWebSecurity
public class SecurityConfig {

    @Value("${broker.api-key}")
    private String brokerApiKey;

    /**
     * Chrome extension origin is read from config — supports any installed extension ID
     * without requiring a code change or redeploy.
     * Set via env: BROKER_EXTENSION_ORIGIN=chrome-extension://<extension-id>
     */
    @Value("${broker.extension-origin:chrome-extension://*}")
    private String extensionOrigin;

    /** Origin where the operator panel runs. CSV — multiple allowed. */
    @Value("${broker.operator-panel-origin:http://localhost:3001,http://localhost:3000}")
    private String operatorPanelOrigins;

    @Bean
    public SecurityFilterChain filterChain(HttpSecurity http,
                                           OperatorAuthService operatorAuthService,
                                           TenantRegistry tenantRegistry) throws Exception {
        http
                .cors(cors -> cors.configurationSource(corsConfigurationSource()))
                .csrf(csrf -> csrf.disable())
                .sessionManagement(sm -> sm.sessionCreationPolicy(SessionCreationPolicy.STATELESS))
                .authorizeHttpRequests(auth -> auth.anyRequest().permitAll())
                // Order matters: ApiKey first (for backend/extension calls),
                // then operator-token filter for /api/operator/sync-requests/**.
                // Each filter's shouldNotFilter() bows out for the other's path.
                .addFilterBefore(new ApiKeyAuthFilter(brokerApiKey, tenantRegistry),
                        UsernamePasswordAuthenticationFilter.class)
                .addFilterAfter(new OperatorAuthFilter(operatorAuthService),
                        ApiKeyAuthFilter.class);
        return http.build();
    }

    @Bean
    public CorsConfigurationSource corsConfigurationSource() {
        CorsConfiguration configuration = new CorsConfiguration();
        // Use allowedOriginPatterns (supports wildcards) instead of setAllowedOrigins
        // so we don't need to hardcode extension IDs and allowCredentials can be toggled.
        java.util.List<String> patterns = new java.util.ArrayList<>(List.of(
                "chrome-extension://*",
                "http://localhost:*",
                "http://127.0.0.1:*",
                extensionOrigin
        ));
        if (operatorPanelOrigins != null && !operatorPanelOrigins.isBlank()) {
            for (String o : operatorPanelOrigins.split(",")) {
                String trimmed = o.trim();
                if (!trimmed.isEmpty()) patterns.add(trimmed);
            }
        }
        configuration.setAllowedOriginPatterns(patterns);
        configuration.setAllowedMethods(Arrays.asList("GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"));
        configuration.setAllowedHeaders(Arrays.asList("authorization", "content-type", "x-auth-token", "X-Api-Key"));
        configuration.setExposedHeaders(List.of("X-Api-Key"));
        configuration.setAllowCredentials(false);

        UrlBasedCorsConfigurationSource source = new UrlBasedCorsConfigurationSource();
        source.registerCorsConfiguration("/**", configuration);
        return source;
    }
}

package com.academic.broker.config;

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

    @Bean
    public SecurityFilterChain filterChain(HttpSecurity http) throws Exception {
        http
                .cors(cors -> cors.configurationSource(corsConfigurationSource()))
                .csrf(csrf -> csrf.disable())
                .sessionManagement(sm -> sm.sessionCreationPolicy(SessionCreationPolicy.STATELESS))
                .authorizeHttpRequests(auth -> auth.anyRequest().permitAll())
                .addFilterBefore(new ApiKeyAuthFilter(brokerApiKey),
                        UsernamePasswordAuthenticationFilter.class);
        return http.build();
    }

    @Bean
    public CorsConfigurationSource corsConfigurationSource() {
        CorsConfiguration configuration = new CorsConfiguration();
        // Use allowedOriginPatterns (supports wildcards) instead of setAllowedOrigins
        // so we don't need to hardcode extension IDs and allowCredentials can be toggled.
        configuration.setAllowedOriginPatterns(List.of(
                "chrome-extension://*",  // All Chrome extensions (development-friendly)
                "http://localhost:*",    // Local development
                extensionOrigin          // Specific extension ID from config (production override)
        ));
        configuration.setAllowedMethods(Arrays.asList("GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"));
        configuration.setAllowedHeaders(Arrays.asList("authorization", "content-type", "x-auth-token", "X-Api-Key"));
        configuration.setExposedHeaders(List.of("X-Api-Key"));
        configuration.setAllowCredentials(false);

        UrlBasedCorsConfigurationSource source = new UrlBasedCorsConfigurationSource();
        source.registerCorsConfiguration("/**", configuration);
        return source;
    }
}

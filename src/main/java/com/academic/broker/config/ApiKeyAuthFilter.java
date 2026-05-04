package com.academic.broker.config;

import jakarta.servlet.FilterChain;
import jakarta.servlet.DispatcherType;
import jakarta.servlet.ServletException;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.web.filter.OncePerRequestFilter;

import java.io.IOException;

/**
 * API key authentication filter.
 * Rejects any request that doesn't carry a matching X-Api-Key header.
 */
public class ApiKeyAuthFilter extends OncePerRequestFilter {

    private static final Logger log = LoggerFactory.getLogger(ApiKeyAuthFilter.class);
    private static final String HEADER = "X-Api-Key";
    /** Default key used when BROKER_API_KEY env var is not set. MUST be changed in production. */
    private static final String DEFAULT_INSECURE_KEY = "change-me-in-production";

    private final String expectedApiKey;

    public ApiKeyAuthFilter(String expectedApiKey) {
        this.expectedApiKey = expectedApiKey;
        if (DEFAULT_INSECURE_KEY.equals(expectedApiKey)) {
            log.warn("[SECURITY] Broker is running with the default insecure API key! "
                    + "Set BROKER_API_KEY environment variable before deploying to production.");
        }
    }

    @Override
    protected boolean shouldNotFilter(HttpServletRequest request) {
        return request.getDispatcherType() == DispatcherType.ERROR
                || "OPTIONS".equalsIgnoreCase(request.getMethod())
                || "/error".equals(request.getRequestURI());
    }

    @Override
    protected void doFilterInternal(HttpServletRequest request,
            HttpServletResponse response,
            FilterChain filterChain)
            throws ServletException, IOException {

        String providedKey = request.getHeader(HEADER);
        if (expectedApiKey == null || !expectedApiKey.equals(providedKey)) {
            response.setStatus(HttpServletResponse.SC_UNAUTHORIZED);
            response.setContentType("application/json");
            response.getWriter().write("{\"error\":\"Unauthorized: missing or invalid X-Api-Key header\"}");
            return;
        }
        filterChain.doFilter(request, response);
    }
}

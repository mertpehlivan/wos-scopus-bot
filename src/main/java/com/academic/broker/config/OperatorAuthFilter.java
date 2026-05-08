package com.academic.broker.config;

import com.academic.broker.service.OperatorAuthService;
import jakarta.servlet.FilterChain;
import jakarta.servlet.ServletException;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import org.springframework.web.filter.OncePerRequestFilter;

import java.io.IOException;
import java.util.Optional;
import java.util.UUID;

/**
 * Validates {@code Authorization: Bearer <token>} on /api/operator/sync-requests/**.
 * Sets {@link #OPERATOR_ID_ATTR} request attribute so controllers can read it
 * via {@code @RequestAttribute}.
 *
 * <p>Endpoints under /api/operator/auth/** are exempt (login itself).
 */
public class OperatorAuthFilter extends OncePerRequestFilter {

    public static final String OPERATOR_ID_ATTR = "operatorUserId";

    private final OperatorAuthService authService;

    public OperatorAuthFilter(OperatorAuthService authService) {
        this.authService = authService;
    }

    @Override
    protected boolean shouldNotFilter(HttpServletRequest request) {
        String path = request.getRequestURI();
        // Enforce on every /api/operator/** endpoint *except* the auth/login
        // routes (which are how the operator gets a token in the first place).
        if (!path.startsWith("/api/operator/")) return true;
        if (path.startsWith("/api/operator/auth/")) return true;
        return false;
    }

    @Override
    protected void doFilterInternal(HttpServletRequest request,
                                    HttpServletResponse response,
                                    FilterChain chain)
            throws ServletException, IOException {

        String header = request.getHeader("Authorization");
        if (header == null || !header.startsWith("Bearer ")) {
            response.setStatus(HttpServletResponse.SC_UNAUTHORIZED);
            response.setContentType("application/json");
            response.getWriter().write("{\"error\":\"missing operator token\"}");
            return;
        }
        String token = header.substring("Bearer ".length()).trim();
        Optional<UUID> opId = authService.verifyToken(token);
        if (opId.isEmpty()) {
            response.setStatus(HttpServletResponse.SC_UNAUTHORIZED);
            response.setContentType("application/json");
            response.getWriter().write("{\"error\":\"invalid or expired token\"}");
            return;
        }
        request.setAttribute(OPERATOR_ID_ATTR, opId.get());
        chain.doFilter(request, response);
    }
}

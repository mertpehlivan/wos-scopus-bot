package com.academic.broker.config;

import com.academic.broker.service.OperatorAuthService;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.boot.context.event.ApplicationReadyEvent;
import org.springframework.context.event.EventListener;
import org.springframework.stereotype.Component;

/**
 * On startup, creates a default operator if none exists, so the panel
 * isn't unreachable on a fresh install. Credentials configurable via env.
 */
@Slf4j
@Component
@RequiredArgsConstructor
public class OperatorBootstrap {

    private final OperatorAuthService authService;

    @Value("${broker.default-operator.username:admin}")
    private String defaultUsername;

    @Value("${broker.default-operator.password:admin}")
    private String defaultPassword;

    @EventListener(ApplicationReadyEvent.class)
    public void seed() {
        try {
            authService.ensureDefaultAdmin(defaultUsername, defaultPassword);
        } catch (Exception e) {
            log.warn("[Bootstrap] Could not seed default operator: {}", e.getMessage());
        }
    }
}

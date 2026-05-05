package com.academic.broker.service;

import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Service;

import java.time.Instant;
import java.util.Locale;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;

/**
 * Tracks the current login/session state per source (WOS, SCOPUS, SCHOLAR)
 * as reported by the Chrome extension. Lives in-memory — restarting the
 * broker resets to UNKNOWN, which the backend treats as "no special handling".
 *
 * <p>The extension's {@code wos_session_handler.js} (and equivalents) POSTs
 * events here whenever it detects login screens or completes auto-login.
 * Backend polls {@link #snapshot(String)} during sync to decide whether to
 * keep waiting on a task that's hit auth failure, or give up.
 */
@Slf4j
@Service
public class SessionStateService {

    public enum State {
        /** Bot has not reported any state for this source — assume fine until proven otherwise. */
        UNKNOWN,
        /** Last scrape succeeded — session valid. */
        OK,
        /** Login screen detected; auto-login not yet attempted. */
        LOGIN_REQUIRED,
        /** Auto-login in progress (extension is filling credentials / submitting). */
        LOGIN_IN_PROGRESS,
        /** Auto-login attempt failed (e.g., MFA, captcha, wrong password). User intervention needed. */
        LOGIN_FAILED
    }

    public record Snapshot(State state, Instant since, String detail) {
        public Map<String, Object> toMap() {
            return Map.of(
                    "state", state.name(),
                    "since", since.toString(),
                    "detail", detail == null ? "" : detail
            );
        }
    }

    private final Map<String, Snapshot> states = new ConcurrentHashMap<>();

    public Snapshot snapshot(String source) {
        return states.getOrDefault(normalize(source),
                new Snapshot(State.UNKNOWN, Instant.now(), null));
    }

    /** Records a state transition. Idempotent — repeated same-state events do not bump {@code since}. */
    public void recordEvent(String source, String eventName, String detail) {
        if (source == null || source.isBlank() || eventName == null) {
            return;
        }
        State newState = mapEventToState(eventName);
        if (newState == null) {
            log.debug("[Session] Unknown event '{}' for source {}, ignored", eventName, source);
            return;
        }
        String key = normalize(source);
        Snapshot existing = states.get(key);
        if (existing != null && existing.state == newState) {
            // Same state — keep original since, just update detail
            states.put(key, new Snapshot(newState, existing.since, detail));
            return;
        }
        states.put(key, new Snapshot(newState, Instant.now(), detail));
        log.info("[Session] {} → {} (detail: {})", key, newState, detail);
    }

    private static State mapEventToState(String event) {
        return switch (event.toUpperCase(Locale.ROOT)) {
            case "LOGIN_DETECTED", "LOGIN_REQUIRED" -> State.LOGIN_REQUIRED;
            case "LOGIN_IN_PROGRESS" -> State.LOGIN_IN_PROGRESS;
            case "LOGIN_SUCCESS", "OK" -> State.OK;
            case "LOGIN_FAILED" -> State.LOGIN_FAILED;
            default -> null;
        };
    }

    private static String normalize(String source) {
        return source.trim().toUpperCase(Locale.ROOT);
    }
}

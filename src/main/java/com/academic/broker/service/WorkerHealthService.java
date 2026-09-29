package com.academic.broker.service;

import org.springframework.stereotype.Service;

import java.time.Duration;
import java.time.Instant;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;

/**
 * In-memory view of the Chrome-extension worker's liveness, fed by
 * {@code POST /api/worker/ping} (every minute) and task polls. The broker runs
 * as a single instance, so memory is enough; after a broker restart the panel
 * shows "no signal yet" until the next ping (≤ 1 min).
 *
 * <p>The ping payload is stored verbatim under a small allowlist so a
 * misbehaving client can't grow this map without bound.
 */
@Service
public class WorkerHealthService {

    /** No ping for this long → the panel shows the worker as offline. */
    public static final Duration OFFLINE_AFTER = Duration.ofMinutes(3);

    private static final Set<String> PING_KEYS = Set.of(
            "extensionVersion", "windowState", "windowVisible", "busy",
            "activeTasks", "wosSession", "alerts", "queue");

    private volatile Instant lastPingAt;
    private volatile Map<String, Object> lastPing = Map.of();
    private final Map<String, Instant> lastPollBySource = new ConcurrentHashMap<>();

    public void recordPing(Map<String, Object> payload) {
        Map<String, Object> kept = new LinkedHashMap<>();
        if (payload != null) {
            for (Map.Entry<String, Object> e : payload.entrySet()) {
                if (PING_KEYS.contains(e.getKey())) kept.put(e.getKey(), e.getValue());
            }
        }
        lastPing = kept;
        lastPingAt = Instant.now();
    }

    public void recordPoll(String source) {
        if (source != null) lastPollBySource.put(source, Instant.now());
    }

    /** Snapshot for the operator panel. */
    public Map<String, Object> snapshot() {
        Instant now = Instant.now();
        Instant lastPoll = lastPollBySource.values().stream().max(Instant::compareTo).orElse(null);
        Instant lastSeen = latest(lastPingAt, lastPoll);

        Map<String, Object> out = new LinkedHashMap<>();
        out.put("online", lastSeen != null && Duration.between(lastSeen, now).compareTo(OFFLINE_AFTER) < 0);
        out.put("lastSeenAt", lastSeen == null ? null : lastSeen.toString());
        out.put("lastPingAt", lastPingAt == null ? null : lastPingAt.toString());
        out.put("secondsSinceSeen", lastSeen == null ? null : Duration.between(lastSeen, now).toSeconds());
        Map<String, String> polls = new LinkedHashMap<>();
        for (String s : List.copyOf(lastPollBySource.keySet())) {
            polls.put(s, lastPollBySource.get(s).toString());
        }
        out.put("lastPollBySource", polls);
        out.put("ping", lastPing);
        return out;
    }

    private static Instant latest(Instant a, Instant b) {
        if (a == null) return b;
        if (b == null) return a;
        return a.isAfter(b) ? a : b;
    }
}

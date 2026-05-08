package com.academic.broker.service;

import com.academic.broker.domain.OperatorUser;
import com.academic.broker.repository.OperatorUserRepository;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.security.crypto.bcrypt.BCryptPasswordEncoder;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import javax.crypto.Mac;
import javax.crypto.spec.SecretKeySpec;
import java.nio.charset.StandardCharsets;
import java.time.Instant;
import java.util.Base64;
import java.util.Optional;
import java.util.UUID;

/**
 * Lightweight HMAC-signed token service for the operator panel.
 * Avoids dragging a full JWT lib into the broker — tokens are
 * {@code base64url(payload).base64url(hmacSha256(payload))}.
 *
 * <p>Payload format: {@code userId|username|expiryEpochSec}.
 */
@Slf4j
@Service
@RequiredArgsConstructor
public class OperatorAuthService {

    private final OperatorUserRepository repository;
    private final BCryptPasswordEncoder passwordEncoder = new BCryptPasswordEncoder();

    @Value("${broker.operator-token-secret:${broker.api-key}}")
    private String tokenSecret;

    /** Default token lifetime. Operator stays logged-in for 12h. */
    private static final long TOKEN_TTL_SEC = 12L * 3600L;

    @Transactional
    public OperatorUser authenticate(String username, String rawPassword) {
        OperatorUser user = repository.findByUsername(username)
                .orElseThrow(() -> new IllegalArgumentException("Geçersiz kullanıcı adı veya şifre"));
        if (!user.isActive()) {
            throw new IllegalStateException("Hesap pasif durumda");
        }
        if (!passwordEncoder.matches(rawPassword, user.getPasswordHash())) {
            throw new IllegalArgumentException("Geçersiz kullanıcı adı veya şifre");
        }
        user.setLastLoginAt(Instant.now());
        repository.save(user);
        return user;
    }

    public String issueToken(OperatorUser user) {
        long expiry = Instant.now().getEpochSecond() + TOKEN_TTL_SEC;
        String payload = user.getId() + "|" + user.getUsername() + "|" + expiry;
        String signature = sign(payload);
        return base64Url(payload) + "." + base64Url(signature);
    }

    /** Verifies a token. Returns the operator id if valid, empty otherwise. */
    public Optional<UUID> verifyToken(String token) {
        if (token == null || token.isBlank()) return Optional.empty();
        String[] parts = token.split("\\.");
        if (parts.length != 2) return Optional.empty();
        String payload, signature;
        try {
            payload = new String(Base64.getUrlDecoder().decode(parts[0]), StandardCharsets.UTF_8);
            signature = new String(Base64.getUrlDecoder().decode(parts[1]), StandardCharsets.UTF_8);
        } catch (IllegalArgumentException e) {
            return Optional.empty();
        }
        if (!constantTimeEquals(signature, sign(payload))) return Optional.empty();

        String[] segments = payload.split("\\|");
        if (segments.length != 3) return Optional.empty();
        long expiry;
        try {
            expiry = Long.parseLong(segments[2]);
        } catch (NumberFormatException e) {
            return Optional.empty();
        }
        if (expiry < Instant.now().getEpochSecond()) return Optional.empty();
        try {
            return Optional.of(UUID.fromString(segments[0]));
        } catch (IllegalArgumentException e) {
            return Optional.empty();
        }
    }

    /** Bootstrap helper — creates default admin if no operator exists. */
    @Transactional
    public OperatorUser ensureDefaultAdmin(String username, String rawPassword) {
        return repository.findByUsername(username).orElseGet(() -> {
            OperatorUser admin = OperatorUser.builder()
                    .username(username)
                    .passwordHash(passwordEncoder.encode(rawPassword))
                    .displayName("Admin")
                    .active(true)
                    .build();
            log.info("[Auth] Created default operator '{}'", username);
            return repository.save(admin);
        });
    }

    private String sign(String payload) {
        try {
            Mac mac = Mac.getInstance("HmacSHA256");
            mac.init(new SecretKeySpec(tokenSecret.getBytes(StandardCharsets.UTF_8), "HmacSHA256"));
            byte[] raw = mac.doFinal(payload.getBytes(StandardCharsets.UTF_8));
            return Base64.getUrlEncoder().withoutPadding().encodeToString(raw);
        } catch (Exception e) {
            throw new IllegalStateException("Token sign failed", e);
        }
    }

    private static String base64Url(String s) {
        return Base64.getUrlEncoder().withoutPadding()
                .encodeToString(s.getBytes(StandardCharsets.UTF_8));
    }

    private static boolean constantTimeEquals(String a, String b) {
        if (a == null || b == null || a.length() != b.length()) return false;
        int diff = 0;
        for (int i = 0; i < a.length(); i++) diff |= a.charAt(i) ^ b.charAt(i);
        return diff == 0;
    }
}

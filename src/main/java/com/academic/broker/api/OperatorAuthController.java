package com.academic.broker.api;

import com.academic.broker.api.dto.SyncRequestDtos;
import com.academic.broker.domain.OperatorUser;
import com.academic.broker.service.OperatorAuthService;
import lombok.RequiredArgsConstructor;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;

import java.util.Map;

@RestController
@RequestMapping("/api/operator/auth")
@RequiredArgsConstructor
public class OperatorAuthController {

    private final OperatorAuthService authService;

    @PostMapping("/login")
    public ResponseEntity<?> login(@RequestBody SyncRequestDtos.LoginReq req) {
        try {
            OperatorUser user = authService.authenticate(req.getUsername(), req.getPassword());
            String token = authService.issueToken(user);
            return ResponseEntity.ok(SyncRequestDtos.LoginResp.builder()
                    .token(token)
                    .userId(user.getId())
                    .username(user.getUsername())
                    .displayName(user.getDisplayName())
                    .build());
        } catch (IllegalArgumentException | IllegalStateException e) {
            return ResponseEntity.status(HttpStatus.UNAUTHORIZED)
                    .body(Map.of("error", e.getMessage()));
        }
    }
}

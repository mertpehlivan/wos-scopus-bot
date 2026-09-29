package com.academic.broker.api;

import com.academic.broker.config.OperatorAuthFilter;
import com.academic.broker.service.yearly.YearlyFixService;
import lombok.RequiredArgsConstructor;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestAttribute;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

import java.util.List;
import java.util.Map;
import java.util.UUID;

/**
 * R5 — operator review + send of yearly-series corrections for profiles
 * approved before the sanitizer existed. See {@link YearlyFixService}.
 */
@RestController
@RequestMapping("/api/operator/yearly-fixes")
@RequiredArgsConstructor
public class OperatorYearlyFixController {

    private final YearlyFixService service;

    @GetMapping
    public List<Map<String, Object>> list() {
        return service.candidates();
    }

    @PostMapping("/{id}/apply")
    public Map<String, Object> apply(@PathVariable UUID id,
                                     @RequestAttribute(OperatorAuthFilter.OPERATOR_ID_ATTR) UUID operatorId) {
        return service.apply(id, operatorId);
    }

    @PostMapping("/apply-all")
    public Map<String, Object> applyAll(@RequestAttribute(OperatorAuthFilter.OPERATOR_ID_ATTR) UUID operatorId) {
        return service.applyAll(operatorId);
    }
}

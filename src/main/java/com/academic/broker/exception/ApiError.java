package com.academic.broker.exception;

import com.fasterxml.jackson.annotation.JsonInclude;
import lombok.Builder;
import lombok.Value;

import java.time.Instant;
import java.util.List;

@Value
@Builder
@JsonInclude(JsonInclude.Include.NON_EMPTY)
public class ApiError {

    Instant timestamp;
    int status;
    String error;
    String message;
    String path;
    List<String> fieldErrors;

    public static ApiError of(int status, String error, String message, String path) {
        return ApiError.builder()
                .timestamp(Instant.now())
                .status(status)
                .error(error)
                .message(message)
                .path(path)
                .build();
    }
}

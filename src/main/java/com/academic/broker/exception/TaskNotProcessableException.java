package com.academic.broker.exception;

import com.academic.broker.domain.TaskStatus;

/**
 * Thrown when an operation is not allowed for the current task status
 * (e.g. complete/fail on a task that is not PROCESSING).
 */
public class TaskNotProcessableException extends RuntimeException {

    public TaskNotProcessableException(Long taskId, TaskStatus currentStatus, String operation) {
        super(String.format("Task %d cannot be %s: current status is %s", taskId, operation, currentStatus));
    }
}

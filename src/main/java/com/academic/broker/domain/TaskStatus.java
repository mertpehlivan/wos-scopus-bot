package com.academic.broker.domain;

/**
 * Lifecycle status of an article task.
 */
public enum TaskStatus {
    PENDING,    // Queued, waiting for a worker
    PROCESSING, // Claimed by a worker, scrape in progress
    COMPLETED,  // Scrape done, raw data stored
    FAILED      // Worker reported failure
}

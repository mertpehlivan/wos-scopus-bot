package com.academic.broker.domain;

/**
 * Determines the scope of work a Chrome extension worker performs for a task.
 */
public enum TaskType {
    /** Only scrape author-level metrics (h-index, citations, publications). */
    METRICS_ONLY,

    /** Full scrape: author metrics + all article detail pages. */
    FULL_SCRAPE,

    /** Citation sync: fetch citations for a specific DOI (PlumX). */
    CITATION_SYNC
}

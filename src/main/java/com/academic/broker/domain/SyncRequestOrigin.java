package com.academic.broker.domain;

/**
 * Where the staged data on a {@code SyncRequest} came from.
 *
 * <ul>
 *   <li>{@code WORKER} — Researcher hit "Senkronize Et"; Chrome extension
 *       worker scraped automatically.</li>
 *   <li>{@code MANUAL} — Operator created the request from the panel by hand;
 *       worker never ran.</li>
 *   <li>{@code HYBRID} — Started as WORKER, but operator filled in one or
 *       more sources the worker couldn't.</li>
 * </ul>
 */
public enum SyncRequestOrigin {
    WORKER,
    MANUAL,
    HYBRID
}

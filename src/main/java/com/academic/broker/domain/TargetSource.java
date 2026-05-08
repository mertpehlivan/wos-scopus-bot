package com.academic.broker.domain;

/**
 * Academic source for article data.
 * <ul>
 *   <li>{@code WOS} — Web of Science (browser scrape)</li>
 *   <li>{@code SCOPUS} — Scopus (browser scrape)</li>
 *   <li>{@code SCHOLAR} — Google Scholar (browser scrape)</li>
 *   <li>{@code PLUMX} — PlumX per-DOI metrics (browser scrape)</li>
 *   <li>{@code OPENALEX} — OpenAlex public API (worker calls it directly
 *       from the extension's background script, no tab needed)</li>
 * </ul>
 */
public enum TargetSource {
    WOS,
    SCOPUS,
    PLUMX,
    SCHOLAR,
    OPENALEX
}

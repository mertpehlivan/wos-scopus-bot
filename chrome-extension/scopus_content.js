/**
 * scopus_content.js
 * Scrapes Author Metrics from Scopus profile page.
 * TaskId is retrieved from chrome.storage.session (set by background.js openTaskTab).
 * Falls back to hash fragment for backward compatibility.
 *
 * v1.1 — Anti-bot detection: human-like timing
 */

(async function () {
    // Prevent double execution from manifest + programmatic injection
    if (window.__scopusWorkerRunning) return;
    window.__scopusWorkerRunning = true;

    // ── Stealth utilities ──
    function _gaussianRandom(min, max) {
        let u = 0, v = 0;
        while (u === 0) u = Math.random();
        while (v === 0) v = Math.random();
        let num = Math.sqrt(-2.0 * Math.log(u)) * Math.cos(2.0 * Math.PI * v);
        const mean = (min + max) / 2;
        const std = (max - min) / 6;
        num = num * std + mean;
        return Math.max(min, Math.min(max, Math.round(num)));
    }
    function _humanDelay(min = 500, max = 2000) {
        return new Promise(resolve => setTimeout(resolve, _gaussianRandom(min, max)));
    }

    try {
        // Get taskId from chrome.storage.session
        let taskId = null;
        let source = null;

        try {
            const tabInfo = await chrome.runtime.sendMessage({ type: 'GET_TASK_INFO' });
            if (tabInfo && tabInfo.taskId && tabInfo.source === 'SCOPUS') {
                taskId = tabInfo.taskId;
                source = tabInfo.source;
            }
        } catch (e) {
            console.log('[WoS Worker] Could not get task info from background:', e);
        }

        // Fallback: check hash fragment
        if (!taskId) {
            const hash = window.location.hash;
            const match = hash.match(/scopus-task-id=(\d+)/);
            if (match) {
                taskId = parseInt(match[1], 10);
            }
        }

        if (!taskId) {
            return;
        }

        // Bail early ONLY if the URL itself proves we're on a login/OAuth page.
        // We deliberately don't sniff the DOM here (e.g., password inputs)
        // because Scopus author pages can carry inline sign-in widgets that
        // would falsely trigger bail-out and starve the scrape.
        // Use pathname / host so query-string params like `?ref=login` don't
        // trip the check.
        const host = window.location.host;
        const path = window.location.pathname;
        const isLoginPage =
            host.includes('id.elsevier.com') ||
            path.includes('/authenticate/') ||
            path.includes('/oauth/') ||
            path === '/signin' || path.startsWith('/signin/') ||
            path === '/login' || path.startsWith('/login/');
        if (isLoginPage) {
            console.log('[WoS Worker] Scopus login redirect detected (host=' + host + ', path=' + path + ') — yielding to session handler');
            return;
        }
        console.log('[WoS Worker] Scopus author page check passed (host=' + host + ', path=' + path + ')');

        console.log(`[WoS Worker] Started handling Scopus task ID: ${taskId}`);

        // ── Handshake: Signal that the content script is ready ──
        chrome.runtime.sendMessage({ type: 'SCRAPE_READY', source: 'SCOPUS' });
        console.log('[WoS Worker] SCRAPE_READY signal sent for SCOPUS.');

        chrome.runtime.sendMessage({
            type: 'PROGRESS_UPDATE',
            log: 'Started parsing Scopus profile metrics...',
        });

        // Wait for DOM elements to render with human-like delays.
        // Two extraction strategies, run in tandem:
        //   1. Specific section selectors (fast when they match)
        //   2. Body-text regex fallback (resilient to Scopus DOM rewrites)
        let authorMetrics = { hIndex: 0, sumOfTimesCited: 0, publications: 0, citingArticles: 0 };

        const sectionSelectors = {
            citations: '[data-testid="metrics-section-citations-count"], [data-author-metrics-citations-count="true"], [data-testid*="citation"], [aria-label*="citation" i], .citations-count',
            docs:      '[data-testid="metrics-section-document-count"], [data-author-metrics-document-count="true"], [data-testid*="document"], [aria-label*="document" i], .document-count',
            hIndex:    '[data-testid="metrics-section-h-index"], [data-author-metrics-h-index="true"], [data-testid*="h-index" i], [aria-label*="h-index" i], .h-index',
        };
        const countNodeSelector = '[data-testid="unclickable-count"], [data-testid="clickable-count"], [data-testid*="count"], span.Typography-module__ix7bs, .Typography-module__ix7bs, .metrics-count';

        function extractCount(section) {
            if (!section) return 0;
            const node = section.querySelector(countNodeSelector);
            if (node) {
                const n = parseInt((node.textContent || '').replace(/,/g, ''), 10);
                if (!isNaN(n)) return n;
            }
            const text = (section.textContent || '').replace(/,/g, '').match(/\d+/);
            return text ? parseInt(text[0], 10) : 0;
        }

        // Body-text regex extractor — runs only if section selectors fail.
        // Scopus author pages put the metric numbers next to clearly-labelled text.
        function extractFromBodyText() {
            const txt = (document.body?.innerText || '').replace(/ /g, ' ');
            // h-index: "h-index" optionally followed by colon and a number
            const h = txt.match(/h[\s\-]*index[^0-9]{0,40}?(\d{1,5})/i);
            const cites = txt.match(/(?:total\s+citations?|sum\s+of\s+times\s+cited|citations\s+by[\s\d,]*?\s+documents?)[^0-9]{0,40}?(\d[\d,]{0,9})/i)
                || txt.match(/citations?\s*[:\-]?\s*(\d[\d,]{0,9})/i);
            const docs = txt.match(/(?:documents?(?:\s+by\s+author)?|publications?)[^0-9]{0,40}?(\d[\d,]{0,6})/i);
            const citing = txt.match(/citations\s+by\s+([\d,]+)\s+documents?/i);
            return {
                hIndex: h ? parseInt(h[1], 10) : 0,
                sumOfTimesCited: cites ? parseInt(cites[1].replace(/,/g, ''), 10) : 0,
                publications: docs ? parseInt(docs[1].replace(/,/g, ''), 10) : 0,
                citingArticles: citing ? parseInt(citing[1].replace(/,/g, ''), 10) : 0,
            };
        }

        for (let i = 0; i < 60; i++) {
            const citationsSection = document.querySelector(sectionSelectors.citations);
            const docsSection = document.querySelector(sectionSelectors.docs);
            const hIndexSection = document.querySelector(sectionSelectors.hIndex);

            if (citationsSection || docsSection || hIndexSection) {
                if (citationsSection) authorMetrics.sumOfTimesCited = extractCount(citationsSection);
                if (docsSection) authorMetrics.publications = extractCount(docsSection);
                if (hIndexSection) authorMetrics.hIndex = extractCount(hIndexSection);

                const citationsText = citationsSection ? citationsSection.textContent : "";
                const citingTextMatch = citationsText.match(/Citations by\s*([\d,]+)/i)
                    || (document.body?.innerText || '').match(/Citations by\s*([\d,]+)/i);
                if (citingTextMatch) {
                    authorMetrics.citingArticles = parseInt(citingTextMatch[1].replace(/,/g, ''), 10) || 0;
                }
                break;
            }
            await _humanDelay(800, 1500);
        }

        // If structured selectors failed, retry with body-text regex.
        if (authorMetrics.hIndex === 0 && authorMetrics.publications === 0) {
            console.log('[WoS Worker] Scopus structured selectors found nothing; trying body-text fallback');
            const fallback = extractFromBodyText();
            if (fallback.hIndex || fallback.publications || fallback.sumOfTimesCited) {
                authorMetrics = { ...authorMetrics, ...fallback };
                console.log('[WoS Worker] Scopus fallback parsed:', fallback);
            }
        }

        if (authorMetrics.hIndex === 0 && authorMetrics.publications === 0) {
            throw new Error('Could not find Scopus author metrics on page in time. Page might be restricted or structure changed.');
        }

        chrome.runtime.sendMessage({
            type: 'PROGRESS_UPDATE',
            log: `Scopus metrics found: h-index=${authorMetrics.hIndex}, citations=${authorMetrics.sumOfTimesCited}, docs=${authorMetrics.publications}`
        });

        // Human-like delay before sending metrics (don't instantly respond)
        await _humanDelay(500, 1500);

        // Send author metrics — background will complete the task
        chrome.runtime.sendMessage({
            type: 'AUTHOR_METRICS_COMPLETE',
            taskId,
            authorMetrics,
            url: window.location.href,
            source: 'SCOPUS',
        });

    } catch (error) {
        console.error('[WoS Worker] SCOPUS SCRAPE_FAIL:', error);
        chrome.runtime.sendMessage({
            type: 'SCRAPE_FAIL',
            error: error.message,
            source: 'SCOPUS',
        });
    }
})();

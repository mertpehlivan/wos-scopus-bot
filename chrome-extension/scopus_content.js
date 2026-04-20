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

        console.log(`[WoS Worker] Started handling Scopus task ID: ${taskId}`);

        // ── Handshake: Signal that the content script is ready ──
        chrome.runtime.sendMessage({ type: 'SCRAPE_READY', source: 'SCOPUS' });
        console.log('[WoS Worker] SCRAPE_READY signal sent for SCOPUS.');

        chrome.runtime.sendMessage({
            type: 'PROGRESS_UPDATE',
            log: 'Started parsing Scopus profile metrics...',
        });

        // Wait for DOM elements to render with human-like delays
        let authorMetrics = { hIndex: 0, sumOfTimesCited: 0, publications: 0, citingArticles: 0 };
        for (let i = 0; i < 60; i++) {
            const citationsSection = document.querySelector('[data-testid="metrics-section-citations-count"], [data-author-metrics-citations-count="true"], .citations-count');
            const docsSection = document.querySelector('[data-testid="metrics-section-document-count"], [data-author-metrics-document-count="true"], .document-count');
            const hIndexSection = document.querySelector('[data-testid="metrics-section-h-index"], [data-author-metrics-h-index="true"], .h-index');

            if (citationsSection || docsSection || hIndexSection) {
                const getCount = (section) => {
                    if (!section) return 0;
                    const node = section.querySelector('[data-testid="unclickable-count"], [data-testid="clickable-count"], span.Typography-module__ix7bs, .Typography-module__ix7bs, .metrics-count');
                    if (node) return parseInt(node.textContent.replace(/,/g, ''), 10);
                    // Fallback to text matching within section
                    const text = section.textContent.replace(/,/g, '').match(/\d+/);
                    return text ? parseInt(text[0], 10) : 0;
                };

                if (citationsSection) authorMetrics.sumOfTimesCited = getCount(citationsSection);
                if (docsSection) authorMetrics.publications = getCount(docsSection);
                if (hIndexSection) authorMetrics.hIndex = getCount(hIndexSection);

                const citationsText = citationsSection ? citationsSection.textContent : "";
                const citingTextMatch = citationsText.match(/Citations by\s*([\d,]+)/i) || document.body.innerText.match(/Citations by\s*([\d,]+)/i);
                if (citingTextMatch) {
                    authorMetrics.citingArticles = parseInt(citingTextMatch[1].replace(/,/g, ''), 10) || 0;
                }
                break;
            }
            // Human-like wait between DOM checks
            await _humanDelay(800, 1500);
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

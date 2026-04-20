/**
 * scholar_doi_content.js
 * Google Scholar DOI-tabanlı atıf sayısı çeken content script.
 *
 * URL: https://scholar.google.com/scholar_lookup?hl=en&doi={DOI}
 * Kazınan: .gs_fl footer içindeki "Cited by X" sayısı → scholar_citation_count
 *
 * v1.0 — Anti-bot detection: human-like timing + Gaussian delays
 */

(async function () {
    if (window.__scholarDOIWorkerRunning) return;
    window.__scholarDOIWorkerRunning = true;

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
    function parseCount(text) {
        if (!text) return 0;
        const match = text.replace(/,/g, '').match(/\d+/);
        return match ? parseInt(match[0], 10) : 0;
    }

    // ── Task & DOI identification ──
    let taskId = null;
    let doi = null;

    try {
        const info = await chrome.runtime.sendMessage({ type: 'GET_TASK_INFO' });
        if (info && info.taskId) {
            taskId = info.taskId;
            doi = info.externalId || info.doi || null;
        }
    } catch (e) {
        console.warn('[Scholar DOI] Cannot get task info from background:', e);
    }

    // Fallback: hash fragment #scholar-doi-task-id=123&doi=10.1234%2Fxyz
    if (!taskId) {
        const hashMatch = window.location.hash.match(/scholar-doi-task-id=(\d+)/);
        if (hashMatch) taskId = parseInt(hashMatch[1], 10);
    }
    if (!doi) {
        const doiMatch = window.location.hash.match(/doi=([^&]+)/);
        if (doiMatch) doi = decodeURIComponent(doiMatch[1]);
        // Also try query string
        if (!doi) {
            const urlParams = new URLSearchParams(window.location.search);
            doi = urlParams.get('doi') || null;
        }
    }

    if (!taskId || !doi) {
        console.warn('[Scholar DOI] Task ID or DOI not found — aborting.');
        return;
    }

    console.log(`[Scholar DOI] Task ${taskId} started for DOI: ${doi}`);
    chrome.runtime.sendMessage({ type: 'SCRAPE_READY', source: 'SCHOLAR_DOI' });

    // ── Wait for page content ──
    async function waitForContent(timeoutMs = 30000) {
        const deadline = Date.now() + timeoutMs;
        while (Date.now() < deadline) {
            // Either results or a "no results" indicator
            const results = document.querySelectorAll('.gs_r, .gs_fl, .gsc_a_tr, #gs_res_ccl');
            const noResults = document.querySelector('#gs_nrt, .gs_nrt');
            if (results.length > 0 || noResults) return true;
            // CAPTCHA/Robot detection
            if (document.body.textContent.includes('unusual traffic') ||
                document.body.textContent.includes('verify you are a human') ||
                document.querySelector('#captcha, iframe[src*="recaptcha"]')) {
                console.warn('[Scholar DOI] Bot detection detected!');
                chrome.runtime.sendMessage({ type: 'SCHOLAR_CAPTCHA_DETECTED', url: window.location.href });
                return false;
            }
            await _humanDelay(400, 800);
        }
        return false;
    }

    // ── Scrape "Cited by X" from .gs_fl footer ──
    function scrapeCitedBy() {
        // Search all footer links for "Cited by N"
        const footerLinks = document.querySelectorAll('.gs_fl a, .gs_rs a');
        for (const link of footerLinks) {
            const text = link.textContent.trim();
            const match = text.match(/[Cc]ited\s+by\s+([\d,]+)/);
            if (match) {
                const count = parseCount(match[1]);
                console.log(`[Scholar DOI] Found "Cited by ${count}" in footer.`);
                return count;
            }
        }

        // Broader fallback: scan entire page text
        const pageText = document.body.innerText || '';
        const matches = [...pageText.matchAll(/[Cc]ited\s+by\s+([\d,]+)/g)];
        if (matches.length > 0) {
            // Take the first (highest-context) match
            return parseCount(matches[0][1]);
        }

        console.log('[Scholar DOI] No "Cited by" text found on page.');
        return 0;
    }

    // ── Scrape abstract from result entry ──
    function scrapeAbstract() {
        // Scholar shows a snippet for lookup results
        const snippetEl = document.querySelector('.gs_rs, .gsc_oci_value');
        return snippetEl ? snippetEl.textContent.trim() : '';
    }

    // ── MAIN ──
    try {
        await _humanDelay(1200, 2500);

        chrome.runtime.sendMessage({ type: 'PROGRESS_UPDATE', log: `Scholar DOI lookup: ${doi}` });

        const hasContent = await waitForContent();

        // Check for "No results found" specifically
        const noResults = document.querySelector('#gs_nrt, .gs_nrt');
        if (noResults) {
            chrome.runtime.sendMessage({
                type: 'SCHOLAR_DOI_ENRICH_COMPLETE',
                taskId,
                doi,
                error: 'DOI_NOT_FOUND',
                data: null,
            });
            return;
        }

        if (!hasContent) {
            chrome.runtime.sendMessage({
                type: 'SCHOLAR_DOI_ENRICH_COMPLETE',
                taskId,
                doi,
                error: 'Timeout or CAPTCHA',
                data: null,
            });
            return;
        }

        await _humanDelay(500, 1000);
        const scholarCitations = scrapeCitedBy();
        const abstract = scrapeAbstract();

        console.log(`[Scholar DOI] Done: citations=${scholarCitations}, abstract length=${abstract.length}`);
        chrome.runtime.sendMessage({ type: 'PROGRESS_UPDATE', log: `Scholar DOI: citations=${scholarCitations}` });

        chrome.runtime.sendMessage({
            type: 'SCHOLAR_DOI_ENRICH_COMPLETE',
            taskId,
            doi,
            data: { scholarCitations, abstract },
        });

    } catch (err) {
        console.error('[Scholar DOI] Error:', err);
        chrome.runtime.sendMessage({
            type: 'SCHOLAR_DOI_ENRICH_COMPLETE',
            taskId,
            doi,
            error: err.message,
            data: null,
        });
    }
})();

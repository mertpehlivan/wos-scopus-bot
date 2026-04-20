/**
 * plumx_content.js
 * Injected into plu.mx/plum/a/* to scrape citation metrics from multiple sources.
 * Extracts: Scopus, Mendeley, CrossRef counts from PlumX widget.
 *
 * v1.1 — Anti-bot detection: human-like timing
 */

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

function waitForElements(selector, maxTries = 15) {
    return new Promise((resolve) => {
        let tries = 0;
        const interval = setInterval(() => {
            const els = document.querySelectorAll(selector);
            if (els.length > 0) {
                clearInterval(interval);
                resolve(els);
            } else if (tries >= maxTries) {
                clearInterval(interval);
                resolve([]);
            }
            tries++;
        }, _gaussianRandom(800, 1400)); // Human-like polling interval
    });
}

function parseAllMetricSources() {
    const result = {
        scopusCitations: 0,
        mendeleyCitations: 0,
        crossrefCitations: 0,
        // Altmetrics (capture counts)
        mendeleyReaders: 0,
        ebscoReaders: 0,
    };

    // ── Citation sources ──
    const citationSection = document.querySelector('.metric-details-citation');
    const citationSources = citationSection
        ? citationSection.querySelectorAll('.metric-source-item')
        : document.querySelectorAll('.metric-source-item');

    for (const item of citationSources) {
        const nameEl = item.querySelector('.metric-source-name');
        if (!nameEl) continue;

        const sourceName = nameEl.textContent.toLowerCase().trim();
        const countEl = item.querySelector('.metric-source-count');
        if (!countEl) continue;

        const textCount = countEl.textContent.replace(/\D/g, '');
        const count = parseInt(textCount, 10) || 0;

        if (sourceName.includes('scopus')) {
            result.scopusCitations = count;
        } else if (sourceName.includes('mendeley') && !sourceName.includes('reader')) {
            result.mendeleyCitations = count;
        } else if (sourceName.includes('crossref')) {
            result.crossrefCitations = count;
        }
    }

    // ── Capture/Altmetric sources (readers/saves) ──
    const captureSection = document.querySelector('.metric-details-capture');
    if (captureSection) {
        const captureSources = captureSection.querySelectorAll('.metric-source-item');
        for (const item of captureSources) {
            const nameEl = item.querySelector('.metric-source-name');
            if (!nameEl) continue;
            const sourceName = nameEl.textContent.toLowerCase().trim();
            const countEl = item.querySelector('.metric-source-count');
            if (!countEl) continue;
            const count = parseInt(countEl.textContent.replace(/\D/g, ''), 10) || 0;
            if (sourceName.includes('mendeley')) {
                result.mendeleyReaders = count;
            } else if (sourceName.includes('ebsco')) {
                result.ebscoReaders = count;
            }
        }
    }

    return result;
}

/** Extract abstract text from PlumX artifact description (fallback for missing WoS abstract) */
function extractAbstractFallback() {
    const descEl = document.querySelector(
        '.artifact-description-text, .plum-artifact-description, [class*="description-text"]'
    );
    return descEl ? descEl.textContent.trim() : '';
}

async function startScrape() {
    if (!window.location.hash.includes('plumx-task-id=')) return;
    const taskIdRaw = window.location.hash.split('plumx-task-id=')[1].split('&')[0];
    const taskId = parseInt(taskIdRaw, 10);

    chrome.runtime.sendMessage({ type: 'PROGRESS_UPDATE', log: 'PlumX content script waiting for DOM...' });

    // Wait for metric source items
    await waitForElements('.metric-source-item', 15);

    // Human-like post-load delay
    await _humanDelay(300, 800);

    // Check for 403 Forbidden
    if (document.body.textContent.includes('403 Forbidden')) {
        chrome.runtime.sendMessage({
            type: 'SCRAPE_FAIL',
            error: '403 Forbidden: PlumX Rate Limit Exceeded'
        });
        return;
    }

    const metrics = parseAllMetricSources();
    const abstractFallback = extractAbstractFallback();

    chrome.runtime.sendMessage({
        type: 'PROGRESS_UPDATE',
        log: `Scraped PlumX: Scopus=${metrics.scopusCitations}, Mendeley=${metrics.mendeleyCitations}, CrossRef=${metrics.crossrefCitations}, MendeleyReaders=${metrics.mendeleyReaders}, Abstract=${abstractFallback ? 'YES' : 'NO'}`
    });

    // Human-like delay before sending results
    await _humanDelay(200, 600);

    chrome.runtime.sendMessage({
        type: 'PLUMX_DETAIL_COMPLETE',
        taskId,
        data: { ...metrics, abstractFallback }
    });
}

if (document.readyState === 'complete') {
    // Human-like delay before starting
    setTimeout(startScrape, _gaussianRandom(300, 800));
} else {
    window.addEventListener('load', () => {
        setTimeout(startScrape, _gaussianRandom(300, 800));
    });
}

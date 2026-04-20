/**
 * wos_doi_content.js
 * DOI tabanlı WoS Smart-Search enrichment content script.
 *
 * Akış:
 *  1. URL'dan veya storage'dan DOI + taskId alınır
 *  2. Smart-Search input alanına DOI girilir ve sorgu başlatılır
 *  3. Sonuç sayfasında abstract, WoS citation, JCR quartile/IF çekilir
 *  4. Background worker'a WOS_DOI_ENRICH_COMPLETE mesajı gönderilir
 *
 * v1.0 — Anti-bot detection: human-like timing + Gaussian delays
 */

(async function () {
    if (window.__wosDOIWorkerRunning) return;
    window.__wosDOIWorkerRunning = true;

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
    function getText(selector, root = document) {
        return root.querySelector(selector)?.textContent?.trim() || '';
    }
    function parseCount(text) {
        if (!text) return 0;
        const match = text.replace(/,/g, '').match(/\d+/);
        return match ? parseInt(match[0], 10) : 0;
    }

    // ── Task & DOI identification ──
    let taskId = null;
    let doi = null;

    // Attempt from background storage first
    try {
        const info = await chrome.runtime.sendMessage({ type: 'GET_TASK_INFO' });
        if (info && info.taskId) {
            taskId = info.taskId;
            doi = info.externalId || info.doi || null;
        }
    } catch (e) {
        console.warn('[WoS DOI] Cannot get task info from background:', e);
    }

    // Fallback: hash fragment  #wos-doi-task-id=123&doi=10.1234%2Fxyz
    if (!taskId) {
        const hashMatch = window.location.hash.match(/wos-doi-task-id=(\d+)/);
        if (hashMatch) taskId = parseInt(hashMatch[1], 10);
    }
    if (!doi) {
        const doiMatch = window.location.hash.match(/doi=([^&]+)/);
        if (doiMatch) doi = decodeURIComponent(doiMatch[1]);
    }

    if (!taskId || !doi) {
        console.warn('[WoS DOI] Task ID or DOI not found — aborting.');
        return;
    }

    console.log(`[WoS DOI] Task ${taskId} started for DOI: ${doi}`);
    chrome.runtime.sendMessage({ type: 'SCRAPE_READY', source: 'WOS_DOI' });

    // ── Phase 1: Smart-Search input ──

    /** Wait for the Smart-Search input to be available */
    async function waitForSearchInput(timeoutMs = 30000) {
        const deadline = Date.now() + timeoutMs;
        while (Date.now() < deadline) {
            const input = document.querySelector('input#composeQuerySmartSearch, input[data-ta="smart-search-input"]');
            if (input) return input;
            await _humanDelay(400, 800);
        }
        return null;
    }

    /** Submit DOI as a Smart-Search query */
    async function submitDoiSearch(input) {
        // Clear existing content human-like
        input.focus();
        await _humanDelay(200, 500);
        input.value = '';
        input.dispatchEvent(new Event('input', { bubbles: true }));
        await _humanDelay(150, 300);

        // Type DOI char by char (looks more human)
        for (const ch of doi) {
            input.value += ch;
            input.dispatchEvent(new Event('input', { bubbles: true }));
            await _humanDelay(30, 80);
        }

        await _humanDelay(400, 900);

        // Press Enter or click search button
        const searchBtn = document.querySelector(
            'button[data-ta="smart-search-button"], button[aria-label*="Search"], button.search-button'
        );
        if (searchBtn) {
            searchBtn.click();
        } else {
            input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
            input.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', bubbles: true }));
        }

        console.log('[WoS DOI] Search submitted for DOI:', doi);
        chrome.runtime.sendMessage({ type: 'PROGRESS_UPDATE', log: `WoS DOI search submitted: ${doi}` });
    }

    // ── Phase 2: Wait for result page to load ──

    async function waitForResultPage(timeoutMs = 60000) {
        const deadline = Date.now() + timeoutMs;
        while (Date.now() < deadline) {
            // spinner gone
            const spinner = document.querySelector('.spinner-lightbox');
            const spinnerHidden = !spinner ||
                window.getComputedStyle(spinner).visibility === 'hidden' ||
                window.getComputedStyle(spinner).display === 'none';

            // Result record appeared
            const hasRecord = document.querySelector('app-record, .search-results-item, [data-ta="full-record"]');
            if (spinnerHidden && hasRecord) {
                console.log('[WoS DOI] Result page loaded.');
                return true;
            }

            // No-results indicator
            const noResult = document.querySelector('.no-results, [data-ta="no-records"]');
            if (noResult) {
                console.warn('[WoS DOI] No results found for DOI:', doi);
                return false;
            }

            // Check if page displays "Just a moment..." (Cloudflare bot protection)
            const cfBot = document.querySelector('#challenge-running, #cf-spinner, .cf-browser-verification');
            if (cfBot) {
                console.warn('[WoS DOI] Cloudflare bot protection detected.');
                // Wait briefly then continue, let timeout handle it if it doesn't resolve
            }

            await _humanDelay(800, 1500);
        }
        console.warn('[WoS DOI] Timeout waiting for result page');
        return false;
    }

    // ── Phase 3: Click first result to open full record ──

    async function openFirstRecord() {
        const titleLink = document.querySelector(
            'app-record a.title, .summary-record-title a, [data-ta="title-link"], .search-results-item a.title'
        );
        if (!titleLink) {
            // Could be already on full-record page (direct DOI hit)
            const fullRecordAbstract = document.querySelector('[data-ta="FullRTa-abstract-basic"]');
            if (fullRecordAbstract) {
                console.log('[WoS DOI] Already on full-record page.');
                return true;
            }
            console.warn('[WoS DOI] Cannot find title link on results page');
            return false;
        }

        await _humanDelay(600, 1200);
        titleLink.click();
        console.log('[WoS DOI] Clicked first result title link.');
        chrome.runtime.sendMessage({ type: 'PROGRESS_UPDATE', log: 'Opening WoS full record...' });

        // Wait for full-record page
        const deadline = Date.now() + 45000; // Increased timeout for angular
        while (Date.now() < deadline) {
            const spinner = document.querySelector('.spinner-lightbox');
            const spinnerHidden = !spinner ||
                window.getComputedStyle(spinner).visibility === 'hidden' ||
                window.getComputedStyle(spinner).display === 'none';
            const abstract = document.querySelector('[data-ta="FullRTa-abstract-basic"], span[id*="AbstractPart"]');
            if (spinnerHidden && abstract) return true;
            await _humanDelay(800, 1200);
        }
        return false;
    }

    // ── Phase 4: Scrape abstract ──

    function scrapeAbstract() {
        // Primary selector: WoS full-record abstract
        const abstracts = document.querySelectorAll(
            'span[id*="AbstractPart"] p, [data-ta="FullRTa-abstract-basic"] p, #FullRTa-abstract-basic p, .abstract-text p'
        );
        let text = '';
        abstracts.forEach(p => {
            const t = p.textContent.trim();
            if (t && t.length > text.length) text = t;
        });

        if (!text) {
            // Regex fallback if DOM changed
            const body = document.body.innerText || '';
            const abstractMatch = body.match(/Abstract\s*\n\s*([^]{50,1500}?)(?:\n\n|\n[A-Z][a-z]+|\nAuthor Information)/);
            if (abstractMatch) {
                text = abstractMatch[1].trim();
            }
        }
        return text;
    }

    function scrapeAuthors() {
        const authorsList = [];
        document.querySelectorAll('[id^="SumAuthTa-DisplayName-author-en-"], [data-ta^="author-name-"]').forEach(el => {
            const name = el.textContent.trim().replace(/;$/, '');
            if (name && !authorsList.includes(name)) authorsList.push(name);
        });
        return authorsList.join('; ');
    }

    function scrapeFunding() {
        const fundingTexts = [];
        document.querySelectorAll('[data-ta="FullRTa-funding-basic"] p, .funding-text').forEach(el => {
            const t = el.textContent.trim();
            if (t) fundingTexts.push(t);
        });
        return fundingTexts.join('\n');
    }

    function scrapeAddresses() {
        const addressTexts = [];
        document.querySelectorAll('[data-ta="FullRTa-addresses"] .address-row, .address-text').forEach(el => {
            const t = el.textContent.trim();
            if (t) addressTexts.push(t);
        });
        return addressTexts.join(' | ');
    }

    // ── Phase 5: Scrape WoS citation count ──

    function scrapeWosCitations() {
        // "Times Cited" stat block on full-record page
        // Selectors for the citation count under "Times Cited" / "Citations" label
        const statBlocks = document.querySelectorAll('.stat-number, .times-cited-count, [data-ta*="TimesCited"]');
        for (const el of statBlocks) {
            const count = parseCount(el.textContent);
            if (count >= 0) {
                // Verify parent label includes citation hint
                const parent = el.closest('[class*="stat"], [class*="cite"], [class*="citation"]');
                const parentText = (parent?.textContent || '').toLowerCase();
                if (parentText.includes('cited') || parentText.includes('citation') || parentText.includes('times')) {
                    return count;
                }
            }
        }

        // Fallback: look for .stat-number.font-size-24 specifically cited under "Citations" header
        const statNums = document.querySelectorAll('.stat-number.font-size-24');
        for (const el of statNums) {
            const parent = el.closest('[class*="stat"], [class*="cite"]') || el.parentElement;
            const parentText = (parent?.textContent || '').toLowerCase();
            if (parentText.includes('cited') || parentText.includes('citation')) {
                return parseCount(el.textContent);
            }
        }

        // Final fallback: all-text regex
        const bodyText = document.body.innerText || '';
        const m = bodyText.match(/times?\s+cited[^:\d]*:?\s*([\d,]+)/i);
        return m ? parseCount(m[1]) : 0;
    }

    // ── Phase 6: Open JCR sidenav and scrape quartile/IF ──

    async function openJcrAndScrape() {
        const jcrBtn = document.querySelector('[data-ta="jcr-link"], a[href*="jcr"], button[aria-label*="Journal Impact"]');
        if (!jcrBtn) {
            console.log('[WoS DOI] No JCR link found on page — skipping quartile scrape.');
            return { quartile: '', indexType: '', impactFactor: '' };
        }

        await _humanDelay(300, 700);
        jcrBtn.click();
        console.log('[WoS DOI] Clicked JCR sidenav button.');

        // Wait for sidenav
        let sidenav = null;
        for (let i = 0; i < 15; i++) {
            await _humanDelay(300, 600);
            sidenav = document.querySelector('mat-sidenav.jcr-sidenav, app-jcr-sidenav');
            if (sidenav && window.getComputedStyle(sidenav).visibility !== 'hidden') {
                await _humanDelay(400, 800); // Wait for data render
                break;
            }
        }

        if (!sidenav) {
            console.warn('[WoS DOI] JCR sidenav did not open');
            return { quartile: '', indexType: '', impactFactor: '' };
        }

        // Scrape quartile
        const quartile = getText('[data-ta="Sidenav-0-JCR-quartile_0"]', sidenav) ||
            getText('.quartile, [class*="quartile"]', sidenav);

        // Scrape edition/index type
        const edition = (getText('[data-ta="Sidenav-0-JCR-edition_0"]', sidenav) || '')
            .replace(/^in\s+/i, '').trim();

        // Scrape Impact Factor
        let impactFactor = '';
        const ifEl = sidenav.querySelector('.jif-value, [data-ta*="JIF-value"], [data-ta*="impact-factor-value"]');
        if (ifEl) impactFactor = ifEl.textContent.trim();

        // Also check for index type from full-record page (not sidenav)
        const indexTypes = [];
        document.querySelectorAll('[id^="FullRRPTa-edition"]').forEach(el => {
            const t = el.textContent.trim();
            if (t) indexTypes.push(t);
        });
        const indexType = indexTypes.join(', ') || edition;

        console.log(`[WoS DOI] JCR: quartile=${quartile}, indexType=${indexType}, IF=${impactFactor}`);
        return { quartile, indexType, impactFactor };
    }

    // ── MAIN ──

    try {
        await _humanDelay(800, 1800);

        const isSmartSearch = window.location.href.includes('smart-search') ||
            window.location.href.includes('wos/woscc');

        if (isSmartSearch) {
            // Step 1: Submit DOI search
            const input = await waitForSearchInput();
            if (!input) {
                throw new Error('Smart-Search input not found');
            }
            await submitDoiSearch(input);
            await _humanDelay(1500, 3000);

            // Step 2: Wait for results
            const hasResults = await waitForResultPage();

            // Check for explicit "No results found"
            const noResult = document.querySelector('.no-results, [data-ta="no-records"]');
            if (noResult) {
                chrome.runtime.sendMessage({
                    type: 'WOS_DOI_ENRICH_COMPLETE',
                    taskId,
                    doi,
                    error: 'DOI_NOT_FOUND',
                    data: null,
                });
                return;
            }

            if (!hasResults) {
                chrome.runtime.sendMessage({
                    type: 'WOS_DOI_ENRICH_COMPLETE',
                    taskId,
                    doi,
                    error: 'Timeout or CAPTCHA',
                    data: null,
                });
                return;
            }

            // Step 3: Open full record
            await _humanDelay(800, 1500);
            const onRecord = await openFirstRecord();
            if (!onRecord) {
                chrome.runtime.sendMessage({
                    type: 'WOS_DOI_ENRICH_COMPLETE',
                    taskId,
                    doi,
                    error: 'Could not open full record',
                    data: null,
                });
                return;
            }
        }

        // Step 4: Scrape data from full record page
        await _humanDelay(600, 1200);
        const abstract = scrapeAbstract();
        const authors = scrapeAuthors();
        const funding = scrapeFunding();
        const addresses = scrapeAddresses();
        const wosCitations = scrapeWosCitations();
        const { quartile, indexType, impactFactor } = await openJcrAndScrape();

        console.log('[WoS DOI] Scrape complete.', { abstract: abstract.length, authors, wosCitations, quartile, indexType });
        chrome.runtime.sendMessage({ type: 'PROGRESS_UPDATE', log: `WoS DOI enriched: authors=${authors.substring(0, 20)}..., citations=${wosCitations}, quartile=${quartile}` });

        // Step 5: Send result to background
        chrome.runtime.sendMessage({
            type: 'WOS_DOI_ENRICH_COMPLETE',
            taskId,
            doi,
            data: { abstract, authors, funding, addresses, wosCitations, quartile, indexType, impactFactor },
        });

    } catch (err) {
        console.error('[WoS DOI] Error:', err);
        chrome.runtime.sendMessage({
            type: 'WOS_DOI_ENRICH_COMPLETE',
            taskId,
            doi,
            error: err.message,
            data: null,
        });
    }
})();

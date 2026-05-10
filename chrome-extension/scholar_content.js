/**
 * scholar_content.js
 * Scrapes Author Metrics and Publication Citation Counts from Google Scholar profile page.
 * NO detail page visits — only collects h-index, total citations, and per-article citation counts.
 *
 * v1.2 — Metrics + Citations only (no detail scraping)
 */

(async function () {
    // Prevent double execution from manifest + programmatic injection
    if (window.__scholarWorkerRunning) return;
    window.__scholarWorkerRunning = true;

    // Check for Google Scholar robot/captcha detection
    if (document.body.innerText.includes("Please show you're not a robot") ||
        document.title.includes("robot") ||
        document.getElementById("captcha-form")) {
        console.error("[Scholar Content] Bot detection / CAPTCHA detected!");
        chrome.runtime.sendMessage({
            type: "SCHOLAR_CAPTCHA_DETECTED",
            url: window.location.href
        });
        return;
    }

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
        let taskId = null;
        let taskType = 'FULL_SCRAPE';

        try {
            const tabInfo = await chrome.runtime.sendMessage({ type: 'GET_TASK_INFO' });
            if (tabInfo && tabInfo.taskId && tabInfo.source === 'SCHOLAR') {
                taskId = tabInfo.taskId;
                taskType = tabInfo.taskType || 'FULL_SCRAPE';
            }
        } catch (e) {
            console.log('[Scholar] Could not get task info from background:', e);
        }

        if (!taskId) {
            const hash = window.location.hash;
            const match = hash.match(/scholar-task-id=(\d+)/);
            if (match) taskId = parseInt(match[1], 10);
        }

        if (!taskId) return;

        // Detail view sayfasına gelindiyse hiçbir şey yapma — sadece profil sayfası işleniyor
        if (window.location.href.includes('view_op=view_citation')) {
            console.log('[Scholar] Detail view sayfasına gelinmemeli — yoksayılıyor.');
            return;
        }

        console.log(`[Scholar] Started — task ID: ${taskId}, type: ${taskType}`);

        // Handshake
        chrome.runtime.sendMessage({ type: 'SCRAPE_READY', source: 'SCHOLAR' });

        chrome.runtime.sendMessage({
            type: 'PROGRESS_UPDATE',
            log: 'Google Scholar profili yükleniyor...',
        });

        await _humanDelay(1500, 3500);

        // ── Author Metrics ──────────────────────────────────────────────────
        let authorMetrics = { hIndex: 0, sumOfTimesCited: 0, publications: 0, i10Index: 0 };

        const metricsTable = document.getElementById('gsc_rsb_st');
        if (metricsTable) {
            const rows = metricsTable.querySelectorAll('tbody tr');
            if (rows.length >= 1) {
                const citationsCol = rows[0].querySelectorAll('td.gsc_rsb_std');
                if (citationsCol.length > 0) authorMetrics.sumOfTimesCited = parseInt(citationsCol[0].textContent.trim(), 10) || 0;
            }
            if (rows.length >= 2) {
                const hIndexCol = rows[1].querySelectorAll('td.gsc_rsb_std');
                if (hIndexCol.length > 0) authorMetrics.hIndex = parseInt(hIndexCol[0].textContent.trim(), 10) || 0;
            }
            if (rows.length >= 3) {
                const i10Col = rows[2].querySelectorAll('td.gsc_rsb_std');
                if (i10Col.length > 0) authorMetrics.i10Index = parseInt(i10Col[0].textContent.trim(), 10) || 0;
            }
        }

        const authorNameEl = document.getElementById('gsc_prf_in');
        const authorName = authorNameEl ? authorNameEl.textContent.trim() : 'Unknown Google Scholar Author';

        const initialRows = document.querySelectorAll('.gsc_a_tr');
        authorMetrics.publications = initialRows.length;

        // ── Yearly citations histogram ─────────────────────────────────
        // Google Scholar renders a small bar chart on the right ("Citations
        // per year"). Each <a class="gsc_g_a"> bar carries its citation
        // count in <span class="gsc_g_al">N</span>; the year labels live
        // in <span class="gsc_g_t">2024</span> beside them. Both elements
        // are positioned via inline `right:Npx` styles — RTL layout — so
        // the year and bar with the closest `right` value are paired.
        //
        // We open the larger modal first (#gsc_md_hist) to make sure the
        // full year range is in the DOM (the inline strip occasionally
        // truncates older years on narrow viewports), then parse, then
        // close the modal.
        try {
            authorMetrics.yearlyStats = await extractScholarYearlyStats();
            chrome.runtime.sendMessage({
                type: 'PROGRESS_UPDATE',
                log: `Scholar yıllık atıflar: ${authorMetrics.yearlyStats?.length ?? 0} yıl`,
            });
        } catch (e) {
            console.warn('[Scholar] Yearly stats extraction failed:', e?.message || e);
            authorMetrics.yearlyStats = [];
        }

        chrome.runtime.sendMessage({
            type: 'PROGRESS_UPDATE',
            log: `Scholar metrikleri: h-index=${authorMetrics.hIndex}, atıf=${authorMetrics.sumOfTimesCited}`
        });

        // Metrikleri erken gönder
        chrome.runtime.sendMessage({
            type: 'AUTHOR_METRICS_COMPLETE',
            taskId,
            authorMetrics,
            url: window.location.href,
            source: 'SCHOLAR',
        });

        if (taskType === 'METRICS_ONLY') {
            console.log('[Scholar] METRICS_ONLY — tamamlandı.');
            return;
        }

        // ── "Show more" ile tüm yayınları yükle ────────────────────────────
        const showMoreBtn = document.getElementById('gsc_bpf_more');
        const MAX_CLICKS = 30;
        const DEADLINE = Date.now() + 180_000; // 3 dakika
        let clicks = 0;

        while (showMoreBtn && !showMoreBtn.disabled && showMoreBtn.style.display !== 'none'
            && clicks < MAX_CLICKS && Date.now() < DEADLINE) {
            const before = document.querySelectorAll('.gsc_a_tr').length;

            chrome.runtime.sendMessage({
                type: 'PROGRESS_UPDATE',
                action: 'PAGINATING',
                log: `Daha fazla yayın yükleniyor... (${before} adet)`
            });

            showMoreBtn.click();
            clicks++;

            let waited = 0;
            while (document.querySelectorAll('.gsc_a_tr').length === before && waited < 200) {
                await _humanDelay(100, 200);
                waited++;
                if (showMoreBtn.disabled || showMoreBtn.style.display === 'none') break;
            }

            if (clicks % 5 === 0) {
                await _humanDelay(3000, 7000);
            } else if (Math.random() < 0.15) {
                await _humanDelay(1500, 4000);
            }
        }

        // ── Yayın Listesini Çek (sadece başlık + atıf sayısı + yıl) ────────
        const articleRows = document.querySelectorAll('.gsc_a_tr');
        authorMetrics.publications = articleRows.length;

        chrome.runtime.sendMessage({
            type: 'PROGRESS_UPDATE',
            log: `${articleRows.length} yayın bulundu (Scholar).`
        });

        const articles = [];
        articleRows.forEach(row => {
            const titleEl = row.querySelector('.gsc_a_at');
            const grayEls = row.querySelectorAll('.gs_gray');
            const citeEl = row.querySelector('.gsc_a_ac');
            const yearEl = row.querySelector('.gsc_a_h');

            const title = titleEl ? titleEl.textContent.trim() : '';
            if (!title) return;

            const href = titleEl ? titleEl.getAttribute('href') : null;
            const articleUrl = href ? (href.startsWith('http') ? href : `https://scholar.google.com${href}`) : null;

            const authors = grayEls.length > 0 ? grayEls[0].textContent.trim() : '';
            const journal = grayEls.length > 1 ? grayEls[1].textContent.trim() : '';
            const yearText = yearEl ? yearEl.textContent.trim() : '';
            const pubDate = yearText ? `${yearText}-01-01` : '';
            const citeText = citeEl ? citeEl.textContent.trim() : '';
            const citations = citeText ? (parseInt(citeText, 10) || 0) : 0;

            articles.push({
                title,
                authors: [authors],
                journal,
                pubDate,
                citationCountScholar: citations,
                articleUrl: articleUrl,  // URL'yi kaydet ama background.js skipDetailScraping yüzünden GİTMEYECEK
                indexTypes: ['SCHOLAR'],
            });
        });

        // Direkt complete gönder — detail scraping yok
        chrome.runtime.sendMessage({
            type: 'SCRAPE_DETAILS_NEEDED',
            taskId,
            authorData: { authorName, articles },
            source: 'SCHOLAR',
            skipDetailScraping: true,   // background.js'e detail tab açma sinyali
        });

    } catch (error) {
        console.error('[Scholar] SCRAPE_FAIL:', error);
        chrome.runtime.sendMessage({
            type: 'SCRAPE_FAIL',
            error: error.message,
            source: 'SCHOLAR',
        });
    }
})();

/* ════════════════════════════════════════════════════════════════
 *  Yearly histogram extraction
 * ════════════════════════════════════════════════════════════════ */

/**
 * Parses Google Scholar's "Citations per year" histogram and returns a
 * sorted array of {@code [{year, citations}]}.
 *
 * Inline panel layout (always present on the right sidebar):
 *   <div class="gsc_g_hist_wrp" dir="rtl">
 *     ...
 *     <div class="gsc_md_hist_w">
 *       <div class="gsc_md_hist_b">
 *         <span class="gsc_g_t" style="right:483px">2011</span>  ... 16 of these
 *         <a class="gsc_g_a"  style="right:488px;...">
 *           <span class="gsc_g_al">5</span>
 *         </a>                                                  ... 16 of these
 *       </div>
 *     </div>
 *   </div>
 *
 * Year labels and bars are siblings; pairing is by closest `right`
 * inline-style. The same template is reused inside #gsc_md_hist (the
 * "Yıllık alıntı sayısı" modal) and contains identical data, so we
 * only fall back to opening that modal if the sidebar copy is missing.
 *
 * Returns an empty array on failure; downstream callers treat that as
 * "no per-year data".
 */
async function extractScholarYearlyStats() {
    // ── Step 1. Wait for the histogram to actually render. ──────────────
    // Scholar populates this asynchronously, often a second or two after
    // the rest of the sidebar. A fixed delay used to drop the data on
    // slow loads — poll until both year-labels and bar-counts are in the
    // DOM (not just the container element).
    const INLINE_SEL = '.gsc_g_hist_wrp:not(#gsc_md_hist *) .gsc_md_hist_b';
    let root = null;
    for (let attempt = 0; attempt < 30; attempt++) { // up to ~12s
        const candidate = document.querySelector(INLINE_SEL);
        if (candidate) {
            const yearCount = candidate.querySelectorAll('.gsc_g_t').length;
            const barCount  = candidate.querySelectorAll('a.gsc_g_a .gsc_g_al').length;
            if (yearCount > 0 && barCount > 0) {
                root = candidate;
                console.log(
                    `[Scholar] Histogram ready after ${attempt} polls ` +
                    `(${yearCount} years, ${barCount} bars)`);
                break;
            }
        }
        await _humanDelay(350, 500);
    }

    // ── Step 2. Modal fallback. ─────────────────────────────────────────
    // Older / narrow viewports can hide the inline strip. Click a sidebar
    // bar to pop the "Yıllık alıntı sayısı" modal, then read from there.
    let openedModal = false;
    if (!root) {
        const inlineBars = document.querySelectorAll(
            '.gsc_g_hist_wrp:not(#gsc_md_hist *) a.gsc_g_a');
        if (inlineBars.length > 0) {
            try { inlineBars[0].click(); openedModal = true; } catch (_) { /* ignore */ }
            for (let i = 0; i < 20; i++) {
                await _humanDelay(150, 250);
                const modal = document.querySelector('#gsc_md_hist.gs_vis')
                           || document.querySelector('#gsc_md_hist[style*="top"]');
                if (modal) {
                    const cand = modal.querySelector('.gsc_md_hist_b');
                    if (cand && cand.querySelectorAll('a.gsc_g_a .gsc_g_al').length > 0) {
                        root = cand;
                        console.log('[Scholar] Histogram read from modal fallback');
                        break;
                    }
                }
            }
        }
    }

    if (!root) {
        console.warn('[Scholar] Yearly histogram not found (inline polling + modal both failed)');
        // Diagnostic: log what we DID see.
        const wrappers = document.querySelectorAll('.gsc_g_hist_wrp');
        const bars     = document.querySelectorAll('a.gsc_g_a');
        console.warn(
            `[Scholar] DOM snapshot: .gsc_g_hist_wrp=${wrappers.length}, ` +
            `a.gsc_g_a=${bars.length}`);
        return [];
    }

    // ── Step 3. Parse years and their `right` offsets. ──────────────────
    const yearEls = Array.from(root.querySelectorAll('.gsc_g_t'));
    const years = yearEls.map(s => ({
        right: parseFloat(s.style && s.style.right) || 0,
        year:  parseInt((s.textContent || '').trim(), 10),
    })).filter(y => Number.isFinite(y.year) && y.year >= 1900 && y.year <= 2100);

    // ── Step 4. Pair each bar with the nearest year by `right` distance.
    // Scholar renders bars at year_right + ~5px, but the offset is not
    // strictly fixed across viewports — nearest-match is the safer rule.
    const barEls = Array.from(root.querySelectorAll('a.gsc_g_a'));
    const stats = [];
    for (const b of barEls) {
        const right = parseFloat(b.style && b.style.right) || 0;
        const labelEl = b.querySelector('.gsc_g_al');
        const cit = parseInt((labelEl?.textContent || '').trim(), 10);
        if (!Number.isFinite(cit)) continue;

        let bestYear = null, bestDx = Infinity;
        for (const y of years) {
            const dx = Math.abs(right - y.right);
            if (dx < bestDx) { bestDx = dx; bestYear = y.year; }
        }
        if (bestYear != null) stats.push({ year: bestYear, citations: cit });
    }

    // ── Step 5. Close the modal if we opened it. Leave the page untouched
    //    when we read from the inline panel.
    if (openedModal) {
        const closeBtn = document.querySelector('#gsc_md_hist-x');
        if (closeBtn) { try { closeBtn.click(); } catch (_) { /* ignore */ } }
    }

    // De-dup by year (defense; should already be unique) and sort.
    const byYear = new Map();
    for (const s of stats) {
        if (!byYear.has(s.year)) byYear.set(s.year, s);
    }
    const result = Array.from(byYear.values()).sort((a, b) => a.year - b.year);
    const total = result.reduce((s, y) => s + y.citations, 0);
    console.log(
        `[Scholar] Extracted ${result.length} yearly entries, Σcitations=${total}`,
        result);
    return result;
}

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

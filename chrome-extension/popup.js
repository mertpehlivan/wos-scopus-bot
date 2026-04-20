// ═══════════════════════════════════════════════════════════════
//  RDLSIS Bot — Popup Script v2
//  Gösterir: kim için ne çekti, canlı task'lar, istatistikler
// ═══════════════════════════════════════════════════════════════

document.addEventListener('DOMContentLoaded', () => {

    // ── State ────────────────────────────────────────────────────
    let enrichmentHistory = []; // Max 50 kayıt
    let cumulativeStats = {
        wosDone: 0, scholarDone: 0, plumxDone: 0, errors: 0,
        abstracts: 0, wosCit: 0, schCit: 0, quartiles: 0, mendeley: 0,
    };
    let activeTasks = {}; // taskId → { source, doi, startTime }

    // ── DOM Refs ─────────────────────────────────────────────────
    const statusPill = document.getElementById('status-pill');
    const statusDot = document.getElementById('status-dot');
    const statusText = document.getElementById('status-text');
    const activityStrip = document.getElementById('activity-strip');
    const feedList = document.getElementById('feed-list');
    const taskRows = document.getElementById('task-rows');

    // Stats
    const st = {
        wosDone: document.getElementById('st-wos-done'),
        schDone: document.getElementById('st-sch-done'),
        plumxDone: document.getElementById('st-plumx-done'),
        errors: document.getElementById('st-errors'),
        abstracts: document.getElementById('st-abstracts'),
        wosCit: document.getElementById('st-wos-cit'),
        schCit: document.getElementById('st-sch-cit'),
        quartiles: document.getElementById('st-quartiles'),
        mendeley: document.getElementById('st-mendeley'),
        activeTabs: document.getElementById('st-active-tabs'),
        progLabel: document.getElementById('prog-label'),
        progCount: document.getElementById('prog-count'),
        progFill: document.getElementById('prog-fill'),
    };

    // ── Tab routing ──────────────────────────────────────────────
    document.querySelectorAll('.tab-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
            document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
            btn.classList.add('active');
            document.getElementById('tab-' + btn.dataset.tab).classList.add('active');
        });
    });

    // ── Clear feed button ────────────────────────────────────────
    document.getElementById('btn-clear-feed').addEventListener('click', () => {
        enrichmentHistory = [];
        renderFeed();
    });

    // ── API Key ──────────────────────────────────────────────────
    const apiKeyInput = document.getElementById('api-key-input');
    const apiKeyStatus = document.getElementById('api-key-status');
    chrome.storage.local.get(['brokerApiKey'], r => { if (r.brokerApiKey) apiKeyInput.value = r.brokerApiKey; });
    document.getElementById('api-key-save').addEventListener('click', () => {
        const key = apiKeyInput.value.trim();
        if (!key) return;
        chrome.storage.local.set({ brokerApiKey: key }, () => {
            apiKeyStatus.textContent = '✓ Kaydedildi';
            setTimeout(() => { apiKeyStatus.textContent = ''; }, 2200);
        });
    });

    // ── Diagnostics ──────────────────────────────────────────────
    document.getElementById('btn-diagnostics').addEventListener('click', () => {
        chrome.tabs.create({ url: chrome.runtime.getURL('diagnostics.html') });
    });

    // ── Force poll (manual trigger) ──────────────────────────────
    document.getElementById('btn-force-poll').addEventListener('click', () => {
        chrome.runtime.sendMessage({ type: 'FORCE_POLL' });
    });

    // ─────────────────────────────────────────────────────────────
    //  INITIALIZE — fetch state + history from background
    // ─────────────────────────────────────────────────────────────
    chrome.runtime.sendMessage({ type: 'GET_DASHBOARD_STATE' }, (response) => {
        if (response) applyDashboardState(response);
    });

    chrome.runtime.sendMessage({ type: 'GET_ENRICHMENT_HISTORY' }, (response) => {
        if (response && Array.isArray(response.history)) {
            enrichmentHistory = response.history;
            renderFeed();
        }
        if (response && response.stats) {
            mergeStats(response.stats);
            renderStats();
        }
    });

    // ─────────────────────────────────────────────────────────────
    //  LIVE MESSAGES from background
    // ─────────────────────────────────────────────────────────────
    chrome.runtime.onMessage.addListener((msg) => {
        switch (msg.type) {
            case 'STATE_UPDATE':
                applyDashboardState(msg.state);
                break;

            case 'ENRICHMENT_RESULT':
                // Tek bir tamamlanan task sonucu
                pushEnrichmentResult(msg.result);
                break;

            case 'TASK_STARTED':
                activeTasks[msg.taskId] = { source: msg.source, doi: msg.doi, startTime: Date.now() };
                renderActivityStrip();
                renderTaskTable();
                break;

            case 'TASK_ENDED':
                delete activeTasks[msg.taskId];
                renderActivityStrip();
                renderTaskTable();
                break;
        }
    });

    // ─────────────────────────────────────────────────────────────
    //  applyDashboardState — mevcut background state'ini UI'ye yaz
    // ─────────────────────────────────────────────────────────────
    function applyDashboardState(state) {
        if (!state) return;

        // Status pill
        const s = state.status || 'IDLE';
        const cls = {
            IDLE: '', PAGINATING: 'active', SCRAPING_DETAILS: 'active',
            INITIALIZING: 'active', COMPLETING: 'active',
            ERROR: 'error', TIMEOUT: 'warn'
        }[s] || '';
        statusPill.className = 'status-pill ' + cls;
        const labels = {
            IDLE: 'IDLE', PAGINATING: 'TARANIYOR', SCRAPING_DETAILS: 'ÇEKİLİYOR',
            INITIALIZING: 'BAŞLATILIYOR', COMPLETING: 'KAYDEDİLİYOR',
            ERROR: 'HATA', TIMEOUT: 'ZAMAN AŞIMI'
        };
        statusText.textContent = labels[s] || s;

        // Active tabs from state
        const tabs = state.activeTabs || {};
        if (typeof tabs === 'object') {
            // Merge into activeTasks
            Object.entries(tabs).forEach(([id, info]) => {
                if (!activeTasks[id]) activeTasks[id] = info;
            });
        }

        // Stats
        if (state.stats) {
            st.activeTabs.textContent = state.stats.activeTabs ?? 0;
            // Progress
            const p = state.progress || {};
            if (p.total > 0) {
                st.progLabel.textContent = p.label || 'İlerleme';
                st.progCount.textContent = `${p.current} / ${p.total}`;
                st.progFill.style.width = Math.min(100, Math.round(p.current / p.total * 100)) + '%';
            }
        }

        renderActivityStrip();
        renderTaskTable();
    }

    // ─────────────────────────────────────────────────────────────
    //  pushEnrichmentResult — yeni sonucu feed'e ekle
    // ─────────────────────────────────────────────────────────────
    function pushEnrichmentResult(result) {
        if (!result) return;
        enrichmentHistory.unshift({ ...result, time: Date.now() });
        if (enrichmentHistory.length > 50) enrichmentHistory.pop();

        // Cumulative stats
        const src = (result.source || '').toUpperCase();
        if (src === 'WOS') cumulativeStats.wosDone++;
        else if (src === 'SCHOLAR') cumulativeStats.scholarDone++;
        else if (src === 'PLUMX') cumulativeStats.plumxDone++;
        if (result.failed) cumulativeStats.errors++;

        if (result.hasAbstract) cumulativeStats.abstracts++;
        if (result.wosCitCount > 0) cumulativeStats.wosCit += result.wosCitCount;
        if (result.schCitCount > 0) cumulativeStats.schCit += result.schCitCount;
        if (result.quartile) cumulativeStats.quartiles++;
        if (result.mendeleyReaders > 0) cumulativeStats.mendeley += result.mendeleyReaders;

        renderFeed();
        renderStats();
    }

    // ─────────────────────────────────────────────────────────────
    //  renderFeed — Akış tab'ı
    // ─────────────────────────────────────────────────────────────
    function renderFeed() {
        feedList.innerHTML = '';
        if (enrichmentHistory.length === 0) {
            feedList.innerHTML = '<div class="feed-empty">Henüz sonuç yok. DOI enrichment taskları tamamlandığında burada görünecek.</div>';
            return;
        }

        enrichmentHistory.forEach(item => {
            const card = document.createElement('div');
            const srcKey = (item.source || 'WOS').toLowerCase().replace('_', '');
            card.className = `feed-card src-${srcKey}`;

            // Zaman
            const t = new Date(item.time || Date.now());
            const timeStr = `${pad(t.getHours())}:${pad(t.getMinutes())}:${pad(t.getSeconds())}`;

            // Kaynak ikonu
            const srcIcons = { wos: '🔬', scholar: '🎓', plumx: '📊', scopus: '🔭' };
            const srcIcon = srcIcons[srcKey] || '📡';
            const srcLabel = { wos: 'Web of Science', scholar: 'Google Scholar', plumx: 'PlumX', scopus: 'Scopus' }[srcKey] || item.source;

            // Badges
            const badges = buildBadges(item);

            card.innerHTML = `
        <div class="fcard-header">
          <div class="fcard-source">
            <div class="src-icon">${srcIcon}</div>
            ${srcLabel}
          </div>
          <span class="fcard-time">${timeStr}</span>
        </div>
        <div class="fcard-doi" title="${item.doi || ''}">${item.doi || '—'}</div>
        <div class="fcard-badges">${badges}</div>
      `;

            feedList.appendChild(card);
        });
    }

    function buildBadges(item) {
        let html = '';
        if (item.failed) {
            return `<span class="badge badge-none">❌ Başarısız${item.error ? ' — ' + item.error.substring(0, 30) : ''}</span>`;
        }
        if (item.hasAbstract) {
            const len = item.abstractLength ? ` (${item.abstractLength}k)` : '';
            html += `<span class="badge badge-abstract">📄 Abstract${len}</span>`;
        }
        if (item.wosCitCount > 0) {
            html += `<span class="badge badge-wos-cit">📖 WoS: ${item.wosCitCount} atıf</span>`;
        }
        if (item.schCitCount > 0) {
            html += `<span class="badge badge-sch-cit">🎓 Scholar: ${item.schCitCount} atıf</span>`;
        }
        if (item.quartile) {
            html += `<span class="badge badge-quartile">📊 ${item.quartile}</span>`;
        }
        if (item.impactFactor) {
            html += `<span class="badge badge-if">🏅 IF: ${item.impactFactor}</span>`;
        }
        if (item.mendeleyReaders > 0) {
            html += `<span class="badge badge-mendeley">📌 Mendeley: ${item.mendeleyReaders}</span>`;
        }
        if (!html) {
            html = '<span class="badge badge-none">Veri bulunamadı</span>';
        }
        return html;
    }

    // ─────────────────────────────────────────────────────────────
    //  renderStats — İstatistik tab'ı
    // ─────────────────────────────────────────────────────────────
    function renderStats() {
        st.wosDone.textContent = cumulativeStats.wosDone;
        st.schDone.textContent = cumulativeStats.scholarDone;
        st.plumxDone.textContent = cumulativeStats.plumxDone;
        st.errors.textContent = cumulativeStats.errors;
        st.abstracts.textContent = cumulativeStats.abstracts;
        st.wosCit.textContent = cumulativeStats.wosCit;
        st.schCit.textContent = cumulativeStats.schCit;
        st.quartiles.textContent = cumulativeStats.quartiles;
        st.mendeley.textContent = cumulativeStats.mendeley;
    }

    function mergeStats(s) {
        if (!s) return;
        Object.keys(s).forEach(k => {
            if (cumulativeStats.hasOwnProperty(k)) cumulativeStats[k] = s[k];
        });
    }

    // ─────────────────────────────────────────────────────────────
    //  renderActivityStrip — canlı tab chip'leri
    // ─────────────────────────────────────────────────────────────
    function renderActivityStrip() {
        activityStrip.innerHTML = '';
        const entries = Object.entries(activeTasks);
        if (entries.length === 0) {
            activityStrip.innerHTML = '<div class="activity-empty">Henüz aktif görev yok</div>';
            return;
        }

        entries.forEach(([id, info]) => {
            const chip = document.createElement('div');
            const src = (info.source || 'WOS').toUpperCase();
            chip.className = `task-chip src-${src}`;
            const doi = info.doi ? truncate(info.doi, 18) : `#${id}`;
            const srcIcons = { WOS: '🔬', SCHOLAR: '🎓', PLUMX: '📊' };
            chip.innerHTML = `<span class="chip-dot"></span>${srcIcons[src] || '📡'} ${doi}`;
            activityStrip.appendChild(chip);
        });
    }

    // ─────────────────────────────────────────────────────────────
    //  renderTaskTable — Görevler tab'ı
    // ─────────────────────────────────────────────────────────────
    function renderTaskTable() {
        taskRows.innerHTML = '';
        const entries = Object.entries(activeTasks);
        if (entries.length === 0) {
            taskRows.innerHTML = '<div class="task-empty">Şu an aktif görev yok</div>';
            return;
        }

        entries.forEach(([id, info]) => {
            const row = document.createElement('div');
            const src = (info.source || 'WOS').toUpperCase();
            row.className = `task-row tr-src-${src.toLowerCase()}`;
            const elapsed = info.startTime ? Math.round((Date.now() - info.startTime) / 1000) + 's' : '—';
            const doi = info.doi ? truncate(info.doi, 22) : `Task #${id}`;
            const srcIcons = { WOS: '🔬', SCHOLAR: '🎓', PLUMX: '📊' };

            row.innerHTML = `
        <div class="tr-source"><span class="tr-source-dot"></span>${srcIcons[src] || '📡'} ${src}</div>
        <div class="tr-doi" title="${info.doi || ''}">${doi}</div>
        <div class="tr-status status-processing">İŞLENİYOR</div>
        <div class="tr-time">${elapsed}</div>
      `;
            taskRows.appendChild(row);
        });

        // Elapsed time güncelle her saniye
        if (entries.length > 0 && !taskRows._timer) {
            taskRows._timer = setInterval(() => {
                if (Object.keys(activeTasks).length === 0) {
                    clearInterval(taskRows._timer);
                    taskRows._timer = null;
                    return;
                }
                renderTaskTable();
            }, 1000);
        }
    }

    // ─────────────────────────────────────────────────────────────
    //  Utilities
    // ─────────────────────────────────────────────────────────────
    function pad(n) { return String(n).padStart(2, '0'); }
    function truncate(s, n) { return s.length > n ? s.slice(0, n) + '…' : s; }

    // Version from manifest
    const manifest = chrome.runtime.getManifest();
    const vEl = document.getElementById('ext-version');
    if (vEl && manifest.version) vEl.textContent = 'v' + manifest.version;

    // Periyodik yenileme (her 3s)
    setInterval(() => {
        chrome.runtime.sendMessage({ type: 'GET_DASHBOARD_STATE' }, (response) => {
            if (response) applyDashboardState(response);
        });
    }, 3000);
});

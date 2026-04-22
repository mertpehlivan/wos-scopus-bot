// ═══════════════════════════════════════════════════════════════
//  RDLSIS Bot — Popup Script v3
//  Dashboard: Overview, Tasks, Logs, Settings
// ═══════════════════════════════════════════════════════════════

document.addEventListener('DOMContentLoaded', () => {

  // ── State ────────────────────────────────────────────────────
  let enrichmentHistory = [];
  let cumulativeStats = {
    wosDone: 0, scholarDone: 0, plumxDone: 0, errors: 0,
    abstracts: 0, wosCit: 0, schCit: 0, quartiles: 0, mendeley: 0,
  };
  let activeTasks = {};
  let logs = [];
  let currentState = null;

  // ── DOM Refs ─────────────────────────────────────────────────
  const statusPill = document.getElementById('status-pill');
  const statusText = document.getElementById('status-text');
  const activityStrip = document.getElementById('activity-strip');
  const taskRows = document.getElementById('task-rows');
  const logList = document.getElementById('log-list');

  // Overview refs
  const activeTaskBox = document.getElementById('active-task-box');
  const atSource = document.getElementById('at-source');
  const atId = document.getElementById('at-id');
  const atTarget = document.getElementById('at-target');
  const progLabel = document.getElementById('prog-label');
  const progCount = document.getElementById('prog-count');
  const progFill = document.getElementById('prog-fill');

  // Sync progress refs
  const syncSteps = {
    WOS: document.getElementById('step-wos'),
    SCOPUS: document.getElementById('step-scopus'),
    SCHOLAR: document.getElementById('step-scholar'),
  };

  // Stats refs
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

  // ── Clear logs button ────────────────────────────────────────
  document.getElementById('btn-clear-logs').addEventListener('click', () => {
    logs = [];
    renderLogs();
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

  // ── Force poll ───────────────────────────────────────────────
  document.getElementById('btn-force-poll').addEventListener('click', () => {
    chrome.runtime.sendMessage({ type: 'FORCE_POLL' });
  });

  // ── Clear history ────────────────────────────────────────────
  document.getElementById('btn-clear-history').addEventListener('click', () => {
    if (!confirm('TÜM state, log, task geçmişi ve açık sekmeler sıfırlanacak. Emin misiniz?')) return;
    chrome.runtime.sendMessage({ type: 'RESET_ALL' }, () => {
      enrichmentHistory = [];
      cumulativeStats = { wosDone: 0, scholarDone: 0, plumxDone: 0, errors: 0, abstracts: 0, wosCit: 0, schCit: 0, quartiles: 0, mendeley: 0 };
      activeTasks = {};
      logs = [];
      renderStats();
      renderActivityStrip();
      renderTaskTable();
      renderLogs();
      // Refresh state from background
      chrome.runtime.sendMessage({ type: 'GET_DASHBOARD_STATE' }, (response) => {
        if (response) applyDashboardState(response);
      });
    });
  });

  // ── Initial fetch ────────────────────────────────────────────
  chrome.runtime.sendMessage({ type: 'GET_DASHBOARD_STATE' }, (response) => {
    if (response) applyDashboardState(response);
  });
  chrome.runtime.sendMessage({ type: 'GET_ENRICHMENT_HISTORY' }, (response) => {
    if (response && Array.isArray(response.history)) {
      enrichmentHistory = response.history;
    }
    if (response && response.stats) {
      mergeStats(response.stats);
    }
    renderStats();
  });

  // ── Live Messages ────────────────────────────────────────────
  chrome.runtime.onMessage.addListener((msg) => {
    switch (msg.type) {
      case 'STATE_UPDATE':
        applyDashboardState(msg.state);
        break;
      case 'ENRICHMENT_RESULT':
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
      case 'LOG_ENTRY':
        if (msg.log) pushLog(msg.log);
        break;
    }
  });

  // ── applyDashboardState ──────────────────────────────────────
  function applyDashboardState(state) {
    if (!state) return;
    currentState = state;

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

    // Merge active tabs
    const tabs = state.activeTabs || {};
    if (typeof tabs === 'object') {
      Object.entries(tabs).forEach(([id, info]) => {
        if (!activeTasks[id]) activeTasks[id] = { ...info, startTime: info.startTime || Date.now() };
      });
    }

    // Stats
    if (state.stats) {
      st.activeTabs.textContent = `${state.stats.activeTabs ?? 0} / ${state.stats.detailPoolSize ?? 1}`;
      const p = state.progress || {};
      if (p.total > 0) {
        progLabel.textContent = p.label || 'İlerleme';
        progCount.textContent = `${p.current} / ${p.total}`;
        progFill.style.width = Math.min(100, Math.round(p.current / p.total * 100)) + '%';
      } else {
        progLabel.textContent = 'Bekleniyor';
        progCount.textContent = '—';
        progFill.style.width = '0%';
      }
    }

    // Logs from state
    if (state.logs && Array.isArray(state.logs)) {
      logs = [...state.logs];
      renderLogs();
    }

    // Active task box
    const profileTask = state.taskId ? { taskId: state.taskId, source: state.activeSources > 0 ? 'ÇALIŞIYOR' : '—', targetId: state.targetId } : null;
    if (profileTask && s !== 'IDLE') {
      activeTaskBox.style.display = '';
      atSource.textContent = (state.status || 'IDLE').replace(/_/g, ' ');
      atId.textContent = `#${profileTask.taskId}`;
      atTarget.textContent = profileTask.targetId || '—';
    } else {
      activeTaskBox.style.display = 'none';
    }

    // Sync progress
    if (state.syncProgress) {
      renderSyncProgress(state.syncProgress);
    }

    renderActivityStrip();
    renderTaskTable();
  }

  // ── pushEnrichmentResult ─────────────────────────────────────
  function pushEnrichmentResult(result) {
    if (!result) return;
    enrichmentHistory.unshift({ ...result, time: Date.now() });
    if (enrichmentHistory.length > 50) enrichmentHistory.pop();

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

    renderStats();
  }

  // ── pushLog ──────────────────────────────────────────────────
  function pushLog(log) {
    logs.push(log);
    if (logs.length > 100) logs = logs.slice(-100);
    renderLogs();
  }

  // ── renderLogs ───────────────────────────────────────────────
  function renderLogs() {
    logList.innerHTML = '';
    if (logs.length === 0) {
      logList.innerHTML = '<div class="log-empty">Henüz log kaydı yok.</div>';
      return;
    }
    [...logs].reverse().forEach(item => {
      const el = document.createElement('div');
      el.className = `log-item ${item.type || 'info'}`;
      const t = new Date(item.time || Date.now());
      const timeStr = `${pad(t.getHours())}:${pad(t.getMinutes())}:${pad(t.getSeconds())}`;
      el.innerHTML = `<span class="log-time">${timeStr}</span><span class="log-text">${escHtml(item.text)}</span>`;
      logList.appendChild(el);
    });
  }

  // ── renderStats ──────────────────────────────────────────────
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

  function renderSyncProgress(sp) {
    const labels = { PENDING: 'Bekliyor', RUNNING: 'Çalışıyor', COMPLETED: 'Tamamlandı', FAILED: 'Hata' };
    Object.entries(sp).forEach(([src, status]) => {
      const el = syncSteps[src];
      if (!el) return;
      el.classList.remove('active', 'completed', 'failed');
      const statusEl = el.querySelector('.step-status');
      if (status === 'RUNNING') {
        el.classList.add('active');
        statusEl.textContent = labels.RUNNING;
      } else if (status === 'COMPLETED') {
        el.classList.add('completed');
        statusEl.textContent = labels.COMPLETED;
      } else if (status === 'FAILED') {
        el.classList.add('failed');
        statusEl.textContent = labels.FAILED;
      } else {
        statusEl.textContent = labels.PENDING;
      }
    });
  }

  function mergeStats(s) {
    if (!s) return;
    Object.keys(s).forEach(k => {
      if (cumulativeStats.hasOwnProperty(k)) cumulativeStats[k] = s[k];
    });
  }

  // ── renderActivityStrip ──────────────────────────────────────
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
      const doi = info.doi ? truncate(info.doi, 16) : `#${id}`;
      const srcIcons = { WOS: '🔬', SCHOLAR: '🎓', PLUMX: '📊', SCOPUS: '🔭' };
      chip.innerHTML = `<span class="chip-dot"></span>${srcIcons[src] || '📡'} ${doi}`;
      activityStrip.appendChild(chip);
    });
  }

  // ── renderTaskTable ──────────────────────────────────────────
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
      const doi = info.doi ? truncate(info.doi, 20) : `Task #${id}`;
      const srcIcons = { WOS: '🔬', SCHOLAR: '🎓', PLUMX: '📊', SCOPUS: '🔭' };

      row.innerHTML = `
        <div class="tr-source"><span class="tr-source-dot"></span>${srcIcons[src] || '📡'} ${src}</div>
        <div class="tr-doi" title="${info.doi || ''}">${doi}</div>
        <div class="tr-status status-processing">İŞLENİYOR</div>
        <div class="tr-time">${elapsed}</div>
      `;
      taskRows.appendChild(row);
    });

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

  // ── Utilities ────────────────────────────────────────────────
  function pad(n) { return String(n).padStart(2, '0'); }
  function truncate(s, n) { return s && s.length > n ? s.slice(0, n) + '…' : (s || ''); }
  function escHtml(str) {
    if (!str) return '';
    return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  // Version from manifest
  const manifest = chrome.runtime.getManifest();
  const vEl = document.getElementById('ext-version');
  if (vEl && manifest.version) vEl.textContent = 'v' + manifest.version;

  // Periodic refresh (every 3s)
  setInterval(() => {
    chrome.runtime.sendMessage({ type: 'GET_DASHBOARD_STATE' }, (response) => {
      if (response) applyDashboardState(response);
    });
  }, 3000);
});

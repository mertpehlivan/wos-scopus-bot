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
  let groupConfig = { wos: true, scopusPlumx: true, scholar: true };

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

  // Group toggle refs
  const toggleWos = document.getElementById('toggle-wos');
  const toggleScopusPlumx = document.getElementById('toggle-scopus-plumx');
  const toggleScholar = document.getElementById('toggle-scholar');

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

  // ── WoS login credentials (R6: no longer in the source) ──────
  // The saved password is never read back into the form; an empty password
  // field on save keeps the stored one (so only the e-mail can be changed).
  const wosEmailInput = document.getElementById('wos-email-input');
  const wosPasswordInput = document.getElementById('wos-password-input');
  const wosCredsStatus = document.getElementById('wos-creds-status');
  function showWosCredsState(creds) {
    const ok = !!(creds && creds.email && creds.password);
    wosPasswordInput.placeholder = ok ? '•••••••• (kayıtlı — değiştirmek için yazın)' : 'Şifre';
    wosCredsStatus.textContent = ok ? '✓ Kayıtlı' : '⚠ Tanımlı değil — WoS otomatik giriş yapamaz';
    wosCredsStatus.style.color = ok ? '' : '#f59e0b';
  }
  chrome.storage.local.get(['wosCredentials'], r => {
    if (r.wosCredentials?.email) wosEmailInput.value = r.wosCredentials.email;
    showWosCredsState(r.wosCredentials);
  });
  document.getElementById('wos-creds-save').addEventListener('click', () => {
    const email = wosEmailInput.value.trim();
    const password = wosPasswordInput.value;
    chrome.storage.local.get(['wosCredentials'], r => {
      const next = { email, password: password || r.wosCredentials?.password || '' };
      if (!next.email || !next.password) {
        wosCredsStatus.textContent = 'E-posta ve şifre gerekli';
        wosCredsStatus.style.color = '#f59e0b';
        return;
      }
      chrome.storage.local.set({ wosCredentials: next }, () => {
        wosPasswordInput.value = '';
        showWosCredsState(next);
        wosCredsStatus.textContent = '✓ Kaydedildi';
      });
    });
  });

  // ── Diagnostics ──────────────────────────────────────────────
  document.getElementById('btn-diagnostics').addEventListener('click', () => {
    chrome.tabs.create({ url: chrome.runtime.getURL('diagnostics.html') });
  });

  // ── Force poll ───────────────────────────────────────────────
  // ── Safe reset (R3) ─────────────────────────────────────────
  const safeResetBtn = document.getElementById('btn-safe-reset');
  safeResetBtn.addEventListener('click', () => {
    const ok = confirm(
      'Güvenli sıfırlama:\n\n'
      + '• Açık bot sekmeleri kapatılır\n'
      + '• Yarım kalan görevler "operatör sıfırladı" sebebiyle sunucuya bildirilir (sessizce kaybolmaz)\n'
      + '• Kuyruk birkaç saniye içinde yeniden başlar\n\n'
      + 'Devam edilsin mi?');
    if (!ok) return;
    safeResetBtn.disabled = true;
    safeResetBtn.textContent = '⏳ Sıfırlanıyor…';
    chrome.runtime.sendMessage({ type: 'SAFE_RESET' }, (resp) => {
      safeResetBtn.disabled = false;
      safeResetBtn.textContent = '🛟 Güvenli sıfırla';
      if (resp && resp.ok === false) alert('Sıfırlama hatası: ' + (resp.error || 'bilinmiyor'));
    });
  });

  document.getElementById('btn-force-poll').addEventListener('click', () => {
    chrome.runtime.sendMessage({ type: 'FORCE_POLL' });
  });

  // ── Group Toggles ────────────────────────────────────────────
  function loadGroupConfig() {
    chrome.storage.local.get(['groupConfig'], (r) => {
      if (r.groupConfig) {
        groupConfig = r.groupConfig;
        toggleWos.checked = groupConfig.wos !== false;
        toggleScopusPlumx.checked = groupConfig.scopusPlumx !== false;
        toggleScholar.checked = groupConfig.scholar !== false;
      }
    });
  }
  loadGroupConfig();

  function saveGroupConfig() {
    groupConfig = {
      wos: toggleWos.checked,
      scopusPlumx: toggleScopusPlumx.checked,
      scholar: toggleScholar.checked,
    };
    chrome.storage.local.set({ groupConfig }, () => {
      // Notify background immediately
      chrome.runtime.sendMessage({ type: 'GROUP_CONFIG_CHANGED', config: groupConfig });
    });
  }

  toggleWos.addEventListener('change', saveGroupConfig);
  toggleScopusPlumx.addEventListener('change', saveGroupConfig);
  toggleScholar.addEventListener('change', saveGroupConfig);

  // ── Clear history (Extension only) ───────────────────────────
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

  // ── Reset Backend ────────────────────────────────────────────
  document.getElementById('btn-reset-backend').addEventListener('click', async () => {
    if (!confirm('⚠️ DİKKAT: Backend\'deki TÜM task\'lar ve extension state tamamen silinecek. Bu işlem geri alınamaz! Emin misiniz?')) return;
    if (!confirm('Son teyit: GERÇEKTEN tüm veriyi silmek istiyor musunuz?')) return;

    try {
      const stored = await chrome.storage.local.get(['brokerApiKey']);
      const apiKey = stored.brokerApiKey || 'change-me-in-production';
      const apiBase = 'https://operator.rawdatalibrary.net'; // Same as background.js

      // 1. Reset backend
      const resp = await fetch(`${apiBase}/api/tasks/reset-all?confirm=RESET_EVERYTHING`, {
        method: 'DELETE',
        headers: { 'X-Api-Key': apiKey, 'Content-Type': 'application/json' }
      });
      let backendResult = {};
      if (resp.ok) {
        backendResult = await resp.json();
      } else {
        console.warn('[Popup] Backend reset failed:', resp.status);
      }

      // 2. Reset extension state
      chrome.runtime.sendMessage({ type: 'RESET_ALL' }, () => {
        enrichmentHistory = [];
        cumulativeStats = { wosDone: 0, scholarDone: 0, plumxDone: 0, errors: 0, abstracts: 0, wosCit: 0, schCit: 0, quartiles: 0, mendeley: 0 };
        activeTasks = {};
        logs = [];
        renderStats();
        renderActivityStrip();
        renderTaskTable();
        renderLogs();
        alert(`✅ Sıfırlama tamamlandı.\nBackend: ${backendResult.deleted || 0} kayıt silindi.`);
        chrome.runtime.sendMessage({ type: 'GET_DASHBOARD_STATE' }, (response) => {
          if (response) applyDashboardState(response);
        });
      });
    } catch (err) {
      alert('❌ Sıfırlama hatası: ' + err.message);
    }
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

    renderStatusLine(state);
    renderAlerts(state.workerAlerts || []);

    renderActivityStrip();
    renderTaskTable();
  }

  // ── One-line status (R3) ─────────────────────────────────────
  const statusLine = document.getElementById('status-line');
  const alertList = document.getElementById('alert-list');
  const SOURCE_NAMES = { WOS: 'WoS', SCOPUS: 'Scopus', SCHOLAR: 'Scholar', OPENALEX: 'OpenAlex' };
  const PHASE_NAMES = {
    INITIALIZING: 'sayfa açılıyor', PAGINATING: 'profil taranıyor', SCRAPING_DETAILS: 'detaylar',
    COMPLETING: 'kaydediliyor', TIMEOUT: 'zaman aşımı', ERROR: 'hata',
  };

  function fmtMin(ms) {
    const m = Math.round(ms / 60000);
    return m < 1 ? '<1 dk' : `${m} dk`;
  }

  function renderStatusLine(state) {
    const s = state.status || 'IDLE';
    if (s === 'IDLE' || !state.taskId) {
      statusLine.textContent = 'Bekleniyor — aktif görev yok';
      statusLine.className = 'status-line';
      return;
    }
    const parts = [SOURCE_NAMES[state.currentSource] || state.currentSource || 'Görev'];
    parts.push(PHASE_NAMES[s] || s.toLowerCase());
    const p = state.progress || {};
    if (s === 'SCRAPING_DETAILS' && p.total > 0) {
      parts[1] = `detay ${p.current}/${p.total}`;
      if (state.detailStartedAt && p.current > 0 && p.current < p.total) {
        const perItem = (Date.now() - state.detailStartedAt) / p.current;
        parts.push(`~${fmtMin(perItem * (p.total - p.current))} kaldı`);
      }
    }
    parts.push(`#${state.taskId}`);
    statusLine.textContent = parts.join(' · ');
    statusLine.className = 'status-line active';
  }

  const ALERT_TEXT = {
    WORKER_WINDOW_HIDDEN: '⚠ Worker penceresi gizli/küçültülmüş — Chrome sayfaları yavaşlatıyor. Pencereyi görünür bırakın.',
    WOS_SESSION_UNVERIFIED: '⚠ WoS oturumu doğrulanamadı — ön-kontrol 10 dk duraklatıldı. Bu Chrome\'da WoS\'a giriş yapılı olduğunu kontrol edin.',
    WOS_CREDENTIALS_MISSING: '⚠ WoS giriş bilgileri tanımlı değil — Ayarlar sekmesinden e-posta ve şifreyi girin; oturum düşerse otomatik giriş yapılamaz.',
  };

  function renderAlerts(codes) {
    alertList.innerHTML = '';
    for (const c of codes) {
      const div = document.createElement('div');
      div.className = 'alert-item';
      div.textContent = ALERT_TEXT[c] || c;
      alertList.appendChild(div);
    }
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

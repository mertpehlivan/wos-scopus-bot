/**
 * background.js
 * Service worker: polling, tab lifecycle, API complete/fail.
 * Makale detay sayfaları sıralı olarak açılır, index türü ve diğer bilgiler çekilir.
 *
 * v1.1 — Anti-bot detection + Source-based parallel scraping + Adaptive pooling
 */

const API_BASE = 'http://localhost:8081';

// ═══════════════════════════════════════════════
//  STEALTH UTILITIES (inline for service worker context)
// ═══════════════════════════════════════════════

function gaussianRandom(min, max) {
  let u = 0, v = 0;
  while (u === 0) u = Math.random();
  while (v === 0) v = Math.random();
  let num = Math.sqrt(-2.0 * Math.log(u)) * Math.cos(2.0 * Math.PI * v);
  const mean = (min + max) / 2;
  const std = (max - min) / 6;
  num = num * std + mean;
  return Math.max(min, Math.min(max, Math.round(num)));
}

function humanDelay(min = 500, max = 2000) {
  return new Promise(resolve => setTimeout(resolve, gaussianRandom(min, max)));
}

function randomInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function randomWindowSize() {
  const widths = [1280, 1366, 1440, 1536, 1600, 1920];
  const heights = [720, 768, 800, 900, 1024, 1080];
  const baseW = widths[Math.floor(Math.random() * widths.length)];
  const baseH = heights[Math.floor(Math.random() * heights.length)];
  return { width: baseW + randomInt(-50, 50), height: baseH + randomInt(-30, 30) };
}

function jitteredInterval(baseMs, jitterPercent = 30) {
  const jitter = baseMs * (jitterPercent / 100);
  return baseMs + randomInt(-jitter, jitter);
}

// ═══════════════════════════════════════════════
//  CONFIGURATION — Adaptive & Anti-detection aware
// ═══════════════════════════════════════════════

// Global profile task slot: only ONE profile scrape (WOS/SCOPUS/SCHOLAR) at a time
let activeProfileTask = null; // { taskId, source, externalId, taskType }

// Dashboard sync progress tracking (WOS → SCOPUS → SCHOLAR)
let syncProgress = {
  WOS: 'PENDING',
  SCOPUS: 'PENDING',
  SCHOLAR: 'PENDING',
};

function updateSyncProgress(source, status) {
  const src = source?.toUpperCase();
  if (syncProgress[src] !== undefined) {
    syncProgress[src] = status;
  }
}

// ── DOI Enrichment tab pools (separate from profile scraping) ──
const pendingWosDoiTabs = new Map();     // tabId → { taskId, doi }
const pendingScholarDoiTabs = new Map(); // tabId → { taskId, doi }
let wosDoiPoolSize = 1;     // Conservative: 1 at a time
let scholarDoiPoolSize = 1; // Strict: 1 at a time

// Handshake: Pre-ready timeout (90s) — if SCRAPE_READY not received, fail gracefully
const PRE_READY_TIMEOUT_MS = 90_000;
const SCRAPE_TIMEOUT_MS = 600_000; // 10 minutes after SCRAPE_READY (extended on progress)

// Active scrape timeout trackers (tabId → timeoutId)
const scrapeTimeouts = new Map();

// Adaptive detail tab pool
let detailPoolSize = 1;          // Conservative: 1 at a time
const DETAIL_POOL_MIN = 1;
const DETAIL_POOL_MAX = 2;
let detailRateLimited = false;
let detailBackoffUntil = 0;

// Adaptive PlumX tab pool
let plumxPoolSize = 1;      // Conservative: 1 at a time
const PLUMX_POOL_MIN = 1;
const PLUMX_POOL_MAX = 2;
let plumxRateLimited = false;
let plumxBackoffUntil = 0;

// Polling intervals (adaptive)
const POLL_INTERVAL_IDLE_MS = 30000;       // 30s when idle
const POLL_INTERVAL_ACTIVE_MS = 8000;      // 8s when tasks are active (conservative)
const POLL_INTERVAL_RATE_LIMITED_MS = 120000; // 120s when rate limited
let currentPollMode = 'idle'; // 'idle' | 'active' | 'rate_limited'

const pendingTabs = new Map(); // authorTabId → { taskId, source, taskType }
const pendingPlumx = new Map(); // plumxTabId → { taskId, doi }

// Detay scraping durumu: taskId → { authorData, articles, pendingUrls, results, authorTabId }
const detailJobs = new Map();

// ═══════════════════════════════════════════════
//  GLOBAL DASHBOARD STATE
// ═══════════════════════════════════════════════

let appState = {
  status: 'IDLE',
  taskId: null,
  targetId: null,
  progress: { current: 0, total: 0, label: 'Waiting...' },
  stats: { pagesScanned: 0, articlesFound: 0, detailsExtracted: 0 },
  activeTabs: {}, // Stores taskId -> { source, doi, startTime }
  logs: []
};

// ═══════════════════════════════════════════════
//  DIAGNOSTICS HISTORY — per-task scraping data
// ═══════════════════════════════════════════════

let diagHistory = {
  tasks: [],        // { taskId, source, taskType, startedAt, completedAt, status, articles, metrics, error, externalId }
  plumxResults: [], // { taskId, doi, scopusCitations, mendeleyCitations, crossrefCitations, timestamp }
};
const DIAG_MAX_TASKS = 10;
const DIAG_MAX_PLUMX = 200;

let enrichmentHistory = [];
let cumulativeStats = {
  wosDone: 0, scholarDone: 0, plumxDone: 0, errors: 0,
  abstracts: 0, wosCit: 0, schCit: 0, quartiles: 0, mendeley: 0,
};

function pushEnrichmentResult(source, doi, data, error) {
  const failed = !!error;
  const result = {
    source, doi, failed, error,
    hasAbstract: !!data?.abstract,
    abstractLength: data?.abstract ? Math.round(data.abstract.length / 1000) : 0,
    wosCitCount: data?.wosCitations || 0,
    schCitCount: data?.scholarCitations || 0,
    quartile: data?.quartile || '',
    impactFactor: data?.impactFactor || '',
    mendeleyReaders: data?.mendeleyCitations || 0
  };

  enrichmentHistory.unshift({ ...result, time: Date.now() });
  if (enrichmentHistory.length > 50) enrichmentHistory.pop();

  if (source === 'WOS') cumulativeStats.wosDone++;
  else if (source === 'SCHOLAR') cumulativeStats.scholarDone++;
  else if (source === 'PLUMX') cumulativeStats.plumxDone++;

  if (failed) cumulativeStats.errors++;
  if (result.hasAbstract) cumulativeStats.abstracts++;
  if (result.wosCitCount > 0) cumulativeStats.wosCit += result.wosCitCount;
  if (result.schCitCount > 0) cumulativeStats.schCit += result.schCitCount;
  if (result.quartile) cumulativeStats.quartiles++;
  if (result.mendeleyReaders > 0) cumulativeStats.mendeley += result.mendeleyReaders;

  chrome.runtime.sendMessage({ type: 'ENRICHMENT_RESULT', result }).catch(() => null);
}

function broadcastTaskStarted(taskId, source, doi) {
  appState.activeTabs = appState.activeTabs || {};
  appState.activeTabs[taskId] = { source, doi, startTime: Date.now() };
  chrome.runtime.sendMessage({ type: 'TASK_STARTED', taskId, source, doi }).catch(() => null);
  updateState();
}

function broadcastTaskEnded(taskId) {
  if (appState.activeTabs && appState.activeTabs[taskId]) {
    delete appState.activeTabs[taskId];
    chrome.runtime.sendMessage({ type: 'TASK_ENDED', taskId }).catch(() => null);
    updateState();
  }
}

function diagAddTask(taskId, source, externalId, taskType) {
  // Remove duplicate if exists
  diagHistory.tasks = diagHistory.tasks.filter(t => t.taskId !== taskId);
  diagHistory.tasks.unshift({
    taskId, source, taskType,
    externalId: externalId || null,
    startedAt: new Date().toISOString(),
    completedAt: null,
    status: 'RUNNING',
    articles: [],
    metrics: null,
    error: null,
  });
  if (diagHistory.tasks.length > DIAG_MAX_TASKS) diagHistory.tasks.pop();
}

function diagGetTask(taskId) {
  return diagHistory.tasks.find(t => t.taskId === taskId) || null;
}

function diagAddPlumx(taskId, doi, data) {
  diagHistory.plumxResults.unshift({
    taskId, doi,
    scopusCitations: data.scopusCitations || 0,
    mendeleyCitations: data.mendeleyCitations || 0,
    crossrefCitations: data.crossrefCitations || 0,
    timestamp: new Date().toISOString(),
  });
  if (diagHistory.plumxResults.length > DIAG_MAX_PLUMX) diagHistory.plumxResults.pop();
}

function updateState(updates = {}) {
  appState = { ...appState, ...updates };

  let totalActiveTabs = 0;
  for (const job of detailJobs.values()) {
    if (job.activeTabIds) totalActiveTabs += job.activeTabIds.size;
  }
  // Count active profile source
  let activeSourceCount = activeProfileTask !== null ? 1 : 0;

  appState.stats = {
    ...appState.stats,
    activeTabs: totalActiveTabs,
    activeSources: activeSourceCount,
    detailPoolSize,
    plumxPoolSize,
  };
  appState.syncProgress = { ...syncProgress };

  chrome.runtime.sendMessage({ type: 'STATE_UPDATE', state: appState }).catch(() => null);
}

function addLog(text, type = 'info') {
  appState.logs.push({ text, type, time: Date.now() });
  if (appState.logs.length > 30) appState.logs.shift();
  updateState();
}

// ═══════════════════════════════════════════════
//  API KEY & HEADERS
// ═══════════════════════════════════════════════

async function getApiKey() {
  const stored = await chrome.storage.local.get(['brokerApiKey']);
  return stored.brokerApiKey || 'change-me-in-production';
}

async function brokerHeaders(extra = {}) {
  const key = await getApiKey();
  return { 'Content-Type': 'application/json', 'X-Api-Key': key, ...extra };
}

// ═══════════════════════════════════════════════
//  ADAPTIVE POLLING SYSTEM
// ═══════════════════════════════════════════════

// ═══════════════════════════════════════════════
//  ADAPTIVE POLLING SYSTEM - STRICT PRIORITY
// ═══════════════════════════════════════════════

let pollAlarmName = 'poll-master-orchestrator';

function scheduleOrchestrator(delayMs) {
  chrome.alarms.create(pollAlarmName, { when: Date.now() + delayMs });
}

chrome.runtime.onInstalled.addListener(() => {
  scheduleOrchestrator(2000); // Start after 2s
});

async function runPriorityOrchestrator() {
  if (detailRateLimited || plumxRateLimited) {
    scheduleOrchestrator(jitteredInterval(30000, 20));
    return;
  }

  // Count active tasks for Phase 1 (Yayın Bulma / Detay Doldurma)
  let activeAuthorTasks = activeProfileTask !== null ? 1 : 0;
  let activeDetailJobs = detailJobs.size;

  // PRIORITY 1: YAYIN BULMA VE DETAY ÇEKME (WOS/SCOPUS/SCHOLAR Author Scrapes + Detail Extraction)
  const hasEmptyProfileSlot = activeProfileTask === null;
  if (hasEmptyProfileSlot) {
    const pickedAuthorTask = await pollScrape();
    if (pickedAuthorTask) {
      scheduleOrchestrator(jitteredInterval(POLL_INTERVAL_ACTIVE_MS, 30));
      return;
    }
  }

  // Do not start Phase 2 or 3 until Phase 1 is idle to enforce "bulma/doldurma önce, atıf sonra"
  if (activeAuthorTasks > 0 || activeDetailJobs > 0) {
    scheduleOrchestrator(jitteredInterval(POLL_INTERVAL_ACTIVE_MS, 30));
    return;
  }

  // PRIORITY 2: WOS DOI ENRICHMENT (Özet / Q Değeri / IF Doldurma)
  const activeWosDoi = pendingWosDoiTabs.size;
  if (activeWosDoi < wosDoiPoolSize) {
    const pickedWosDoi = await pollWosDoi();
    if (pickedWosDoi) {
      scheduleOrchestrator(jitteredInterval(10000, 20));
      return;
    }
  }

  if (activeWosDoi > 0) {
    scheduleOrchestrator(jitteredInterval(10000, 20));
    return;
  }

  // PRIORITY 3: PLUMX & SCHOLAR DOI (Atıfları Bulma)
  const activeScholar = pendingScholarDoiTabs.size;
  const activePlumx = pendingPlumx.size;
  let pickedCitationTask = false;

  if (activeScholar < scholarDoiPoolSize) {
    if (await pollScholarDoi()) pickedCitationTask = true;
  }

  if (activePlumx < plumxPoolSize) {
    if (await pollPlumx()) pickedCitationTask = true;
  }

  if (pickedCitationTask || activeScholar > 0 || activePlumx > 0) {
    // Much slower polling for Citations to prevent Google Scholar IP bans
    scheduleOrchestrator(jitteredInterval(25000, 25));
    return;
  }

  // System is idle
  scheduleOrchestrator(jitteredInterval(POLL_INTERVAL_IDLE_MS, 20));
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === pollAlarmName) {
    runPriorityOrchestrator().catch(err => {
      console.warn("[Orchestrator]", err);
      scheduleOrchestrator(15000);
    });
  }
});

// ═══════════════════════════════════════════════
//  PROGRAMMATIC INJECTION (Scopus & Scholar)
// ═══════════════════════════════════════════════

const injectedScopusTabs = new Set();
chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (changeInfo.status !== 'complete') return;
  const entry = pendingTabs.get(tabId);
  if (!entry || entry.source !== 'SCOPUS') return;
  if (injectedScopusTabs.has(tabId)) return;
  injectedScopusTabs.add(tabId);
  setTimeout(() => injectedScopusTabs.delete(tabId), 300000);
  try {
    await chrome.scripting.executeScript({ target: { tabId }, files: ['scopus_content.js'] });
  } catch (err) {
    console.warn('[WoS Worker] Failed to inject scopus_content.js:', err);
  }
});

const injectedScholarTabs = new Set();
chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (changeInfo.status !== 'complete') return;
  const entry = pendingTabs.get(tabId);
  if (!entry || entry.source !== 'SCHOLAR') return;
  if (injectedScholarTabs.has(tabId)) return;
  injectedScholarTabs.add(tabId);
  setTimeout(() => injectedScholarTabs.delete(tabId), 300000);
  try {
    await chrome.scripting.executeScript({ target: { tabId }, files: ['scholar_content.js'] });
  } catch (err) {
    console.warn('[WoS Worker] Failed to inject scholar_content.js:', err);
  }
});

// ═══════════════════════════════════════════════
//  SOURCE-BASED PARALLEL POLL
// ═══════════════════════════════════════════════

async function pollScrape() {
  // Only one profile task at a time (serial across WOS/SCOPUS/SCHOLAR)
  if (activeProfileTask !== null) {
    return false;
  }

  const sources = ['WOS', 'SCOPUS', 'SCHOLAR'];

  try {
    const headers = await brokerHeaders();

    for (const src of sources) {
      const res = await fetch(`${API_BASE}/api/tasks/poll?source=${src}`, { headers });
      if (res.status === 204 || !res.ok) continue;

      const data = await res.json();
      if (data?.taskId) {
        const { taskId, externalId, source, redirectUrl, taskType } = data;
        const effectiveSource = source || src;

        if (taskId != null && externalId) {
          console.log(`[WoS Worker] New ${effectiveSource} task. ID: ${taskId}, ExtID: ${externalId}, Type: ${taskType || 'FULL_SCRAPE'}`);

          activeProfileTask = {
            taskId,
            source: effectiveSource,
            externalId,
            taskType: taskType || 'FULL_SCRAPE'
          };

          updateSyncProgress(effectiveSource, 'RUNNING');

          // Track in diagnostics
          diagAddTask(taskId, effectiveSource, externalId, taskType || 'FULL_SCRAPE');

          updateState({
            status: 'INITIALIZING',
            taskId,
            targetId: externalId,
            progress: { current: 0, total: 0, label: `Initializing ${effectiveSource} task...` },
            stats: { pagesScanned: 0, articlesFound: 0, detailsExtracted: 0 }
          });
          addLog(`New ${effectiveSource} Task (ID: ${taskId}, Type: ${taskType || 'FULL_SCRAPE'})`, 'success');

          await humanDelay(800, 2500);
          await openTaskTab(taskId, externalId, effectiveSource, redirectUrl || null, taskType || 'FULL_SCRAPE');
          return true;
        }
      }
    }
    return false;
  } catch (err) {
    if (appState.status !== 'IDLE') {
      console.warn('[WoS Worker] Scrape poll failed:', err);
    }
    return false;
  }
}

// ═══════════════════════════════════════════════
//  PLUMX POLLING — Adaptive batch
// ═══════════════════════════════════════════════

async function pollPlumx() {
  // Check rate limit backoff
  if (plumxRateLimited && Date.now() < plumxBackoffUntil) {
    console.log(`[PlumX Worker] Rate limited, backing off for ${Math.round((plumxBackoffUntil - Date.now()) / 1000)}s`);
    return false;
  }
  if (plumxRateLimited && Date.now() >= plumxBackoffUntil) {
    plumxRateLimited = false;
    // Gradually restore pool size
    plumxPoolSize = Math.min(plumxPoolSize + 1, PLUMX_POOL_MAX);
    addLog(`PlumX rate limit lifted, pool size → ${plumxPoolSize}`, 'info');
  }

  const activePlumx = pendingPlumx.size;
  const slotsAvailable = plumxPoolSize - activePlumx;
  if (slotsAvailable <= 0) return false;

  try {
    const headers = await brokerHeaders();
    const res = await fetch(`${API_BASE}/api/plumx-tasks/poll?batchSize=${slotsAvailable}`, { headers });
    if (res.status === 204 || !res.ok) return false;

    const tasks = await res.json();
    if (!Array.isArray(tasks) || tasks.length === 0) return false;

    console.log(`[PlumX Worker] Received ${tasks.length} PlumX task(s)`);
    addLog(`PlumX: Opening ${tasks.length} DOI tab(s)`, 'info');

    for (let i = 0; i < tasks.length; i++) {
      const { taskId, externalId } = tasks[i];
      if (taskId != null && externalId) {
        // Human-like delay between PlumX tab openings
        if (i > 0) await humanDelay(2000, 5000);
        await openPlumxTab(taskId, externalId);
      }
    }
    return true;
  } catch (err) {
    console.warn('[PlumX Worker] PlumX poll failed:', err);
    return false;
  }
}

async function openPlumxTab(taskId, doi) {
  const url = `https://plu.mx/plum/a/?doi=${encodeURIComponent(doi)}&theme=plum-sciencedirect-theme&hideUsage=true#plumx-task-id=${taskId}`;
  try {
    const tab = await chrome.tabs.create({ url, active: false });
    pendingPlumx.set(tab.id, { taskId, doi });
    console.log(`[PlumX Worker] Opened PlumX tab #${tab.id} for DOI: ${doi}`);
    broadcastTaskStarted(taskId, 'PLUMX', doi);
  } catch (e) {
    console.warn('[PlumX Worker] Failed to open PlumX tab:', e);
    try {
      const h = await brokerHeaders();
      await fetch(`${API_BASE}/api/plumx-tasks/${taskId}/fail`, { method: 'POST', headers: h });
    } catch (_) { }
  }
}

// ═══════════════════════════════════════════════
//  TAB MANAGEMENT — Anti-detection aware
// ═══════════════════════════════════════════════

async function openTaskTab(taskId, externalId, source, redirectUrl, taskType) {
  let url = '';

  let hashStr = `task-id=${taskId}`;
  if (source === 'WOS') hashStr = `wos-task-id=${taskId}`;
  else if (source === 'SCOPUS') hashStr = `scopus-task-id=${taskId}`;
  else if (source === 'SCHOLAR') hashStr = `scholar-task-id=${taskId}`;
  else if (source === 'PLUMX') hashStr = `plumx-task-id=${taskId}`;

  if (redirectUrl) {
    const sep = redirectUrl.includes('#') ? '&' : '#';
    url = `${redirectUrl}${sep}${hashStr}`;
  } else if (source === 'SCOPUS') {
    url = `https://www.scopus.com/authid/detail.uri?authorId=${encodeURIComponent(externalId)}#scopus-task-id=${taskId}`;
  } else if (source === 'PLUMX') {
    url = `https://plu.mx/plum/a/?doi=${encodeURIComponent(externalId)}&theme=plum-sciencedirect-theme&hideUsage=true#plumx-task-id=${taskId}`;
  } else if (source === 'SCHOLAR') {
    url = `https://scholar.google.com/citations?user=${encodeURIComponent(externalId)}&hl=tr#scholar-task-id=${taskId}`;
  } else {
    const baseUrl = `https://www.webofscience.com/wos/author/record/${encodeURIComponent(externalId)}`;
    url = `${baseUrl}#wos-task-id=${taskId}`;
  }

  // Always open as ACTIVE tab so the content script can navigate properly
  const tab = await chrome.tabs.create({
    url,
    active: true,
  });

  const tabId = tab.id;
  await chrome.storage.session.set({ [tabId]: { taskId, externalId, source, taskType: taskType || 'FULL_SCRAPE' } });

  pendingTabs.set(tabId, { taskId, source, taskType: taskType || 'FULL_SCRAPE', openedAt: Date.now(), readyAt: null });
  addLog(`Opened ${source} tab (focused, ${taskType || 'FULL_SCRAPE'})`, 'info');

  // Pre-ready timeout: if SCRAPE_READY is not received within 60s, fail gracefully
  setTimeout(async () => {
    const entry = pendingTabs.get(tabId);
    if (entry && !entry.readyAt) {
      console.warn(`[WoS Worker] Tab #${tabId} never sent SCRAPE_READY within ${PRE_READY_TIMEOUT_MS / 1000}s. Failing task.`);
      addLog(`${source} tab never became ready — marking as NOT_FOUND`, 'warning');
      try {
        const h = await brokerHeaders();
        await fetch(`${API_BASE}/api/tasks/${entry.taskId}/fail`, {
          method: 'POST', headers: h,
          body: JSON.stringify({ error: 'Content script never loaded (pre-ready timeout)' }),
        });
      } catch (_) { }
      clearPendingTab(tabId);
      try { await chrome.tabs.remove(tabId); } catch (_) { }
    }
  }, PRE_READY_TIMEOUT_MS);
}

function clearPendingTab(tabId) {
  const entry = pendingTabs.get(tabId);
  if (entry) {
    // Free the global profile task slot
    if (activeProfileTask && activeProfileTask.taskId === entry.taskId) {
      activeProfileTask = null;
    }
    pendingTabs.delete(tabId);
  }
  // Clear scrape timeout if exists
  if (scrapeTimeouts.has(tabId)) {
    clearTimeout(scrapeTimeouts.get(tabId));
    scrapeTimeouts.delete(tabId);
  }
  chrome.storage.session.remove(String(tabId));
}

function markSourceComplete(source, failed = false) {
  updateSyncProgress(source, failed ? 'FAILED' : 'COMPLETED');
}

async function handleTaskTimeout(tabId) {
  const entry = pendingTabs.get(tabId);
  if (!entry) return;
  const { taskId } = entry;

  console.error(`[WoS Worker] Task ID: ${taskId} zaman aşımı.`);
  addLog(`Task timed out after ${SCRAPE_TIMEOUT_MS/60000} min of inactivity`, 'error');
  updateState({ status: 'TIMEOUT' });
  scrapeTimeouts.delete(tabId);
  clearPendingTab(tabId);

  for (const [jTaskId, job] of detailJobs.entries()) {
    if (jTaskId === taskId) {
      if (job.activeTabIds) {
        job.activeTabIds.forEach(dtId => {
          try { chrome.tabs.remove(dtId); } catch (_) { }
        });
      }
      detailJobs.delete(jTaskId);
    }
  }

  try {
    const h = await brokerHeaders();
    await fetch(`${API_BASE}/api/tasks/${taskId}/fail`, {
      method: 'POST', headers: h,
      body: JSON.stringify({ error: 'Timeout' }),
    });
  } catch (e) { }

  try { await chrome.tabs.remove(tabId); } catch (_) { }
}

// ═══════════════════════════════════════════════
//  EXTENSION ICON CLICK -> OPEN FULL PAGE UI
// ═══════════════════════════════════════════════
chrome.action.onClicked.addListener((tab) => {
  const dashboardUrl = chrome.runtime.getURL('popup.html');
  chrome.tabs.query({}, (tabs) => {
    const existingTab = tabs.find(t => t.url === dashboardUrl);
    if (existingTab) {
      chrome.tabs.update(existingTab.id, { active: true });
      chrome.windows.update(existingTab.windowId, { focused: true });
    } else {
      chrome.tabs.create({ url: dashboardUrl });
    }
  });
});

// ═══════════════════════════════════════════════
//  MESSAGE ROUTER
// ═══════════════════════════════════════════════

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'GET_DASHBOARD_STATE') {
    sendResponse(appState);
    return true;
  }

  if (msg.type === 'GET_ENRICHMENT_HISTORY') {
    sendResponse({ history: enrichmentHistory, stats: cumulativeStats });
    return true;
  }

  if (msg.type === 'FORCE_POLL') {
    pollScrape();
    pollWosDoi();
    pollScholarDoi();
    pollPlumx();
    sendResponse({ ok: true });
    return true;
  }

  if (msg.type === 'GET_DIAG_DATA') {
    sendResponse(diagHistory);
    return true;
  }

  if (msg.type === 'CLEAR_DIAG_DATA') {
    diagHistory = { tasks: [], plumxResults: [] };
    sendResponse({ ok: true });
    return true;
  }


  // ── RESET EVERYTHING ──
  if (msg.type === 'RESET_ALL') {
    (async () => {
      addLog('Resetting all state...', 'warning');

      // Close all profile tabs
      for (const [tabId] of pendingTabs) {
        try { await chrome.tabs.remove(tabId); } catch (_) { }
      }
      pendingTabs.clear();
      activeProfileTask = null;

      // Close all detail tabs
      for (const [taskId, job] of detailJobs) {
        if (job.activeTabIds) {
          for (const dtId of job.activeTabIds) {
            try { await chrome.tabs.remove(dtId); } catch (_) { }
          }
        }
      }
      detailJobs.clear();

      // Close all PlumX tabs
      for (const [tabId] of pendingPlumx) {
        try { await chrome.tabs.remove(tabId); } catch (_) { }
      }
      pendingPlumx.clear();

      // Close all WoS DOI tabs
      for (const [tabId] of pendingWosDoiTabs) {
        try { await chrome.tabs.remove(tabId); } catch (_) { }
      }
      pendingWosDoiTabs.clear();

      // Close all Scholar DOI tabs
      for (const [tabId] of pendingScholarDoiTabs) {
        try { await chrome.tabs.remove(tabId); } catch (_) { }
      }
      pendingScholarDoiTabs.clear();

      // Close all Citation Report tabs
      for (const [tabId] of pendingCitationReportTabs) {
        try { await chrome.tabs.remove(tabId); } catch (_) { }
      }
      pendingCitationReportTabs.clear();
      savedCitationReportLinks.clear();

      // Reset state
      appState = {
        status: 'IDLE',
        taskId: null,
        targetId: null,
        progress: { current: 0, total: 0, label: 'Waiting...' },
        stats: { pagesScanned: 0, articlesFound: 0, detailsExtracted: 0 },
        activeTabs: {},
        logs: [],
        syncProgress: { WOS: 'PENDING', SCOPUS: 'PENDING', SCHOLAR: 'PENDING' }
      };
      syncProgress = { WOS: 'PENDING', SCOPUS: 'PENDING', SCHOLAR: 'PENDING' };
      diagHistory = { tasks: [], plumxResults: [] };
      enrichmentHistory = [];
      cumulativeStats = {
        wosDone: 0, scholarDone: 0, plumxDone: 0, errors: 0,
        abstracts: 0, wosCit: 0, schCit: 0, quartiles: 0, mendeley: 0,
      };

      // Reset adaptive pools
      detailPoolSize = 1;
      plumxPoolSize = 1;
      wosDoiPoolSize = 1;
      detailRateLimited = false;
      plumxRateLimited = false;
      detailBackoffUntil = 0;
      plumxBackoffUntil = 0;

      await chrome.storage.session.clear();
      addLog('All state reset complete.', 'success');
      updateState();
    })();
    sendResponse({ ok: true });
    return true;
  }

  // ── Handshake: Content script signals it is ready ──
  if (msg.type === 'SCRAPE_READY') {
    const tabId = sender.tab?.id;
    if (tabId != null) {
      const entry = pendingTabs.get(tabId);
      if (entry && !entry.readyAt) {
        entry.readyAt = Date.now();
        console.log(`[WoS Worker] SCRAPE_READY received from tab #${tabId} (${msg.source || entry.source}). Timeout countdown starts now.`);
        addLog(`${msg.source || entry.source} content script ready`, 'success');

        // Start the real scrape timeout now
        setTimeout(() => {
          const current = pendingTabs.get(tabId);
          if (current && current.taskId === entry.taskId) {
            handleTaskTimeout(tabId);
          }
        }, SCRAPE_TIMEOUT_MS);
      }
    }
    sendResponse({ ok: true });
    return true;
  }

  if (msg.type === 'PROGRESS_UPDATE') {
    const tabId = sender.tab?.id;
    // Extend scrape timeout on any progress (prevent false timeout on long scrapes)
    if (tabId != null && scrapeTimeouts.has(tabId)) {
      clearTimeout(scrapeTimeouts.get(tabId));
      const entry = pendingTabs.get(tabId);
      if (entry) {
        const newTimeout = setTimeout(() => {
          const current = pendingTabs.get(tabId);
          if (current && current.taskId === entry.taskId) {
            handleTaskTimeout(tabId);
          }
        }, SCRAPE_TIMEOUT_MS);
        scrapeTimeouts.set(tabId, newTimeout);
      }
    }
    if (msg.stats) {
      updateState({ stats: { ...appState.stats, ...msg.stats } });
    }
    if (msg.log) {
      addLog(msg.log, 'info');
    }
    if (msg.action === 'PAGINATING') {
      updateState({ status: 'PAGINATING' });
    }
    sendResponse({ ok: true });
    return true;
  }

  if (msg.type === 'GET_TASK_INFO') {
    const tabId = sender.tab?.id;
    if (tabId == null) { sendResponse({}); return false; }
    chrome.storage.session.get([String(tabId)]).then(stored => {
      sendResponse(stored[String(tabId)] || {});
    });
    return true;
  }

  if (msg.type === 'AUTHOR_METRICS_COMPLETE') {
    handleAuthorMetrics(msg).then(sendResponse);
    return true;
  }

  if (msg.type === 'SCRAPE_DETAILS_NEEDED') {
    handleDetailsNeeded(sender.tab?.id, msg).then(sendResponse);
    return true;
  }

  if (msg.type === 'ARTICLE_DETAIL_COMPLETE') {
    handleArticleDetailComplete(sender.tab?.id, msg).then(sendResponse);
    return true;
  }

  if (msg.type === 'PLUMX_DETAIL_COMPLETE') {
    handlePlumxDetailComplete(sender.tab?.id, msg).then(sendResponse);
    return true;
  }

  if (msg.type === 'SCRAPE_FAIL') {
    handleContentResult(sender.tab?.id, { type: 'SCRAPE_FAIL', ...msg }).then(sendResponse);
    return true;
  }

  // ── WoS DOI Enrichment callback ──
  if (msg.type === 'WOS_DOI_ENRICH_COMPLETE') {
    handleWosDoiComplete(sender.tab?.id, msg).then(sendResponse);
    return true;
  }

  // ── Scholar DOI Enrichment callback ──
  if (msg.type === 'SCHOLAR_DOI_ENRICH_COMPLETE') {
    handleScholarDoiComplete(sender.tab?.id, msg).then(sendResponse);
    return true;
  }

  // ── Captcha / Bot Detection ──
  if (msg.type === 'SCHOLAR_CAPTCHA_DETECTED') {
    const tabId = sender.tab?.id;
    const entry = pendingTabs.get(tabId) || pendingScholarDoiTabs.get(tabId);
    const taskId = entry?.taskId;

    console.error(`[Scholar] CAPTCHA detected on tab #${tabId} for task #${taskId}`);
    addLog(`Scholar CAPTCHA detected (Bot detection)`, 'error');

    if (taskId) {
      // Report failure to broker
      fetch(`${API_BASE}/api/doi-enrich-tasks/${taskId}/fail`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ error: 'CAPTCHA_DETECTED', source: 'SCHOLAR' })
      }).catch(err => console.error('[Scholar] Failed to report captcha error to broker:', err));
    }

    // Close the tab to stop the cycle
    chrome.tabs.remove(tabId).catch(() => null);
    sendResponse({ ok: true });
    return true;
  }

  // ── Sync Helper for Content Scripts ──
  if (msg.type === 'GET_CITATION_TASK') {
    const tabId = sender.tab?.id;
    const entry = pendingCitationReportTabs.get(tabId);
    if (entry) {
      console.log(`[WoS Worker] Providing task info to tab #${tabId}:`, entry);
      sendResponse({ taskId: entry.taskId, authorWosId: entry.authorWosId });
    } else {
      console.warn(`[WoS Worker] No citation task mapped for tab #${tabId}`);
      sendResponse({ taskId: null });
    }
    return true;
  }

  // ── Citation Report Link Saved (detay scraping'den sonra açılacak) ──
  if (msg.type === 'CITATION_REPORT_LINK_SAVED') {
    const { taskId, citationReportUrl, authorWosId } = msg;
    handleCitationReportLinkSaved(taskId, citationReportUrl, authorWosId).then(sendResponse);
    return true;
  }

  // ── Citation Report Link Found (doğrudan açılacak - backward compatibility) ──
  if (msg.type === 'CITATION_REPORT_LINK_FOUND') {
    const { taskId, citationReportUrl, authorWosId } = msg;
    console.log(`[WoS Worker] Citation Report link found for task ${taskId}: ${citationReportUrl}`);
    addLog(`Citation Report link found, opening new tab...`, 'info');

    handleCitationReportLinkFound(taskId, citationReportUrl, authorWosId).then(sendResponse);
    return true;
  }

  // ── Citation Report Scrape Complete ──
  if (msg.type === 'CITATION_REPORT_COMPLETE') {
    const tabId = sender.tab?.id;
    const entry = pendingCitationReportTabs.get(tabId);
    const resolvedTaskId = msg.taskId || (entry ? entry.taskId : null);
    const resolvedAuthorId = (msg.data?.authorWosId === 'unknown' || !msg.data?.authorWosId) && entry ? entry.authorWosId : msg.data?.authorWosId;

    if (!resolvedTaskId) {
      console.warn(`[WoS Worker] Citation Report complete but no taskId found for tab ${tabId}. Proceeding in standalone mode.`);
    }

    // Patch the payload with the known authorWosId if it was lost
    if (msg.data && (msg.data.authorWosId === 'unknown' || !msg.data.authorWosId)) {
      msg.data.authorWosId = resolvedAuthorId || 'unknown';
    }

    console.log(`[WoS Worker] Citation Report scrape complete for task ${resolvedTaskId} (Author: ${msg.data?.authorWosId})`);
    addLog(`Citation Report data collected, sending to backend...`, 'success');

    handleCitationReportComplete(tabId, resolvedTaskId, msg.data).then(sendResponse);
    return true;
  }
});

// ═══════════════════════════════════════════════
//  AUTHOR METRICS — Separate early send
// ═══════════════════════════════════════════════

async function handleAuthorMetrics(msg) {
  const { taskId, authorMetrics, url } = msg;

  // Track metrics in diagnostics
  const diagTask = diagGetTask(taskId);
  if (diagTask) {
    diagTask.metrics = { ...authorMetrics, url };
  }

  try {
    console.log(`[WoS Worker] Task ${taskId}: Yazar metrikleri backend'e gönderiliyor...`);
    const h = await brokerHeaders();
    const resp = await fetch(`${API_BASE}/api/tasks/${taskId}/author-metrics`, {
      method: 'POST', headers: h,
      body: JSON.stringify({ authorMetrics, url }),
    });
    if (!resp.ok) {
      const errorText = await resp.text().catch(() => 'Unknown error');
      throw new Error(`HTTP ${resp.status}: ${errorText}`);
    }
    addLog(`Author metrics saved (h-index: ${authorMetrics.hIndex || 0})`, 'success');
  } catch (err) {
    console.warn('[WoS Worker] Yazar metrikleri gönderilemedi:', err);
    addLog(`Failed to save author metrics: ${err.message}`, 'warning');
  }

  // METRICS_ONLY or SCOPUS short-circuit (Scopus doesn't do detail pages yet)
  let targetTabId = null;
  let isShortCircuit = false;

  for (const [tabId, entry] of pendingTabs.entries()) {
    if (entry.taskId === taskId) {
      if (entry.taskType === 'METRICS_ONLY' || entry.source === 'SCOPUS') {
        targetTabId = tabId;
        isShortCircuit = true;
        break;
      }
    }
  }

  if (targetTabId !== null && isShortCircuit) {
    addLog(`Short-circuiting article scraping for ${targetTabId}. Completing...`, 'info');

    try {
      const h = await brokerHeaders();
      const resp = await fetch(`${API_BASE}/api/tasks/${taskId}/complete`, {
        method: 'POST', headers: h,
        body: JSON.stringify({ rawData: { authorMetrics, articles: [], scrapedAt: new Date().toISOString(), url } }),
      });
      if (resp.ok) {
        addLog(`Task completed!`, 'success');
        if (diagTask) { diagTask.status = 'COMPLETED'; diagTask.completedAt = new Date().toISOString(); }
      } else {
        addLog(`Task complete returned ${resp.status}`, 'warning');
        if (diagTask) { diagTask.status = 'ERROR'; diagTask.error = `HTTP ${resp.status}`; diagTask.completedAt = new Date().toISOString(); }
      }
    } catch (err) {
      addLog(`Failed to complete short-circuited task`, 'error');
      if (diagTask) { diagTask.status = 'ERROR'; diagTask.error = err.message; diagTask.completedAt = new Date().toISOString(); }
    }

    clearPendingTab(targetTabId);
    try { await chrome.tabs.remove(targetTabId); } catch (_) { }

    updateState({
      status: 'IDLE', taskId: null, targetId: null,
      progress: { current: 0, total: 0, label: 'Waiting...' }
    });
  }
}

// ═══════════════════════════════════════════════
//  DETAIL SCRAPING — Adaptive pool
// ═══════════════════════════════════════════════

async function handleDetailsNeeded(authorTabId, msg) {
  const { taskId, authorData, skipDetailScraping } = msg;
  const authorTabEntry = pendingTabs.get(authorTabId);
  if (!authorTabEntry) return;

  const source = authorTabEntry.source || 'WOS';
  const articles = authorData.articles || [];

  // Track articles in diagnostics
  const diagTask = diagGetTask(taskId);
  if (diagTask) {
    diagTask.articles = articles.map(a => ({
      title: a.title || '',
      citations: a.citations || 0,
      citationCountScholar: a.citationCountScholar || 0,
      articleUrl: a.articleUrl || null,
      authors: a.authors || [],
      journal: a.journal || '',
      detailStatus: a.articleUrl ? 'PENDING' : 'NO_URL',
      detailData: null,
    }));
  }

  // Scholar: sadece metrics + atıf — detail sayfasına gitme
  if (source === 'SCHOLAR' || skipDetailScraping) {
    addLog(`Scholar: ${articles.length} yayın atıf verisi toplandı. Detail scraping atlanıyor.`, 'info');

    const rawData = { ...authorData, articles, source };
    const authorTabId_ = authorTabId;

    try {
      const h = await brokerHeaders();
      await fetch(`${API_BASE}/api/tasks/${taskId}/complete`, {
        method: 'POST', headers: h,
        body: JSON.stringify({ rawData }),
      });
      addLog(`Scholar task completed (metrics + citations only)!`, 'success');
      if (diagTask) { diagTask.status = 'COMPLETED'; diagTask.completedAt = new Date().toISOString(); }
    } catch (err) {
      console.warn('[Scholar] Backend ulaşılamıyor:', err);
      addLog(`Failed to report Scholar task to backend`, 'error');
      if (diagTask) { diagTask.status = 'ERROR'; diagTask.error = err.message; diagTask.completedAt = new Date().toISOString(); }
    }

    clearPendingTab(authorTabId_);
    try { await chrome.tabs.remove(authorTabId_); } catch (_) { }

    updateState({
      status: 'IDLE', taskId: null, targetId: null,
      progress: { current: 0, total: 0, label: 'Waiting...' }
    });
    return;
  }

  // WOS / SCOPUS: normal detail scraping
  const articlesToDetail = articles.filter(a => a.articleUrl);

  detailJobs.set(taskId, {
    authorData, articles,
    queue: articlesToDetail.map(a => a.articleUrl),
    totalToDetail: articlesToDetail.length,
    detailMap: {}, authorTabId,
    activeTabIds: new Set(), tabToUrlMap: new Map()
  });

  updateState({
    status: 'SCRAPING_DETAILS',
    progress: { current: 0, total: articlesToDetail.length, label: 'Details Extraction' }
  });
  addLog(`Starting detail extraction for ${articlesToDetail.length} articles (pool: ${detailPoolSize})`, 'info');

  fillDetailTabPool(taskId);
}

async function fillDetailTabPool(taskId) {
  const job = detailJobs.get(taskId);
  if (!job) return;

  const authorTabEntry = pendingTabs.get(job.authorTabId);
  const source = authorTabEntry?.source || 'WOS';

  // SOURCE-SPECIFIC POOL LIMITS
  let currentMax = detailPoolSize;
  if (source === 'SCHOLAR') currentMax = 1; // Strictly 1 at a time for Scholar details
  if (source === 'SCOPUS') currentMax = 1;  // Scopus also slow

  // Check rate limit backoff
  if (detailRateLimited && Date.now() < detailBackoffUntil) {
    setTimeout(() => fillDetailTabPool(taskId), detailBackoffUntil - Date.now() + 1000);
    return;
  }
  if (detailRateLimited && Date.now() >= detailBackoffUntil) {
    detailRateLimited = false;
    detailPoolSize = Math.min(detailPoolSize + 1, DETAIL_POOL_MAX);
  }

  while (job.activeTabIds.size < currentMax && job.queue.length > 0) {
    // Longer delays for Scholar to avoid "too many windows/tabs" blocking
    const minDelay = source === 'SCHOLAR' ? 3000 : 800;
    const maxDelay = source === 'SCHOLAR' ? 7000 : 2500;
    await humanDelay(minDelay, maxDelay);

    let url = job.queue.shift();
    if (source === 'SCHOLAR' && !url.includes('scholar-task-id')) {
      url += (url.includes('#') ? '&' : '#') + `scholar-task-id=${taskId}`;
    } else if (source === 'WOS' && !url.includes('wos-task-id')) {
      url += (url.includes('#') ? '&' : '#') + `wos-task-id=${taskId}`;
    } else if (source === 'SCOPUS' && !url.includes('scopus-task-id')) {
      url += (url.includes('#') ? '&' : '#') + `scopus-task-id=${taskId}`;
    }

    await openDetailTab(taskId, job, url);
  }

  if (job.activeTabIds.size === 0 && job.queue.length === 0) {
    await finalizeAndComplete(taskId);
  }
}

async function openDetailTab(taskId, job, url) {
  try {
    const tab = await chrome.tabs.create({ url, active: false });
    job.activeTabIds.add(tab.id);
    job.tabToUrlMap.set(tab.id, url);
  } catch (e) {
    console.warn('[WoS Worker] Detay sekmesi açılamadı:', e);
    fillDetailTabPool(taskId);
  }
}

// ═══════════════════════════════════════════════
//  ARTICLE DETAIL COMPLETE — with rate limit detection
// ═══════════════════════════════════════════════

async function handleArticleDetailComplete(detailTabId, msg) {
  let taskId = null;
  let job = null;
  for (const [tid, j] of detailJobs.entries()) {
    if (j.activeTabIds.has(detailTabId)) {
      taskId = tid; job = j; break;
    }
  }

  if (!job) {
    try { await chrome.tabs.remove(detailTabId); } catch (_) { }
    return;
  }

  const assignedUrl = job.tabToUrlMap.get(detailTabId);

  if (msg.detail && assignedUrl) {
    job.detailMap[assignedUrl] = msg.detail;

    // Track detail result in diagnostics
    const diagTask = diagGetTask(taskId);
    if (diagTask) {
      const baseAssignedUrl = assignedUrl.split('#')[0];
      const diagArticle = diagTask.articles.find(a => a.articleUrl === baseAssignedUrl || assignedUrl.startsWith(a.articleUrl));
      if (diagArticle) {
        diagArticle.detailStatus = 'SUCCESS';
        diagArticle.detailData = {
          doi: msg.detail.doi || '',
          indexTypes: msg.detail.indexTypes || [],
          language: msg.detail.language || '',
          accession: msg.detail.accession || '',
          journal: msg.detail.journal || '',
          volume: msg.detail.volume || '',
          abstract: msg.detail.abstract ? msg.detail.abstract.substring(0, 100) + '...' : '',
        };
      }
    }

    const extracted = Object.keys(job.detailMap).length;
    updateState({
      progress: { current: extracted, total: job.totalToDetail, label: 'Extracting Details' },
      stats: { ...appState.stats, detailsExtracted: extracted }
    });
    addLog(`Got details for: ${msg.detail.doi || 'Article'}`, 'success');

    // Successful extraction — try to grow pool if it was shrunk
    if (detailPoolSize < DETAIL_POOL_MAX && !detailRateLimited) {
      // Gradually increase pool after 3 consecutive successes
      detailPoolSize = Math.min(detailPoolSize + 1, DETAIL_POOL_MAX);
    }
  } else if (msg.error) {
    // Track failure in diagnostics
    const diagTask = diagGetTask(taskId);
    if (diagTask && assignedUrl) {
      const baseAssignedUrl = assignedUrl.split('#')[0];
      const diagArticle = diagTask.articles.find(a => a.articleUrl === baseAssignedUrl || assignedUrl.startsWith(a.articleUrl));
      if (diagArticle) {
        diagArticle.detailStatus = 'FAILED';
        diagArticle.detailData = { error: msg.error };
      }
    }
  }

  // Check for rate limit signals in the response
  if (msg.error && (msg.error.includes('429') || msg.error.includes('503') || msg.error.includes('rate'))) {
    detailRateLimited = true;
    detailPoolSize = Math.max(DETAIL_POOL_MIN, detailPoolSize - 1);
    detailBackoffUntil = Date.now() + 30000; // 30s backoff
    addLog(`Rate limited! Detail pool shrunk to ${detailPoolSize}, backing off 30s`, 'warning');
  }

  try { await chrome.tabs.remove(detailTabId); } catch (_) { }
  job.activeTabIds.delete(detailTabId);
  job.tabToUrlMap.delete(detailTabId);

  await fillDetailTabPool(taskId);
}

// ═══════════════════════════════════════════════
//  FINALIZE — Merge details & send to backend
// ═══════════════════════════════════════════════

async function finalizeAndComplete(taskId) {
  const job = detailJobs.get(taskId);
  if (!job) return;

  const enrichedArticles = job.articles.map(article => {
    let detail = null;
    if (article.articleUrl) {
      // Mismatch fix: The URL in detailMap has `#wos-task-id=...` appended during detail pool generation
      const baseArticleUrl = article.articleUrl.split('#')[0];
      const matchingKey = Object.keys(job.detailMap).find(k => k.startsWith(baseArticleUrl));
      detail = matchingKey ? job.detailMap[matchingKey] : null;
    }

    // Merge authors: prefer detail-page (semicolon) over list-page (could be anything)
    let authors = article.authors || '';
    if (detail?.authors) {
      authors = detail.authors;
    }
    const authorsList = authors.split(/[;,]/).map(a => a.trim()).filter(a => a);

    return {
      ...article,
      abstract: detail?.abstract || article.abstract || '',
      authors: authorsList,
      funding: detail?.funding || '',
      addresses: detail?.addresses || '',
      publisher: detail?.publisher || article.publisher || '',
      indexTypes: detail?.indexTypes || article.indexTypes || [],
      indexType: detail?.indexType || null,            // Q değeri: "Q1", "Q2", vs.
      doi: detail?.doi || '',
      volume: detail?.volume || '',
      issue: detail?.issue || '',
      pages: detail?.pages || '',
      pubDate: detail?.pubDate || article.pubDate || '',
      earlyAccess: detail?.earlyAccess || '',
      articleNo: detail?.articleNo || '',
      journal: detail?.journal || article.journal || '',
      indexed: detail?.indexed || '',
      accession: detail?.accession || '',
      issn: detail?.issn || '',
      eissn: detail?.eissn || '',
      language: detail?.language || '',
      idsNumber: detail?.idsNumber || '',
      documentTypes: detail?.documentTypes || [],
      mappedPublicationType: detail?.mappedPublicationType || null, // Sistem yayın türü
      wosCategories: detail?.wosCategories || [],
      researchAreas: detail?.researchAreas || [],
      jcrCategories: detail?.jcrCategories || [],
      jciCategories: detail?.jciCategories || [],
      jifValues: detail?.jifValues || [],
      authorKeywords: detail?.authorKeywords || [],    // Yazar anahtar kelimeleri
      keywordsPlus: detail?.keywordsPlus || [],       // WoS KeyWords Plus
      wosCitations: detail?.wosCitations || article.citations || 0,
    };
  });

  const authorTabEntry = pendingTabs.get(job.authorTabId);
  const source = authorTabEntry?.source || 'WOS';
  const rawData = { ...job.authorData, articles: enrichedArticles, source };
  const authorTabId = job.authorTabId;
  detailJobs.delete(taskId);

  updateState({ status: 'COMPLETING' });
  addLog(`Merging data and contacting backend (${enrichedArticles.length} articles)...`, 'info');

  // Update diagnostics with final enriched data
  const diagTask = diagGetTask(taskId);

  try {
    const h = await brokerHeaders();
    const payload = JSON.stringify({ rawData });
    console.log(`[WoS Worker] Task ${taskId}: Sending complete payload (${(payload.length/1024).toFixed(1)} KB, ${enrichedArticles.length} articles)`);
    const resp = await fetch(`${API_BASE}/api/tasks/${taskId}/complete`, {
      method: 'POST', headers: h,
      body: payload,
    });
    if (!resp.ok) {
      const errorText = await resp.text().catch(() => 'Unknown error');
      throw new Error(`HTTP ${resp.status}: ${errorText}`);
    }
    addLog(`Task successfully completed!`, 'success');
    if (diagTask) { diagTask.status = 'COMPLETED'; diagTask.completedAt = new Date().toISOString(); }
    markSourceComplete(source);
  } catch (err) {
    console.warn('[WoS Worker] Backend API ulaşılamıyor:', err);
    addLog(`Failed to report to backend: ${err.message}`, 'error');
    if (diagTask) { diagTask.status = 'ERROR'; diagTask.error = err.message; diagTask.completedAt = new Date().toISOString(); }
    markSourceComplete(source, true);
  }

  // Author tab'ını kapat
  clearPendingTab(authorTabId);
  try { await chrome.tabs.remove(authorTabId); } catch (_) { }

  // ── Citation Report Tab'ını Aç (detay scraping'den sonra) ──
  // Eğer bu task için kaydedilmiş bir Citation Report linki varsa aç
  const savedLink = savedCitationReportLinks.get(taskId);
  if (savedLink) {
    addLog(`Opening Citation Report tab for task ${taskId}...`, 'info');
    // Citation Report tab'ını aç (asenkron, beklemiyoruz)
    openCitationReportTab(taskId).catch(err => {
      console.warn('[WoS Worker] Failed to open Citation Report tab:', err);
    });
  }

  updateState({
    status: 'IDLE', taskId: null, targetId: null,
    progress: { current: 0, total: 0, label: 'Waiting...' }
  });
}

// ═══════════════════════════════════════════════
//  SCRAPE FAIL
// ═══════════════════════════════════════════════

async function handleContentResult(tabId, msg) {
  if (tabId == null) return;

  // Check if it's a detail tab
  for (const [tid, job] of detailJobs.entries()) {
    if (job.activeTabIds.has(tabId)) {
      try { await chrome.tabs.remove(tabId); } catch (_) { }
      job.activeTabIds.delete(tabId);
      job.tabToUrlMap.delete(tabId);
      addLog(`Failed to get details for an article`, 'warning');

      // Detect rate limit from error message
      if (msg.error && (msg.error.includes('429') || msg.error.includes('503') || msg.error.includes('Forbidden'))) {
        detailRateLimited = true;
        detailPoolSize = Math.max(DETAIL_POOL_MIN, detailPoolSize - 1);
        detailBackoffUntil = Date.now() + 30000;
        addLog(`Rate limit detected! Pool → ${detailPoolSize}, backoff 30s`, 'warning');
      }

      await fillDetailTabPool(tid);
      return;
    }
  }

  // Main author tab fail
  const entry = pendingTabs.get(tabId);
  if (!entry) return;
  const { taskId } = entry;

  addLog(`Scrape Failed: ${msg.error || 'Unknown error'}`, 'error');
  updateState({ status: 'ERROR' });

  // Track failure in diagnostics
  const diagTask = diagGetTask(taskId);
  if (diagTask) {
    diagTask.status = 'FAILED';
    diagTask.error = msg.error || 'Scrape failed';
    diagTask.completedAt = new Date().toISOString();
  }

  markSourceComplete(entry?.source, true);

  try {
    const h = await brokerHeaders();
    await fetch(`${API_BASE}/api/tasks/${taskId}/fail`, {
      method: 'POST', headers: h,
      body: JSON.stringify({ error: msg.error || 'Scrape failed' }),
    });
  } catch (err) { }

  clearPendingTab(tabId);
  try { await chrome.tabs.remove(tabId); } catch (_) { }

  updateState({
    status: 'IDLE', taskId: null, targetId: null,
    progress: { current: 0, total: 0, label: 'Waiting...' }
  });
}

// ═══════════════════════════════════════════════
//  PLUMX COMPLETE — with rate limit detection
// ═══════════════════════════════════════════════

async function handlePlumxDetailComplete(tabId, msg) {
  const { taskId, data } = msg;

  const plumxEntry = pendingPlumx.get(tabId);
  if (plumxEntry) {
    console.log(`[PlumX Worker] Task ${taskId}: Scopus=${data.scopusCitations}, Mendeley=${data.mendeleyCitations || 0}, CrossRef=${data.crossrefCitations || 0}`);
    addLog(`PlumX synced: Scopus=${data.scopusCitations}, Mendeley=${data.mendeleyCitations || 0}, CrossRef=${data.crossrefCitations || 0}`, 'success');

    // Track PlumX result in diagnostics
    diagAddPlumx(taskId, plumxEntry.doi, data);
    pushEnrichmentResult('PLUMX', plumxEntry.doi, data, null);
    broadcastTaskEnded(taskId);

    try {
      const h = await brokerHeaders();
      const resp = await fetch(`${API_BASE}/api/plumx-tasks/${taskId}/complete`, {
        method: 'POST', headers: h,
        body: JSON.stringify({ rawData: data }),
      });
      if (!resp.ok) {
        const errorText = await resp.text().catch(() => 'Unknown error');
        throw new Error(`HTTP ${resp.status}: ${errorText}`);
      }
      addLog(`PlumX Task ${taskId} completed!`, 'success');
    } catch (err) {
      addLog(`Failed to report PlumX task to backend: ${err.message}`, 'error');
    }

    pendingPlumx.delete(tabId);
    try { await chrome.tabs.remove(tabId); } catch (_) { }
    return;
  }

  // Legacy scrape-based PlumX tab
  const entry = pendingTabs.get(tabId);
  if (!entry) return;

  addLog(`PlumX synced: Scopus=${data.scopusCitations}, Mendeley=${data.mendeleyCitations || 0}`, 'success');
  updateState({ status: 'COMPLETING' });

  try {
    const h = await brokerHeaders();
    const resp = await fetch(`${API_BASE}/api/tasks/${taskId}/complete`, {
      method: 'POST', headers: h,
      body: JSON.stringify({ rawData: data }),
    });
    if (!resp.ok) {
      const errorText = await resp.text().catch(() => 'Unknown error');
      throw new Error(`HTTP ${resp.status}: ${errorText}`);
    }
    addLog(`PlumX Task completed!`, 'success');
  } catch (err) {
    addLog(`Failed to report PlumX task to backend: ${err.message}`, 'error');
  }

  clearPendingTab(tabId);
  try { await chrome.tabs.remove(tabId); } catch (_) { }

  updateState({
    status: 'IDLE', taskId: null, targetId: null,
    progress: { current: 0, total: 0, label: 'Waiting...' }
  });
}

// ═══════════════════════════════════════════════
//  WOS DOI ENRICHMENT — polling & tab management
// ═══════════════════════════════════════════════

async function pollWosDoi() {
  const slotsAvailable = wosDoiPoolSize - pendingWosDoiTabs.size;
  if (slotsAvailable <= 0) return false;

  try {
    const headers = await brokerHeaders();
    const res = await fetch(
      `${API_BASE}/api/doi-enrich-tasks/poll?source=WOS&batchSize=${slotsAvailable}`,
      { headers }
    );
    if (res.status === 204 || !res.ok) return false;

    const tasks = await res.json();
    if (!Array.isArray(tasks) || tasks.length === 0) return false;

    console.log(`[WoS DOI Worker] Received ${tasks.length} WoS DOI task(s)`);
    for (let i = 0; i < tasks.length; i++) {
      const { taskId, externalId: doi } = tasks[i];
      if (taskId != null && doi) {
        if (i > 0) await humanDelay(1500, 4000);
        await openWosDoiTab(taskId, doi);
      }
    }
    return true;
  } catch (err) {
    console.warn('[WoS DOI Worker] Poll failed:', err);
    return false;
  }
}

async function openWosDoiTab(taskId, doi) {
  const encodedDoi = encodeURIComponent(doi);
  const url = `https://www.webofscience.com/wos/woscc/smart-search#wos-doi-task-id=${taskId}&doi=${encodedDoi}`;
  try {
    const tab = await chrome.tabs.create({ url, active: false });
    pendingWosDoiTabs.set(tab.id, { taskId, doi });
    console.log(`[WoS DOI Worker] Opened tab #${tab.id} for DOI: ${doi}`);
    broadcastTaskStarted(taskId, 'WOS', doi);

    // Inject script when tab finishes loading
    const handler = async (changedTabId, changeInfo) => {
      if (changedTabId !== tab.id || changeInfo.status !== 'complete') return;
      chrome.tabs.onUpdated.removeListener(handler);
      try {
        await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          files: ['wos_doi_content.js'],
        });
      } catch (e) {
        console.warn('[WoS DOI Worker] Failed to inject wos_doi_content.js:', e);
        await reportDoiTaskFail('WOS', taskId, 'Injection failed');
        pendingWosDoiTabs.delete(tab.id);
        try { await chrome.tabs.remove(tab.id); } catch (_) { }
      }
    };
    chrome.tabs.onUpdated.addListener(handler);

    // Timeout: 5 minutes
    setTimeout(async () => {
      if (!pendingWosDoiTabs.has(tab.id)) return;
      console.warn(`[WoS DOI Worker] Tab ${tab.id} timed out`);
      try { await chrome.tabs.remove(tab.id); } catch (_) { }
      pendingWosDoiTabs.delete(tab.id);
      await reportDoiTaskFail('WOS', taskId, 'Timeout');
    }, 300_000);

  } catch (e) {
    console.warn('[WoS DOI Worker] Failed to open tab:', e);
  }
}

async function handleWosDoiComplete(tabId, msg) {
  const { taskId, doi, data, error } = msg;

  if (error || !data) {
    addLog(`WoS DOI failed for ${doi}: ${error}`, 'warning');
    pushEnrichmentResult('WOS', doi, null, error || 'No data');
    await reportDoiTaskFail('WOS', taskId, error || 'No data');
  } else {
    addLog(`WoS DOI enriched: ${doi} | Q=${data.quartile} | Cit=${data.wosCitations}`, 'success');
    pushEnrichmentResult('WOS', doi, data, null);
    try {
      const h = await brokerHeaders();
      const resp = await fetch(`${API_BASE}/api/doi-enrich-tasks/${taskId}/complete`, {
        method: 'POST', headers: h,
        body: JSON.stringify({ source: 'WOS', rawData: { ...data, doi } }),
      });
      if (!resp.ok) {
        const errorText = await resp.text().catch(() => 'Unknown error');
        throw new Error(`HTTP ${resp.status}: ${errorText}`);
      }
    } catch (err) {
      addLog(`Failed to report WoS DOI result to backend: ${err.message}`, 'error');
    }
  }

  broadcastTaskEnded(taskId);
  if (tabId != null) {
    pendingWosDoiTabs.delete(tabId);
    try { await chrome.tabs.remove(tabId); } catch (_) { }
  }
}

// ═══════════════════════════════════════════════
//  SCHOLAR DOI ENRICHMENT — polling & tab management
// ═══════════════════════════════════════════════

async function pollScholarDoi() {
  const slotsAvailable = scholarDoiPoolSize - pendingScholarDoiTabs.size;
  if (slotsAvailable <= 0) return false;

  try {
    const headers = await brokerHeaders();
    const res = await fetch(
      `${API_BASE}/api/doi-enrich-tasks/poll?source=SCHOLAR&batchSize=${slotsAvailable}`,
      { headers }
    );
    if (res.status === 204 || !res.ok) return false;

    const tasks = await res.json();
    if (!Array.isArray(tasks) || tasks.length === 0) return false;

    console.log(`[Scholar DOI Worker] Received ${tasks.length} Scholar DOI task(s)`);
    for (let i = 0; i < tasks.length; i++) {
      const { taskId, externalId: doi } = tasks[i];
      if (taskId != null && doi) {
        if (i > 0) await humanDelay(2000, 5000);
        await openScholarDoiTab(taskId, doi);
      }
    }
    return true;
  } catch (err) {
    console.warn('[Scholar DOI Worker] Poll failed:', err);
    return false;
  }
}

async function openScholarDoiTab(taskId, doi) {
  const encodedDoi = encodeURIComponent(doi);
  const url = `https://scholar.google.com/scholar_lookup?hl=en&doi=${encodedDoi}#scholar-doi-task-id=${taskId}&doi=${encodedDoi}`;
  try {
    const tab = await chrome.tabs.create({ url, active: false });
    pendingScholarDoiTabs.set(tab.id, { taskId, doi });
    console.log(`[Scholar DOI Worker] Opened tab #${tab.id} for DOI: ${doi}`);
    broadcastTaskStarted(taskId, 'SCHOLAR', doi);

    const handler = async (changedTabId, changeInfo) => {
      if (changedTabId !== tab.id || changeInfo.status !== 'complete') return;
      chrome.tabs.onUpdated.removeListener(handler);
      try {
        await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          files: ['scholar_doi_content.js'],
        });
      } catch (e) {
        console.warn('[Scholar DOI Worker] Failed to inject scholar_doi_content.js:', e);
        await reportDoiTaskFail('SCHOLAR', taskId, 'Injection failed');
        pendingScholarDoiTabs.delete(tab.id);
        try { await chrome.tabs.remove(tab.id); } catch (_) { }
      }
    };
    chrome.tabs.onUpdated.addListener(handler);

    // Timeout: 3 minutes
    setTimeout(async () => {
      if (!pendingScholarDoiTabs.has(tab.id)) return;
      console.warn(`[Scholar DOI Worker] Tab ${tab.id} timed out`);
      try { await chrome.tabs.remove(tab.id); } catch (_) { }
      pendingScholarDoiTabs.delete(tab.id);
      await reportDoiTaskFail('SCHOLAR', taskId, 'Timeout');
    }, 180_000);

  } catch (e) {
    console.warn('[Scholar DOI Worker] Failed to open Scholar tab:', e);
  }
}

async function handleScholarDoiComplete(tabId, msg) {
  const { taskId, doi, data, error } = msg;

  if (error || !data) {
    addLog(`Scholar DOI failed for ${doi}: ${error}`, 'warning');
    pushEnrichmentResult('SCHOLAR', doi, null, error || 'No data');
    await reportDoiTaskFail('SCHOLAR', taskId, error || 'No data');
  } else {
    addLog(`Scholar DOI enriched: ${doi} | Cited by=${data.scholarCitations}`, 'success');
    pushEnrichmentResult('SCHOLAR', doi, data, null);
    try {
      const h = await brokerHeaders();
      const resp = await fetch(`${API_BASE}/api/doi-enrich-tasks/${taskId}/scholar-complete`, {
        method: 'POST', headers: h,
        body: JSON.stringify({ source: 'SCHOLAR', rawData: { ...data, doi } }),
      });
      if (!resp.ok) {
        const errorText = await resp.text().catch(() => 'Unknown error');
        throw new Error(`HTTP ${resp.status}: ${errorText}`);
      }
    } catch (err) {
      addLog(`Failed to report Scholar DOI result to backend: ${err.message}`, 'error');
    }
  }

  broadcastTaskEnded(taskId);
  if (tabId != null) {
    pendingScholarDoiTabs.delete(tabId);
    try { await chrome.tabs.remove(tabId); } catch (_) { }
  }
}

// Shared helper: report DOI task failure to backend
async function reportDoiTaskFail(source, taskId, error) {
  try {
    const h = await brokerHeaders();
    await fetch(`${API_BASE}/api/doi-enrich-tasks/${taskId}/fail`, {
      method: 'POST', headers: h,
      body: JSON.stringify({ source, error }),
    });
  } catch (_) { }
}

// ═══════════════════════════════════════════════
//  CITATION REPORT — Link saved & Tab management
// ═══════════════════════════════════════════════

const pendingCitationReportTabs = new Map(); // tabId → { taskId, authorWosId }
const savedCitationReportLinks = new Map(); // taskId → { citationReportUrl, authorWosId }

// Citation Report linki kaydet (detay scraping'den sonra açılacak)
async function handleCitationReportLinkSaved(taskId, citationReportUrl, authorWosId) {
  console.log(`[WoS Worker] Citation Report link saved for task ${taskId}: ${citationReportUrl}`);
  savedCitationReportLinks.set(taskId, { citationReportUrl, authorWosId });
  addLog(`Citation Report link saved for later`, 'info');
  return { ok: true };
}

// Citation Report tab'ını aç (detay scraping tamamlandıktan sonra çağrılır)
async function openCitationReportTab(taskId) {
  const savedLink = savedCitationReportLinks.get(taskId);
  if (!savedLink) {
    console.log(`[WoS Worker] No saved Citation Report link for task ${taskId}`);
    return { ok: false, error: 'No saved link' };
  }

  const { citationReportUrl, authorWosId } = savedLink;
  savedCitationReportLinks.delete(taskId);

  console.log(`[WoS Worker] Opening Citation Report tab for task ${taskId}: ${citationReportUrl}`);
  addLog(`Opening Citation Report tab...`, 'info');

  return await handleCitationReportLinkFound(taskId, citationReportUrl, authorWosId);
}

async function handleCitationReportLinkFound(taskId, citationReportUrl, authorWosId) {
  // URL'e task ID'yi ekle
  let url = citationReportUrl;
  const sep = url.includes('#') ? '&' : '#';
  url = `${url}${sep}citation-report-task-id=${taskId}&author-wos-id=${authorWosId || ''}`;

  try {
    const tab = await chrome.tabs.create({ url, active: false });
    pendingCitationReportTabs.set(tab.id, { taskId, authorWosId, openedAt: Date.now() });
    console.log(`[WoS Worker] Opened Citation Report tab #${tab.id} for task ${taskId}`);
    addLog(`Citation Report tab opened`, 'info');

    // Inject content script when tab finishes loading
    const injectionHandler = async (changedTabId, changeInfo) => {
      if (changedTabId !== tab.id || changeInfo.status !== 'complete') return;
      chrome.tabs.onUpdated.removeListener(injectionHandler);

      try {
        console.log(`[Citation Report] Injecting wos_citation_report_content.js into tab #${tab.id}`);
        await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          files: ['wos_citation_report_content.js'],
        });
        console.log(`[Citation Report] Script injected successfully`);
      } catch (injectErr) {
        console.warn('[Citation Report] Failed to inject content script:', injectErr);
        addLog(`Failed to inject Citation Report script`, 'error');

        // Report failure
        const h = await brokerHeaders();
        await fetch(`http://localhost:8080/api/wos/citation-report/sync`, {
          method: 'POST',
          headers: h,
          body: JSON.stringify({
            authorWosId: authorWosId || 'unknown',
            error: 'Injection failed',
            taskId
          }),
        }).catch(() => null);

        pendingCitationReportTabs.delete(tab.id);
        try { await chrome.tabs.remove(tab.id); } catch (_) { }
      }
    };
    chrome.tabs.onUpdated.addListener(injectionHandler);

    // Timeout: 3 minutes
    setTimeout(async () => {
      if (pendingCitationReportTabs.has(tab.id)) {
        console.warn(`[Citation Report] Tab ${tab.id} timed out`);
        try { await chrome.tabs.remove(tab.id); } catch (_) { }
        pendingCitationReportTabs.delete(tab.id);
      }
    }, 180_000);

    return { ok: true, tabId: tab.id };
  } catch (e) {
    console.warn('[WoS Worker] Failed to open Citation Report tab:', e);
    addLog(`Failed to open Citation Report tab`, 'error');
    return { ok: false, error: e.message };
  }
}

async function handleCitationReportComplete(tabId, taskId, data) {
  console.log(`[Citation Report] Scrape complete for task ${taskId}`);
  addLog(`Citation Report data received, sending to backend...`, 'info');

  try {
    const h = await brokerHeaders();
    const response = await fetch(`http://localhost:8080/api/wos/citation-report/sync`, {
      method: 'POST',
      headers: h,
      body: JSON.stringify(data),
    });

    if (response.ok) {
      addLog(`Citation Report synced successfully!`, 'success');
      console.log(`[Citation Report] Data synced to backend for task ${taskId}`);
    } else {
      addLog(`Citation Report sync failed: HTTP ${response.status}`, 'error');
      console.warn(`[Citation Report] Backend returned ${response.status}`);
    }
  } catch (err) {
    console.warn('[Citation Report] Failed to sync data to backend:', err);
    addLog(`Failed to sync Citation Report data`, 'error');
  }

  // Tab'ı kapat
  if (tabId) {
    pendingCitationReportTabs.delete(tabId);
    try { await chrome.tabs.remove(tabId); } catch (_) { }
  }

  return { ok: true };
}

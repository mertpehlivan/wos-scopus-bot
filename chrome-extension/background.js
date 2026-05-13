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

// Retry wrapper for broker polling (handles transient failures)
const FETCH_MAX_RETRIES = 3;
const FETCH_RETRY_DELAYS = [1000, 3000, 5000]; // exponential backoff

async function fetchWithRetry(url, options, retries = 0) {
  try {
    const res = await fetch(url, options);
    if (res.ok || res.status === 204) return res;

    // Don't retry 4xx errors (client error), only 5xx (server) or network errors
    if (res.status >= 500 && retries < FETCH_MAX_RETRIES) {
      console.warn(`[Polling] HTTP ${res.status}, retry ${retries + 1}/${FETCH_MAX_RETRIES}`);
      await new Promise(r => setTimeout(r, FETCH_RETRY_DELAYS[retries]));
      return fetchWithRetry(url, options, retries + 1);
    }
    return res;
  } catch (err) {
    // Network error - retry with exponential backoff
    if (retries < FETCH_MAX_RETRIES) {
      console.warn(`[Polling] Network error: ${err.message}, retry ${retries + 1}/${FETCH_MAX_RETRIES}`);
      await new Promise(r => setTimeout(r, FETCH_RETRY_DELAYS[retries]));
      return fetchWithRetry(url, options, retries + 1);
    }
    throw err; // Give up after max retries
  }
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

// ─── Timeout Configuration ────────────────────────────────────────────────────
// IMPORTANT: These must be shorter than broker.processing-timeout-minutes (120min = 7_200_000ms)
// so the extension always reports fail/complete BEFORE the broker resets the task.
//
// PRE_READY_TIMEOUT_MS  — If content script never signals SCRAPE_READY, give up after 3 min.
// SCRAPE_TIMEOUT_MS     — Maximum time allowed after SCRAPE_READY. Extended on PROGRESS_UPDATE.
//                         Must be < broker timeout so extension fails tasks before broker resets them.
const PRE_READY_TIMEOUT_MS = 180_000;   // 3 minutes  (broker: 120 min)
const SCRAPE_TIMEOUT_MS    = 3_600_000; // 60 minutes — raised from 10 min to allow large profiles

// Active scrape timeout trackers (tabId → timeoutId)
const scrapeTimeouts = new Map();

// Adaptive detail tab pool
// Detail tabs run STRICTLY one at a time across all sources. We open
// each tab with active:true so its renderer isn't RAF-throttled — but
// only one tab can be active in a window at once. Running pool > 1
// would mean every new tab demotes the previous to background mid-load
// and Angular's lazy-mounted JCR/abstract sections never finish
// rendering. Pool stays clamped to 1.
let detailPoolSize = 1;
const DETAIL_POOL_MIN = 1;
const DETAIL_POOL_MAX = 1;
let detailRateLimited = false;
let detailBackoffUntil = 0;

// Adaptive PlumX tab pool
let plumxPoolSize = 3;      // 3 at a time for faster PlumX scraping
const PLUMX_POOL_MIN = 1;
const PLUMX_POOL_MAX = 3;
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
//  PHASE-BASED ORCHESTRATOR CONFIGURATION
// ═══════════════════════════════════════════════

// Phase priority chain (highest → lowest):
//   OPENALEX → WOS → SCOPUS → PLUMX → SCHOLAR
// OpenAlex drains the publications baseline first — DOIs, titles,
// authorship come from OpenAlex and the other sources only enrich
// citation metrics on top of those rows. Running OpenAlex AFTER
// WoS/Scopus would race the operator panel into showing partial data.
//
// Orchestrator is stateless: every tick re-checks the chain from the
// top, so a fresh sync request always starts at OpenAlex regardless
// of where the worker idled in the previous cycle.

let GROUP_CONFIG = {
  wos: true,
  scopusPlumx: true,
  scholar: true,
};

// WOS group tracking
const activeWosJobs = {
  profileTab: null,      // { tabId, taskId }
  detailTabs: new Set(), // article_detail.js tab ids
  citationReportTab: null // { tabId, taskId }
};

// Scopus group tracking
const activeScopusJobs = {
  profileTab: null,
};

// Load group config from storage on startup
chrome.storage.local.get(['groupConfig'], (r) => {
  if (r.groupConfig) {
    GROUP_CONFIG = { ...GROUP_CONFIG, ...r.groupConfig };
    console.log('[Orchestrator] Loaded group config:', GROUP_CONFIG);
  }
});

// Listen for group config changes from popup
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.groupConfig) {
    GROUP_CONFIG = { ...GROUP_CONFIG, ...changes.groupConfig.newValue };
    console.log('[Orchestrator] Group config updated:', GROUP_CONFIG);
  }
});

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
  if (appState.logs.length > 150) appState.logs.shift();  // Increased from 30 to 150
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

/**
 * Maximum number of times we'll wipe cookies + reload before giving up
 * on a Scopus task and reporting LOGIN_FAILED.
 */
const SCOPUS_MAX_RECOVERY_ATTEMPTS = 2;
const SCOPUS_RECOVERY_COOLDOWN_MS = 5_000;

/**
 * Per-task recovery state, kept in chrome.storage.session so it survives
 * tab reloads but resets on browser restart.
 *
 * Shape: { 'scopus_recovery_<taskId>': { attempts: number, lastAttemptAt: number } }
 */
async function getScopusRecoveryState(taskId) {
  const key = `scopus_recovery_${taskId}`;
  const stored = await chrome.storage.session.get([key]);
  return stored[key] || { attempts: 0, lastAttemptAt: 0 };
}

async function setScopusRecoveryState(taskId, state) {
  await chrome.storage.session.set({ [`scopus_recovery_${taskId}`]: state });
}

async function clearScopusRecoveryState(taskId) {
  await chrome.storage.session.remove([`scopus_recovery_${taskId}`]);
}

/**
 * Wipes cookies + storage for Scopus/Elsevier origins and reloads the tab
 * back to the original profile URL. Tracks attempts per-task so we don't
 * loop forever — after MAX_ATTEMPTS we report LOGIN_FAILED and let the
 * orchestrator give up cleanly.
 */
async function recoverScopusSession(tabId, taskId, externalId) {
  const state = await getScopusRecoveryState(taskId);

  // Cooldown: ignore rapid repeats from the same tab (e.g., multiple
  // detection callbacks firing during a single redirect).
  if (state.lastAttemptAt && Date.now() - state.lastAttemptAt < SCOPUS_RECOVERY_COOLDOWN_MS) {
    console.log(`[Scopus Session] Recovery for task ${taskId} on cooldown, skipping`);
    return;
  }

  if (state.attempts >= SCOPUS_MAX_RECOVERY_ATTEMPTS) {
    console.warn(`[Scopus Session] Task ${taskId} exhausted ${SCOPUS_MAX_RECOVERY_ATTEMPTS} recovery attempts; reporting LOGIN_FAILED`);
    addLog(`Scopus auto-recovery failed after ${state.attempts} attempts`, 'error');
    await postSessionEvent('SCOPUS', 'LOGIN_FAILED',
      `auto-recovery exhausted after ${state.attempts} attempts`);
    // Mark the broker task as failed so the orchestrator surfaces LOGIN_FAILED
    // promptly instead of waiting for its 30-min source timeout.
    try {
      const headers = await brokerHeaders();
      await fetch(`${API_BASE}/api/tasks/${taskId}/fail`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ error: 'Scopus auto-recovery exhausted' }),
      });
    } catch (e) {
      console.warn('[Scopus Session] Failed to mark task failed:', e?.message || e);
    }
    await clearScopusRecoveryState(taskId);
    clearPendingTab(tabId);
    return;
  }

  const nextAttempt = state.attempts + 1;
  await setScopusRecoveryState(taskId, { attempts: nextAttempt, lastAttemptAt: Date.now() });

  console.log(`[Scopus Session] Recovery attempt ${nextAttempt}/${SCOPUS_MAX_RECOVERY_ATTEMPTS} for task ${taskId}`);
  addLog(`Scopus recovery attempt ${nextAttempt}: clearing cookies & storage`, 'warning');
  await postSessionEvent('SCOPUS', 'LOGIN_IN_PROGRESS',
    `recovery attempt ${nextAttempt}: clearing browser data`);

  // Wipe cookies + cache + IndexedDB + Service Workers + WebSQL + LocalStorage + ServerBoundCerts
  // for Scopus and Elsevier origins. Browsing history is left alone — irrelevant.
  try {
    await chrome.browsingData.remove(
      {
        origins: [
          'https://www.scopus.com',
          'https://scopus.com',
          'https://id.elsevier.com',
          'https://www.elsevier.com',
          'https://elsevier.com',
        ],
      },
      {
        cookies: true,
        localStorage: true,
        indexedDB: true,
        cacheStorage: true,
        serviceWorkers: true,
      }
    );
    console.log('[Scopus Session] Cleared cookies + storage for Scopus/Elsevier');
  } catch (e) {
    console.warn('[Scopus Session] browsingData.remove failed:', e?.message || e);
  }

  // Also wipe any stragglers via cookies API (covers cases where
  // browsingData missed cookies on subdomains we didn't list).
  try {
    const domains = ['.scopus.com', '.elsevier.com'];
    for (const domain of domains) {
      const cookies = await chrome.cookies.getAll({ domain });
      for (const c of cookies) {
        const protocol = c.secure ? 'https://' : 'http://';
        const host = c.domain.startsWith('.') ? c.domain.substring(1) : c.domain;
        const cookieUrl = protocol + host + c.path;
        try {
          await chrome.cookies.remove({ url: cookieUrl, name: c.name, storeId: c.storeId });
        } catch {
          /* ignore individual cookie removal failures */
        }
      }
    }
  } catch (e) {
    console.warn('[Scopus Session] Manual cookie sweep failed:', e?.message || e);
  }

  // Reload the tab back to the original Scopus profile URL.
  // The original URL may have included #scopus-task-id=<id> hash.
  const profileUrl = `https://www.scopus.com/authid/detail.uri?authorId=${encodeURIComponent(externalId)}#scopus-task-id=${taskId}`;
  try {
    // Reset readiness flag so the next SCRAPE_READY is honored
    const entry = pendingTabs.get(tabId);
    if (entry) {
      entry.readyAt = null;
      resetScrapeTimeout(tabId);
    }
    await chrome.tabs.update(tabId, { url: profileUrl });
    console.log(`[Scopus Session] Tab #${tabId} reloaded to ${profileUrl}`);
  } catch (e) {
    console.warn('[Scopus Session] Tab update failed:', e?.message || e);
  }
}

/**
 * Reports a login/session-state transition to the broker so the backend can
 * decide whether to keep waiting on a stuck task. Best-effort — failures are
 * logged but never thrown (a flaky network shouldn't break the scrape).
 *
 * @param {string} source  WOS | SCOPUS | SCHOLAR
 * @param {string} event   LOGIN_DETECTED | LOGIN_IN_PROGRESS | LOGIN_SUCCESS | LOGIN_FAILED
 * @param {string} [detail]
 */
async function postSessionEvent(source, event, detail) {
  try {
    const headers = await brokerHeaders();
    await fetch(`${API_BASE}/api/session-events`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ source, event, detail: detail || '' }),
    });
    console.log(`[Session] reported ${source}/${event}`);
  } catch (e) {
    console.warn(`[Session] Failed to post ${source}/${event}:`, e?.message || e);
  }
}

/**
 * Resolves the post-login retry URL for the given WoS tab and triggers
 * a tab.update navigation to it. Idempotent — both the WOS_LOGIN_SUCCESS
 * message handler and the WOS_CHECK_POST_LOGIN handler call into here,
 * and storage flags are consumed exactly once.
 *
 * @param {number} tabId   the tab to navigate
 * @param {string} [tabUrl] the tab's current URL (best-effort fallback)
 */
async function handleWosLoginSuccess(tabId, tabUrl) {
  if (tabId == null) return;
  const entry = pendingTabs.get(tabId);

  // Priority 1: the URL the user was on when login was triggered. The
  // session handler now saves this on every sign-in path (button,
  // dropdown, force-navigate), so it should virtually always be set.
  // Also consume the wos_login_pending breadcrumb so a double-fire
  // (pre-nav best-effort + post-nav storage trigger) doesn't navigate
  // twice. Both flags survive the form-submit redirect; first
  // consumer wins.
  let returnUrl = null;
  let hadAnyFlag = false;
  try {
    const stored = await chrome.storage.session.get(['wos_return_url', 'wos_login_pending']);
    returnUrl = stored.wos_return_url || null;
    const toRemove = [];
    if (stored.wos_return_url != null) toRemove.push('wos_return_url');
    if (stored.wos_login_pending != null) toRemove.push('wos_login_pending');
    hadAnyFlag = toRemove.length > 0;
    if (toRemove.length > 0) {
      await chrome.storage.session.remove(toRemove);
    }
  } catch (e) {
    console.warn('[WoS Session] Could not read return URL:', e);
  }

  // Dedup: if no flag was set, this is a duplicate delivery. Skip.
  if (!hadAnyFlag) {
    console.log('[WoS Session] handleWosLoginSuccess: both flags already consumed, skipping (dedup)');
    return;
  }

  // Priority 2: derive from pendingTabs entry. SAFE only when the task
  // is an author-profile scrape (FULL_SCRAPE on /wos/author/record/).
  // For article-detail / citation-report tasks the externalId is a DOI
  // or article id and the wos/author/record/<id> URL would be wrong.
  let retryUrl = returnUrl;
  if (!retryUrl && entry?.externalId && entry?.source === 'WOS' &&
      (entry.taskType === 'FULL_SCRAPE' || !entry.taskType)) {
    const baseUrl = `https://www.webofscience.com/wos/author/record/${encodeURIComponent(entry.externalId)}`;
    retryUrl = `${baseUrl}#wos-task-id=${entry.taskId}`;
  }

  // Priority 3: whatever URL the tab is currently on. Last-ditch.
  if (!retryUrl) retryUrl = tabUrl;

  // Sanity: never navigate back to a login URL (would loop).
  if (retryUrl && (retryUrl.includes('access.clarivate.com')
          || retryUrl.includes('/login')
          || retryUrl.includes('/signin'))) {
    console.warn('[WoS Session] retryUrl looks like a login page, skipping navigation:', retryUrl);
    retryUrl = null;
  }

  // Always re-stamp the task-id hash. The saved returnUrl (Priority 1)
  // is captured at the time of sign-in click — by then Angular's
  // router has often dropped any URL hash, so the stored value is
  // hash-less. Without the hash, content.js's getTaskId() falls back
  // to GET_TASK_INFO, which CAN race the navigation: the tab's
  // chrome.storage.session entry is still present, but if anything
  // cleared it (the recovery flow's various edge cases), content.js
  // exits silently as "Task ID bulunamadı" and the scrape never
  // restarts. Re-stamping is cheap and idempotent.
  if (retryUrl && entry?.taskId) {
    const hashKey = `wos-task-id=${entry.taskId}`;
    if (!retryUrl.includes(hashKey)) {
      const hashPos = retryUrl.indexOf('#');
      const base = hashPos >= 0 ? retryUrl.slice(0, hashPos) : retryUrl;
      retryUrl = `${base}#${hashKey}`;
    }
  }

  if (!retryUrl) {
    addLog('WoS session restored but no return URL — tab will stay where it is', 'warning');
    return;
  }

  console.log(`[WoS Session] Login success on tab #${tabId}, navigating to: ${retryUrl}`);
  addLog('WoS session restored, retrying scrape on original URL', 'success');
  if (entry) {
    entry.readyAt = null; // allow next SCRAPE_READY from reloaded content.js
    resetScrapeTimeout(tabId); // extend the overall task timeout
  }

  try {
    await chrome.tabs.update(tabId, { url: retryUrl });
    console.log(`[WoS Session] Tab #${tabId} navigated to restart scraping.`);
  } catch (e) {
    console.warn('[WoS Session] Tab update failed:', e?.message || e);
  }
}

function resetScrapeTimeout(tabId) {
  // Always cleanup old timeout first, even if exception occurs
  if (scrapeTimeouts.has(tabId)) {
    try {
      clearTimeout(scrapeTimeouts.get(tabId));
    } catch (e) {
      console.warn(`[Cleanup] Error clearing old timeout for tab ${tabId}:`, e);
    }
    scrapeTimeouts.delete(tabId);
  }

  const entry = pendingTabs.get(tabId);
  if (entry) {
    try {
      const newTimeout = setTimeout(() => {
        const current = pendingTabs.get(tabId);
        if (current && current.taskId === entry.taskId) {
          handleTaskTimeout(tabId);
        }
      }, SCRAPE_TIMEOUT_MS);
      scrapeTimeouts.set(tabId, newTimeout);
    } catch (e) {
      console.error(`[Cleanup] Failed to set new timeout for tab ${tabId}:`, e);
      scrapeTimeouts.delete(tabId); // Fail-safe
    }
  }
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
  cleanupOnStartup('install').catch(e => console.warn('[Startup] cleanup failed:', e?.message || e));
});

// Service worker boot: when Chrome wakes the worker after idle / browser
// restart / extension reload, the in-memory pending* maps are gone but
// browser tabs from prior runs may still be open. Without cleanup, those
// tabs become orphaned (no taskId → no scrape → eventually time out).
chrome.runtime.onStartup.addListener(() => {
  cleanupOnStartup('browser-start').catch(e => console.warn('[Startup] cleanup failed:', e?.message || e));
});

/**
 * Closes any leftover bot tabs from a prior session and clears persisted
 * worker-window/task state so the next sync starts fresh.
 */
async function cleanupOnStartup(reason) {
  console.log(`[Startup] Running cleanup (reason: ${reason})`);

  // 1. If a worker window persists from a prior run, close it. We don't try
  //    to reuse it: its tabs have lost their pendingTabs entries and would
  //    just sit there idle.
  try {
    const wins = await chrome.windows.getAll({ populate: false });
    for (const w of wins) {
      // Heuristic: any window opened by us would have a single about:blank
      // initially or hold our task-hash URLs. Safer: scan all windows for
      // tabs whose URL looks like a bot task and close those tabs.
    }
  } catch (_) { /* ignore */ }

  // 2. Sweep all tabs across all windows for stale bot task URLs (those
  //    carrying our task-id hash). Without an in-memory entry tracking them,
  //    they'd never resolve — close them.
  try {
    const allTabs = await chrome.tabs.query({});
    let closed = 0;
    for (const t of allTabs) {
      const u = t.url || t.pendingUrl || '';
      if (u.includes('wos-task-id=')
          || u.includes('scopus-task-id=')
          || u.includes('scholar-task-id=')
          || u.includes('plumx-task-id=')
          || u.includes('wos-doi-task-id=')
          || u.includes('scholar-doi-task-id=')
          || u.includes('citation-report-task-id=')) {
        try { await chrome.tabs.remove(t.id); closed++; } catch (_) { /* ignore */ }
      }
    }
    if (closed > 0) console.log(`[Startup] Closed ${closed} orphan bot tabs`);
  } catch (_) { /* ignore */ }

  // 3. Wipe task-info entries persisted in storage.session.
  try {
    const all = await chrome.storage.session.get(null);
    const keysToRemove = Object.keys(all).filter(k =>
      /^\d+$/.test(k)                   // numeric tab-id keys
      || k.startsWith('scopus_recovery_') // recovery counters
      || k === 'wos_return_url');
    if (keysToRemove.length > 0) {
      await chrome.storage.session.remove(keysToRemove);
      console.log(`[Startup] Cleared ${keysToRemove.length} stale session keys`);
    }
  } catch (_) { /* ignore */ }
}

// ═══════════════════════════════════════════════
//  PHASE-BASED ORCHESTRATOR (WOS → SCOPUS+PLUMX → SCHOLAR)
// ═══════════════════════════════════════════════

async function checkTabExists(tabId) {
  if (tabId === null) return false;
  try {
    const tab = await chrome.tabs.get(tabId);
    return !!tab;
  } catch (e) {
    return false;
  }
}

async function isWosPhaseActive() {
  if (activeWosJobs.profileTab !== null) {
    if (await checkTabExists(activeWosJobs.profileTab)) return true;
    console.warn(`[Orchestrator] WOS profile tab #${activeWosJobs.profileTab} no longer exists. Clearing.`);
    activeWosJobs.profileTab = null;
  }
  
  if (activeWosJobs.detailTabs.size > 0) {
    const activeDetails = [];
    for (const tid of activeWosJobs.detailTabs) {
      if (await checkTabExists(tid)) activeDetails.push(tid);
    }
    if (activeDetails.length > 0) {
      if (activeDetails.length !== activeWosJobs.detailTabs.size) {
        activeWosJobs.detailTabs = new Set(activeDetails);
      }
      return true;
    }
    activeWosJobs.detailTabs.clear();
  }

  if (activeWosJobs.citationReportTab !== null) {
    if (await checkTabExists(activeWosJobs.citationReportTab)) return true;
    activeWosJobs.citationReportTab = null;
  }

  return false;
}

async function isScopusPhaseActive() {
  if (activeProfileTask !== null && activeProfileTask.source === 'SCOPUS') {
    // Try to find the tab associated with this task
    for (const [tabId, entry] of pendingTabs.entries()) {
      if (entry.taskId === activeProfileTask.taskId) {
        if (await checkTabExists(tabId)) return true;
        console.warn(`[Orchestrator] Scopus tab #${tabId} for task ${entry.taskId} no longer exists. Clearing.`);
        clearPendingTab(tabId);
        return false;
      }
    }
    return true; // Assume active if task exists but tab lookup failed (might be starting up)
  }
  return false;
}

async function isPlumxPhaseActive() {
  if (pendingPlumx.size > 0) {
    const activePlumx = [];
    for (const [tid, info] of pendingPlumx.entries()) {
      if (await checkTabExists(tid)) activePlumx.push([tid, info]);
    }
    if (activePlumx.length > 0) {
      if (activePlumx.length !== pendingPlumx.size) {
        pendingPlumx.clear();
        activePlumx.forEach(([tid, info]) => pendingPlumx.set(tid, info));
      }
      return true;
    }
    pendingPlumx.clear();
  }
  return false;
}

async function isScholarPhaseActive() {
  if (activeProfileTask !== null && activeProfileTask.source === 'SCHOLAR') {
    for (const [tabId, entry] of pendingTabs.entries()) {
      if (entry.taskId === activeProfileTask.taskId) {
        if (await checkTabExists(tabId)) return true;
        console.warn(`[Orchestrator] Scholar tab #${tabId} for task ${entry.taskId} no longer exists. Clearing.`);
        clearPendingTab(tabId);
        return false;
      }
    }
    return true;
  }
  return false;
}

async function pollScrapeSource(source) {
  if (activeProfileTask !== null) {
    return false;
  }
  try {
    const headers = await brokerHeaders();
    const res = await fetchWithRetry(`${API_BASE}/api/tasks/poll?source=${source}`, { headers });
    if (res.status === 204 || !res.ok) return false;

    const data = await res.json();
    if (data?.taskId) {
      const { taskId, externalId, source: respSource, redirectUrl, taskType } = data;
      const effectiveSource = respSource || source;

      if (taskId != null && externalId) {
        console.log(`[Orchestrator] New ${effectiveSource} task. ID: ${taskId}, ExtID: ${externalId}`);

        activeProfileTask = {
          taskId,
          source: effectiveSource,
          externalId,
          taskType: taskType || 'FULL_SCRAPE'
        };

        updateSyncProgress(effectiveSource, 'RUNNING');
        diagAddTask(taskId, effectiveSource, externalId, taskType || 'FULL_SCRAPE');

        updateState({
          status: 'INITIALIZING',
          taskId,
          targetId: externalId,
          progress: { current: 0, total: 0, label: `Initializing ${effectiveSource} task...` },
          stats: { pagesScanned: 0, articlesFound: 0, detailsExtracted: 0 }
        });
        addLog(`New ${effectiveSource} Task (ID: ${taskId})`, 'success');

        await humanDelay(800, 2500);
        await openTaskTab(taskId, externalId, effectiveSource, redirectUrl || null, taskType || 'FULL_SCRAPE');
        return true;
      }
    }
    return false;
  } catch (err) {
    console.warn(`[Orchestrator] ${source} poll failed:`, err);
    return false;
  }
}

// ── Legacy phase functions removed ─────────────────────────────────
// runOpenAlexPhase / runWosPhase / runScopusPlumxPhase / runScholarPhase
// were a state-machine over `currentPhase`. They had a subtle bug: if
// the worker idled at phase 3 (Scholar) and a new sync queued tasks
// for all phases, phase 3 would claim the fresh Scholar task before
// phase 0 (OpenAlex) got a chance — breaking the ordering contract.
// Replaced by stateless `run*PhaseInline` predicates called from
// `runPriorityOrchestrator` in priority order on every tick.

/**
 * Stateless top-level orchestrator. Each tick walks the priority chain
 * from highest (OpenAlex) to lowest (Scholar), stopping at the first
 * phase that has work or is in flight. Replaces the old
 * {@code currentPhase} state machine, which carried over from previous
 * cycles — if the worker happened to be sitting at phase 3 (Scholar)
 * when a new sync request landed, it would claim a fresh Scholar task
 * before checking OpenAlex/WoS/Scopus, breaking the documented
 *  OPENALEX → WOS → SCOPUS+PLUMX → SCHOLAR  ordering.
 *
 * <p>Now: every tick re-checks the chain from the top, so a fresh sync
 * is guaranteed to start at OpenAlex regardless of where the worker
 * idled in the previous cycle.
 *
 * <p>Each phase helper returns:
 * <ul>
 *   <li>{@code "busy"}    — phase has a tab/task in flight, wait & retry</li>
 *   <li>{@code "picked"}  — phase claimed a fresh task, pipeline running</li>
 *   <li>{@code "drained"} — phase has nothing to do, fall through</li>
 * </ul>
 *
 * "busy" and "picked" are both terminal for this tick (don't try later
 * phases) since profile-tab phases share {@code activeProfileTask} and
 * we can only run one tab at a time. OpenAlex is the only exception —
 * it uses its own slot, so a busy OpenAlex doesn't block lower phases…
 * but per the product spec we still gate them on it (publications
 * baseline must be in stagedData before WoS enrichment can attach).
 */
async function runPriorityOrchestrator() {
  if (detailRateLimited || plumxRateLimited) {
    scheduleOrchestrator(jitteredInterval(30000, 20));
    return;
  }

  // ── Phase 0: OpenAlex ───────────────────────────────────────────
  // Drain OpenAlex completely before touching profile tabs so the
  // publications baseline is in stagedData when WoS/Scopus/Scholar
  // arrive to enrich it. activeOpenAlexTask is set inside pollOpenAlex
  // and cleared in its finally block, so a return-true here means the
  // task is done synchronously.
  if (GROUP_CONFIG.openalex !== false) {
    if (activeOpenAlexTask !== null) {
      // Still processing the current OpenAlex task.
      scheduleOrchestrator(jitteredInterval(POLL_INTERVAL_ACTIVE_MS, 30));
      return;
    }
    const oaPicked = await pollOpenAlex();
    if (oaPicked) {
      scheduleOrchestrator(jitteredInterval(POLL_INTERVAL_ACTIVE_MS, 30));
      return;
    }
    // OpenAlex drained → fall through to profile phases.
  }

  // ── Phase 1: WOS ────────────────────────────────────────────────
  const wosState = await runWosPhaseInline();
  if (wosState !== 'drained') {
    scheduleOrchestrator(jitteredInterval(POLL_INTERVAL_ACTIVE_MS, 30));
    return;
  }

  // ── Phase 1.5: Citation Report retries ─────────────────────────
  // Operator-triggered retries (or any task that ended up PENDING in
  // the broker without an active author scrape — e.g. a previously
  // FAILED row reset to PENDING) get picked up here, AFTER all WoS
  // author/detail work is drained so the new tab doesn't compete with
  // an in-progress scrape.
  const crState = await runCitationReportPhaseInline();
  if (crState !== 'drained') {
    scheduleOrchestrator(jitteredInterval(POLL_INTERVAL_ACTIVE_MS, 30));
    return;
  }

  // ── Phase 2: SCOPUS first, PLUMX after ──────────────────────────
  const scopusState = await runScopusPhaseInline();
  if (scopusState !== 'drained') {
    scheduleOrchestrator(jitteredInterval(POLL_INTERVAL_ACTIVE_MS, 30));
    return;
  }
  const plumxState = await runPlumxPhaseInline();
  if (plumxState !== 'drained') {
    scheduleOrchestrator(jitteredInterval(POLL_INTERVAL_ACTIVE_MS, 30));
    return;
  }

  // ── Phase 3: SCHOLAR ────────────────────────────────────────────
  const scholarState = await runScholarPhaseInline();
  if (scholarState !== 'drained') {
    scheduleOrchestrator(jitteredInterval(POLL_INTERVAL_ACTIVE_MS, 30));
    return;
  }

  // Everything drained — back to slow idle poll.
  scheduleOrchestrator(jitteredInterval(POLL_INTERVAL_IDLE_MS, 20));
}

/* ═══════════════════════════════════════════════
 *  WOS SESSION PRE-FLIGHT
 * ═══════════════════════════════════════════════
 *
 *  Before opening any WoS author / detail / citation-report tab the
 *  worker now verifies that a logged-in WoS session is available.
 *  Without this check, every cold-start scrape would land on the
 *  free-view banner, force the session_handler into reactive mode,
 *  bounce the tab through the Clarivate login URL, and only then
 *  resume the scrape — losing 10–30s per task and sometimes failing
 *  the scrape entirely if the redirect chain races content.js.
 *
 *  Strategy: open a hidden basic-search tab tagged with
 *  {@code #wos-session-probe=1}; the existing session_handler runs
 *  there and either:
 *    • detects an authenticated page → emits {@code WOS_SESSION_OK}
 *    • detects free-view / Sign In → runs the same login flow it
 *      already runs on task tabs, and the post-login breadcrumb
 *      fires {@code WOS_LOGIN_SUCCESS} which we treat as "session
 *      verified" too.
 *  The probe tab is then closed and the cached status is reused for
 *  {@code WOS_SESSION_TTL_MS} so subsequent tasks don't pay the
 *  probe cost.
 */
const WOS_SESSION_PROBE_FLAG = 'wos-session-probe=1';
const WOS_SESSION_PROBE_URL =
    'https://www.webofscience.com/wos/woscc/basic-search#' + WOS_SESSION_PROBE_FLAG;
// Cache the verified session for 25 min — well under the typical WoS
// session lifetime (~hours) but short enough that a logout while the
// worker is idle gets re-detected before the next batch.
const WOS_SESSION_TTL_MS = 25 * 60 * 1000;
const WOS_SESSION_PROBE_TIMEOUT_MS = 90_000;
let wosSession = {
  status: 'unknown',     // 'unknown' | 'checking' | 'authenticated' | 'expired'
  lastVerifiedAt: 0,
  pendingProbeTabId: null,
  pendingResolve: null,
  pendingTimeoutId: null,
};

/**
 * Waits until {@code chrome.tabs.get(tabId).status === 'complete'} or
 * the timeout expires. Used to time the post-load DOM check so we
 * don't try to query the page mid-bootstrap.
 */
function waitForTabComplete(tabId, timeoutMs) {
  return new Promise((resolve, reject) => {
    let done = false;
    const finish = (ok, err) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(onUpdated);
      ok ? resolve() : reject(err || new Error('timeout'));
    };
    const onUpdated = (changedId, info) => {
      if (changedId === tabId && info.status === 'complete') finish(true);
    };
    const timer = setTimeout(() => finish(false, new Error('tab load timeout')), timeoutMs);
    chrome.tabs.onUpdated.addListener(onUpdated);
    // The tab may already be 'complete' before we attached the listener.
    chrome.tabs.get(tabId).then(t => {
      if (t && t.status === 'complete') finish(true);
    }).catch(() => { /* tab gone — let timer handle it */ });
  });
}

/**
 * Reads the probe tab's DOM directly via {@code chrome.scripting.executeScript}
 * to decide whether the session is logged in. We can't rely on the
 * session_handler messaging path alone — Angular strips the URL hash
 * during bootstrap, so any flag we put on the URL might be gone by the
 * time the handler runs. Polling the DOM from background avoids that
 * whole class of race conditions: if "Sign In" / login form / free-view
 * banner are absent and the body actually rendered, we're logged in.
 *
 * Returns one of:
 *   - {logged: true,  reason}      → session is active
 *   - {logged: false, reason}      → login required (session_handler
 *                                    will run its own login flow next)
 *   - null                          → check failed (script error / tab gone)
 */
async function probeWosLoggedInState(tabId) {
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => {
        const txt = (document.body && document.body.innerText || '').toLowerCase();
        const hasFreeView =
            txt.includes('you are accessing a free view of the web of science')
            || txt.includes('web of science free view');
        const loginForm = !!document.querySelector(
            'input[name="email"], input[formcontrolname="email"], input#mat-input-1');
        // "Sign In" control: walk visible buttons/links.
        let hasSignIn = false;
        const candidates = document.querySelectorAll('button, a, [role="button"], mat-menu-item');
        for (const el of candidates) {
          const own = (el.textContent || '').replace(/\s+/g, ' ').trim().toLowerCase();
          if (own === 'sign in' || own === 'sign in »') {
            const r = el.getBoundingClientRect();
            const cs = window.getComputedStyle(el);
            if (r.width > 0 && r.height > 0
                && cs.display !== 'none' && cs.visibility !== 'hidden') {
              hasSignIn = true;
              break;
            }
          }
        }
        return {
          hasFreeView,
          loginForm,
          hasSignIn,
          bodyLen: txt.length,
          host: location.host,
          path: location.pathname,
        };
      },
    });
    const r = results && results[0] && results[0].result;
    if (!r) return null;
    // If we're still on a Clarivate auth domain, the redirect chain
    // hasn't finished — treat as "not yet decided" and let the timeout
    // / session_handler login flow handle it.
    if (r.host && r.host.includes('clarivate.com')) {
      return { logged: false, reason: 'on auth domain', detail: r };
    }
    if (r.bodyLen < 50) {
      return { logged: false, reason: 'body not rendered', detail: r };
    }
    if (r.hasFreeView || r.hasSignIn || r.loginForm) {
      return { logged: false, reason: 'auth UI visible', detail: r };
    }
    return { logged: true, reason: 'no auth UI', detail: r };
  } catch (e) {
    console.warn('[WoS Session] Probe DOM check failed:', e?.message || e);
    return null;
  }
}

/**
 * Resolves true if a usable WoS session is available, false otherwise.
 * Caches the answer; the orchestrator can call this on every WoS phase
 * tick and only the first one (or the one after TTL expiry) actually
 * opens a probe tab.
 */
async function ensureWosSession() {
  const now = Date.now();
  if (wosSession.status === 'authenticated'
      && (now - wosSession.lastVerifiedAt) < WOS_SESSION_TTL_MS) {
    return true;
  }
  if (wosSession.status === 'checking' && wosSession.pendingResolve) {
    // A probe is already in flight — chain onto its resolve.
    return new Promise(resolve => {
      const orig = wosSession.pendingResolve;
      wosSession.pendingResolve = (ok) => { orig(ok); resolve(ok); };
    });
  }

  wosSession.status = 'checking';
  let resolveFn;
  const probePromise = new Promise(r => { resolveFn = r; });
  wosSession.pendingResolve = resolveFn;

  let winId = null;
  try { winId = await getOrCreateWorkerWindow(); } catch (_) { /* fall back to default window */ }
  const opts = { url: WOS_SESSION_PROBE_URL, active: false };
  if (winId != null) opts.windowId = winId;
  let tab;
  try {
    tab = await chrome.tabs.create(opts);
    wosSession.pendingProbeTabId = tab.id;
    if (winId != null) { await dismissWorkerPlaceholder(); await sweepBlankTabsInWorker(tab.id); }
    addLog('[WoS Session] Pre-flight session probe started', 'info');
  } catch (e) {
    console.warn('[WoS Session] Probe tab creation failed:', e?.message || e);
    finishWosProbe(false);
    return probePromise;
  }

  // Belt-and-suspenders timeout — if the DOM-poll loop below somehow
  // hangs and no message lands either, this fires and prevents the
  // orchestrator from stalling forever.
  wosSession.pendingTimeoutId = setTimeout(() => {
    if (wosSession.pendingResolve) {
      console.warn('[WoS Session] Probe timed out after',
          WOS_SESSION_PROBE_TIMEOUT_MS, 'ms');
      finishWosProbe(false);
    }
  }, WOS_SESSION_PROBE_TIMEOUT_MS);

  // Run the DOM-check loop in the background. Don't await it — we want
  // the probe to also be resolvable by inbound WOS_LOGIN_SUCCESS /
  // WOS_SESSION_OK messages (which finishWosProbe respects via the
  // pendingResolve check). The first one to call finishWosProbe wins.
  (async () => {
    try {
      await waitForTabComplete(tab.id, 25_000);
    } catch (_) { /* fall through to polling */ }
    // Give Angular a few seconds to bootstrap before the first DOM read.
    // Then poll up to 6 times at 2s intervals — if a redirect chain is
    // still in flight (Clarivate auth → WoS), we'll catch the final
    // state. session_handler may run its own login flow during this
    // window; if so the resulting WOS_LOGIN_SUCCESS lands first and
    // we exit early via finishWosProbe.
    await new Promise(r => setTimeout(r, 2500));
    for (let i = 0; i < 6; i++) {
      if (!wosSession.pendingResolve) return; // already resolved by message handler
      const verdict = await probeWosLoggedInState(tab.id);
      if (verdict) {
        if (verdict.logged) {
          console.log('[WoS Session] Probe DOM check: logged in');
          if (wosSession.pendingResolve) finishWosProbe(true);
          return;
        }
        // Not logged in yet — but session_handler may be running the
        // login flow. Don't fail-fast on the first negative read; give
        // the login a few cycles to complete (each cycle takes 5–15s in
        // session_handler — Angular form-fill + submit + redirect).
        if (verdict.reason === 'auth UI visible' && i >= 5) {
          console.log('[WoS Session] Probe DOM check: still on auth UI after 5 polls — failing');
          if (wosSession.pendingResolve) finishWosProbe(false);
          return;
        }
        // 'on auth domain' / 'body not rendered' → keep waiting.
      }
      await new Promise(r => setTimeout(r, 3000));
    }
    // Loop ended without verdict — leave it to the hard timeout.
  })().catch(e => console.warn('[WoS Session] DOM probe loop error:', e?.message || e));

  return probePromise;
}

/**
 * Closes the probe tab, updates cached status, resolves the pending
 * promise. Idempotent — calling twice with conflicting outcomes will
 * keep the first answer.
 */
function finishWosProbe(ok) {
  if (wosSession.pendingTimeoutId != null) {
    clearTimeout(wosSession.pendingTimeoutId);
    wosSession.pendingTimeoutId = null;
  }
  if (wosSession.pendingProbeTabId != null) {
    const tabId = wosSession.pendingProbeTabId;
    wosSession.pendingProbeTabId = null;
    chrome.tabs.remove(tabId).catch(() => { /* tab may already be gone */ });
  }
  wosSession.status = ok ? 'authenticated' : 'expired';
  wosSession.lastVerifiedAt = Date.now();
  if (wosSession.pendingResolve) {
    const resolve = wosSession.pendingResolve;
    wosSession.pendingResolve = null;
    resolve(ok);
  }
  addLog(ok ? '[WoS Session] Pre-flight OK — session is active'
            : '[WoS Session] Pre-flight failed — proceeding without verified login',
         ok ? 'success' : 'warning');
}

// Cooldown after a failed pre-flight probe before retrying. Without
// this the orchestrator would re-open a probe tab on every tick (the
// cache miss as soon as the previous probe is marked `expired`),
// burning resources and blocking the other source phases. 60s is long
// enough to let a transient failure resolve (network blip, slow
// Angular load) without making the user wait minutes for a real
// re-probe after a logout.
const WOS_SESSION_RETRY_BACKOFF_MS = 60_000;

/** WoS phase as a stateless predicate. */
async function runWosPhaseInline() {
  if (!GROUP_CONFIG.wos) return 'drained';
  if (await isWosPhaseActive()) return 'busy';
  // Backoff: if we just failed a probe, skip WoS this tick so other
  // phases (Scopus / Scholar / PlumX / OpenAlex) keep moving. The
  // probe itself will be retried after the cooldown expires.
  if (wosSession.status === 'expired'
      && (Date.now() - wosSession.lastVerifiedAt) < WOS_SESSION_RETRY_BACKOFF_MS) {
    return 'drained';
  }
  // Pre-flight: make sure we have a logged-in WoS session BEFORE
  // opening a task tab. Otherwise the task tab lands on the free-view
  // banner and the redirect dance eats half the scrape window.
  const sessionOk = await ensureWosSession();
  if (!sessionOk) {
    // Probe failed — return 'drained' so the orchestrator continues
    // to the other phases. The backoff above prevents another probe
    // from firing for the next 60s.
    return 'drained';
  }
  const picked = await pollScrapeSource('WOS');
  return picked ? 'picked' : 'drained';
}

/**
 * Citation Report phase. Pulls one PENDING task from the broker and
 * opens its URL in a fresh tab. Used for operator-triggered retries
 * and for tasks that ended up PENDING without an inline trigger from
 * {@code finalizeAndComplete} (e.g. announce arrived but the worker
 * crashed before opening the tab).
 *
 * <p>Returns:
 * <ul>
 *   <li>{@code 'busy'}    — there's already a citation-report tab open</li>
 *   <li>{@code 'picked'}  — claimed a task and opened a tab</li>
 *   <li>{@code 'drained'} — broker has nothing PENDING for us</li>
 * </ul>
 */
async function runCitationReportPhaseInline() {
  if (!GROUP_CONFIG.wos) return 'drained';
  // Don't open a second citation-report tab while one is still active
  // — the per-paper times-cited table needs the tab focused, and racing
  // two would just timeout one.
  if (activeWosJobs.citationReportTab !== null) return 'busy';
  if (pendingCitationReportTabs.size > 0) return 'busy';

  let task;
  try {
    const h = await brokerHeaders();
    const resp = await fetch(`${API_BASE}/api/citation-report-tasks/poll?batchSize=1`, {
      method: 'GET',
      headers: h,
    });
    if (resp.status === 204) return 'drained';
    if (!resp.ok) {
      console.warn('[Citation Report] poll returned HTTP', resp.status);
      return 'drained';
    }
    const arr = await resp.json();
    if (!Array.isArray(arr) || arr.length === 0) return 'drained';
    task = arr[0];
  } catch (err) {
    console.warn('[Citation Report] poll failed:', err?.message || err);
    return 'drained';
  }

  // Open a tab and inject the scraper. Use a synthetic article-task id
  // (the broker task id itself) for the URL hash since we no longer have
  // the originating WoS author scrape's task.
  const fakeAuthorTaskId = `cr-${task.taskId}`;
  // Stash citationReportTaskId so handleCitationReportComplete can find it.
  // We do NOT use savedCitationReportLinks here because that map keys on
  // the WoS author scrape's task id, which we don't have for retries.
  const opened = await handleCitationReportLinkFound(
      fakeAuthorTaskId,
      task.citationReportUrl,
      task.authorWosId || '',
      task.taskId);
  if (opened && opened.ok) {
    addLog(`Citation Report retry started (broker task #${task.taskId})`, 'info');
    return 'picked';
  }
  // Couldn't open the tab — mark task FAILED so it doesn't sit in PROCESSING
  // forever (the broker flipped it on poll).
  await reportCitationReportFailure(task.taskId,
      'Worker could not open the citation-report tab: '
      + (opened && opened.error ? opened.error : 'unknown'));
  return 'drained';
}

/** Scopus author profile (METRICS_ONLY by default). */
async function runScopusPhaseInline() {
  if (!GROUP_CONFIG.scopusPlumx) return 'drained';
  if (await isScopusPhaseActive()) return 'busy';
  const picked = await pollScrapeSource('SCOPUS');
  return picked ? 'picked' : 'drained';
}

/** PlumX per-DOI batch pool. */
async function runPlumxPhaseInline() {
  if (!GROUP_CONFIG.scopusPlumx) return 'drained';
  if (await isPlumxPhaseActive()) return 'busy';
  const picked = await pollPlumx();
  return picked ? 'picked' : 'drained';
}

/** Scholar author profile. */
async function runScholarPhaseInline() {
  if (!GROUP_CONFIG.scholar) return 'drained';
  if (await isScholarPhaseActive()) return 'busy';
  const picked = await pollScrapeSource('SCHOLAR');
  return picked ? 'picked' : 'drained';
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
//  TAB REMOVAL LISTENER — prevents stale state when user closes tabs
// ═══════════════════════════════════════════════

chrome.tabs.onRemoved.addListener(async (tabId) => {
  console.log(`[WoS Worker] Tab #${tabId} closed by user/browser, cleaning up state...`);

  // Report task failure to broker before clearing local state
  const entry = pendingTabs.get(tabId);
  if (entry && entry.taskId && entry.type !== 'DETAIL') {
    try {
      const h = await brokerHeaders();
      await fetch(`${API_BASE}/api/tasks/${entry.taskId}/fail`, {
        method: 'POST', headers: h,
        body: JSON.stringify({ error: 'Tab closed unexpectedly' }),
      });
      console.log(`[WoS Worker] Reported task ${entry.taskId} as failed (tab closed)`);
    } catch (e) {
      console.warn(`[WoS Worker] Failed to report task failure for tab #${tabId}:`, e);
    }
  }

  clearPendingTab(tabId);
  pendingPlumx.delete(tabId);
  pendingWosDoiTabs.delete(tabId);
  pendingScholarDoiTabs.delete(tabId);
  pendingCitationReportTabs.delete(tabId);
  savedCitationReportLinks.delete(tabId);
  // Also clear citation report tab from activeWosJobs if it was closed directly
  if (activeWosJobs.citationReportTab === tabId) {
    activeWosJobs.citationReportTab = null;
    console.log(`[WoS Worker] Citation report tab #${tabId} removed, cleared activeWosJobs.citationReportTab`);
  }
  for (const [taskId, job] of detailJobs.entries()) {
    if (job.activeTabIds.has(tabId)) {
      job.activeTabIds.delete(tabId);
      job.tabToUrlMap.delete(tabId);
      fillDetailTabPool(taskId);
    }
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

/**
 * Polls and resolves any pending OpenAlex tasks. Unlike WOS/Scopus/Scholar
 * (which need a browser tab to scrape), OpenAlex serves a public JSON API
 * — we hit it directly from the service worker. No tab opened, no DOM,
 * no rate-limit concerns at our scale (~1 author + ~100 works per call).
 *
 * <p>Idempotent + non-blocking: doesn't take {@code activeProfileTask}
 * because it doesn't compete with the browser-tab pipeline.
 */
/**
 * Slot for the active OpenAlex task. Mirrors {@code activeProfileTask} so
 * the orchestrator can guarantee OpenAlex finishes BEFORE WoS/Scopus/Scholar
 * tabs open — OpenAlex sets the publication baseline (DOIs, titles, years)
 * that the other sources just enrich with citations / index info.
 */
let activeOpenAlexTask = null;

async function pollOpenAlex() {
  if (activeOpenAlexTask) return false;
  try {
    const headers = await brokerHeaders();
    const res = await fetch(`${API_BASE}/api/tasks/poll?source=OPENALEX`, { headers });
    if (res.status === 204 || !res.ok) return false;
    const data = await res.json();
    if (!data?.taskId || !data?.externalId) return false;

    activeOpenAlexTask = data;
    try {
      // Run synchronously — caller awaits, ordering downstream is preserved.
      await processOpenAlexTask(data);
    } catch (e) {
      console.warn('[OpenAlex] Task processing failed:', e?.message || e);
    } finally {
      activeOpenAlexTask = null;
    }
    return true;
  } catch (e) {
    console.warn('[OpenAlex] Poll failed:', e?.message || e);
    return false;
  }
}

async function processOpenAlexTask(task) {
  const { taskId, externalId, taskType } = task;
  // METRICS_ONLY: skip the works fetch entirely; just refresh the
  // author summary stats (hIndex / citations / documents / i10Index).
  // Used by the operator panel's source-level "Tekrar Çek" button so
  // we can update the dashboard chips without re-scraping the full
  // publication catalogue (which would race merge logic and risk
  // wiping operator edits).
  const metricsOnly = taskType === 'METRICS_ONLY';
  console.log(`[OpenAlex] Processing task ${taskId} for ORCID: ${externalId} (${metricsOnly ? 'METRICS_ONLY' : 'FULL_SCRAPE'})`);
  addLog(`OpenAlex task started (ID: ${taskId}, ORCID: ${externalId}, ${metricsOnly ? 'metrics-only' : 'full'})`, 'info');

  const cleanedOrcid = stripOrcidPrefix(externalId);
  const ua = 'rdlsis-worker (mailto:rdlsis@example.com)';

  // 1) Author endpoint
  let author;
  try {
    const url = `https://api.openalex.org/authors/orcid:${encodeURIComponent(cleanedOrcid)}?mailto=rdlsis@example.com`;
    const r = await fetch(url, { headers: { 'User-Agent': ua, Accept: 'application/json' } });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    author = await r.json();
  } catch (e) {
    console.warn(`[OpenAlex] Author lookup failed for ${cleanedOrcid}:`, e?.message || e);
    await openAlexFailTask(taskId, `author lookup failed: ${e?.message || e}`);
    return;
  }

  // 2) Build author-metrics payload
  const summary = author?.summary_stats || {};
  const authorMetrics = {
    hIndex: Number(summary.h_index ?? 0) || 0,
    citations: Number(author?.cited_by_count ?? 0) || 0,
    documents: Number(author?.works_count ?? 0) || 0,
  };
  const i10 = Number(summary.i10_index ?? -1);
  if (i10 >= 0) authorMetrics.i10Index = i10;

  // OpenAlex's author endpoint returns a `counts_by_year` array with
  // {year, works_count, cited_by_count} for the past ~10 years. Map it
  // into the same {year, publications, citations} shape the WoS
  // Citation Report uses so downstream consumers (operator panel,
  // ApplySyncService, public profile) can read both side-by-side
  // without source-specific code paths. Backend stores this as
  // ResearcherProfile.rdlYearlyStats (parallel to wosYearlyStats).
  if (Array.isArray(author?.counts_by_year)) {
    authorMetrics.yearlyStats = author.counts_by_year
      .map(c => ({
        year: Number(c?.year) || 0,
        publications: Number(c?.works_count ?? 0) || 0,
        citations: Number(c?.cited_by_count ?? 0) || 0,
      }))
      .filter(y => y.year > 0)
      .sort((a, b) => a.year - b.year);
  }

  // 3) Works endpoint — page through every work the author has, not
  // just the top-100 most-cited. The historical SmartPublicationService
  // used cursor pagination to grab the full catalog (capped at OpenAlex's
  // hard limit of 200 per page), and the operator panel needs the
  // complete list so WoS/Scopus/Scholar enrichment has somewhere to
  // attach. Stops on next_cursor=null OR after a sane safety cap so a
  // pathological author profile can't spin the worker indefinitely.
  //
  // METRICS_ONLY skips this entirely — author dashboard refresh only.
  let publications = [];
  if (!metricsOnly) {
    try {
      const aid = extractOpenAlexId(author?.id);
      const baseFilter = aid
        ? `authorships.author.id:${aid}`
        : `authorships.author.orcid:${encodeURIComponent(cleanedOrcid)}`;
      let cursor = "*";
      const PER_PAGE = 200;
      const MAX_PAGES = 10; // 2000 works ceiling; covers virtually every researcher
      let pages = 0;
      while (cursor && pages < MAX_PAGES) {
        pages++;
        const worksUrl =
          `https://api.openalex.org/works?filter=${baseFilter}` +
          `&per_page=${PER_PAGE}&sort=cited_by_count:desc&cursor=${encodeURIComponent(cursor)}` +
          `&mailto=rdlsis@example.com`;
        const r = await fetch(worksUrl, { headers: { 'User-Agent': ua, Accept: 'application/json' } });
        if (!r.ok) {
          console.warn('[OpenAlex] Works HTTP', r.status, '(page', pages, ')');
          break;
        }
        const wd = await r.json();
        const arr = Array.isArray(wd?.results) ? wd.results : [];
        for (const w of arr) {
          const p = toOpenAlexPublication(w);
          if (p) publications.push(p);
        }
        // OpenAlex returns next_cursor=null when the list is exhausted.
        cursor = wd?.meta?.next_cursor || null;
        if (arr.length < PER_PAGE) break; // short page — definitely the last
      }
      addLog(`OpenAlex works: ${publications.length} fetched across ${pages} page(s)`, 'info');
    } catch (e) {
      console.warn('[OpenAlex] Works lookup failed:', e?.message || e);
    }
  } else {
    addLog(`OpenAlex METRICS_ONLY — skipping works fetch`, 'info');
  }

  // 4) Push to broker — author-metrics first, then complete
  try {
    const h = await brokerHeaders();
    const url = `https://api.openalex.org/authors/orcid:${cleanedOrcid}`;

    await fetch(`${API_BASE}/api/tasks/${taskId}/author-metrics`, {
      method: 'POST', headers: h,
      body: JSON.stringify({ authorMetrics, url }),
    });

    await fetch(`${API_BASE}/api/tasks/${taskId}/complete`, {
      method: 'POST', headers: h,
      body: JSON.stringify({
        rawData: {
          publications,
          authorMetrics,
          scrapedAt: new Date().toISOString(),
          url,
          source: 'OPENALEX',
        },
      }),
    });

    addLog(`OpenAlex done: h=${authorMetrics.hIndex}, citations=${authorMetrics.citations}, ${publications.length} works`, 'success');

    // ── 5) Fan out PlumX citation lookups for every DOI we just produced.
    //    Mirrors the historical SmartPublicationService.triggerPlumxCitation
    //    Enrichment step that ran on the backend right after OpenAlex sync.
    //    Now that's worker-side: PlumX results come back through the broker
    //    bridge and merge into stagedData.publications[].citations.scopus,
    //    so the operator panel sees a fully-citation-loaded review.
    //
    //    The task carries the syncRequestId so the broker can route the
    //    citations to the right request (multiple operators may have
    //    overlapping DOIs across requests — without the stamp, citations
    //    would land on whichever pub the broker found first).
    //
    //    METRICS_ONLY skips PlumX fan-out — it's a pure metrics refresh
    //    and we don't want to disturb the per-DOI citation overlay that
    //    might already exist on the publications list.
    if (metricsOnly) {
      return;
    }
    try {
      const dois = publications
        .map(p => (p && p.doi ? String(p.doi).trim() : null))
        .filter(Boolean);
      if (dois.length > 0) {
        const syncRequestId = task && task.syncRequestId ? task.syncRequestId : null;
        // Broker already de-dupes per-DOI in addPlumxTasks; we send the
        // full list and let it skip dupes.
        const body = { dois };
        if (syncRequestId) body.syncRequestId = syncRequestId;
        const r = await fetch(`${API_BASE}/api/plumx-tasks`, {
          method: 'POST', headers: h,
          body: JSON.stringify(body),
        });
        if (r.ok) {
          let added = 0;
          try {
            const j = await r.json();
            added = Number(j?.added ?? 0);
          } catch (_) { /* ignore non-json */ }
          addLog(`PlumX batch queued: ${added}/${dois.length} new DOIs`, 'info');
        } else {
          console.warn('[OpenAlex] PlumX batch HTTP', r.status);
        }
      }
    } catch (plumxErr) {
      // Non-fatal — OpenAlex itself completed, so don't unwind. PlumX is an
      // enrichment side-channel; if it fails the operator just doesn't get
      // Scopus citations on the first pass.
      console.warn('[OpenAlex] PlumX fan-out failed:', plumxErr?.message || plumxErr);
    }
  } catch (e) {
    console.warn(`[OpenAlex] Broker write failed for task ${taskId}:`, e?.message || e);
    await openAlexFailTask(taskId, `broker write failed: ${e?.message || e}`);
  }
}

async function openAlexFailTask(taskId, reason) {
  try {
    const h = await brokerHeaders();
    await fetch(`${API_BASE}/api/tasks/${taskId}/fail`, {
      method: 'POST', headers: h,
      body: JSON.stringify({ error: reason || 'OpenAlex task failed' }),
    });
  } catch (_) { /* swallow */ }
}

function stripOrcidPrefix(raw) {
  const s = String(raw || '').trim();
  const idx = s.lastIndexOf('/');
  return idx >= 0 ? s.slice(idx + 1) : s;
}

function extractOpenAlexId(fullId) {
  if (!fullId) return null;
  const idx = String(fullId).lastIndexOf('/');
  return idx >= 0 ? String(fullId).slice(idx + 1) : String(fullId);
}

/**
 * Reconstructs a plain-text abstract from OpenAlex's `abstract_inverted_index`
 * shape — a {word: [position, position, ...]} map that has to be unrolled
 * into an ordered word array. Same algorithm as the historical
 * SmartPublicationService used.
 */
function reconstructAbstract(invertedIndex) {
  if (!invertedIndex || typeof invertedIndex !== 'object') return '';
  const positions = [];
  for (const [word, posArr] of Object.entries(invertedIndex)) {
    if (!Array.isArray(posArr)) continue;
    for (const p of posArr) {
      if (typeof p === 'number') positions.push([p, word]);
    }
  }
  if (positions.length === 0) return '';
  positions.sort((a, b) => a[0] - b[0]);
  return positions.map(([, w]) => w).join(' ');
}

function toOpenAlexPublication(w) {
  if (!w) return null;
  const out = {};

  // ── Identifiers ──────────────────────────────────────────────────────
  let doi = w.doi || '';
  if (doi) {
    const idx = doi.indexOf('doi.org/');
    if (idx >= 0) doi = doi.slice(idx + 'doi.org/'.length);
    out.doi = doi;
  }
  if (w.id) {
    const oaIdx = String(w.id).lastIndexOf('/');
    if (oaIdx >= 0) out.openAlexId = String(w.id).slice(oaIdx + 1);
  }

  // ── Title / type ─────────────────────────────────────────────────────
  if (w.title || w.display_name) {
    out.title = w.title || w.display_name;
  }
  if (w.type) out.originalType = w.type;
  if (w.publication_year) out.year = w.publication_year;
  if (w.publication_date) out.publicationDate = w.publication_date;
  if (w.language) out.language = w.language;

  // ── Citations (OpenAlex's authoritative count) ───────────────────────
  if (w.cited_by_count != null) out.citations = { openalex: w.cited_by_count };

  // ── Venue / journal (try multiple locations) ─────────────────────────
  const venue = w.host_venue || w.primary_location?.source || w.locations?.[0]?.source;
  if (venue?.display_name) out.journal = venue.display_name;
  if (venue?.publisher) out.publisher = venue.publisher;
  if (venue?.issn_l) out.issn = venue.issn_l;
  if (venue?.issn) out.issnList = venue.issn;
  if (venue?.is_oa != null) out.openAccess = !!venue.is_oa;

  // ── Bibliographic ────────────────────────────────────────────────────
  if (w.biblio) {
    if (w.biblio.volume) out.volume = String(w.biblio.volume);
    if (w.biblio.issue) out.issue = String(w.biblio.issue);
    const fp = w.biblio.first_page || '';
    const lp = w.biblio.last_page || '';
    if (fp && lp) out.pages = `${fp}-${lp}`;
    else if (fp) out.pages = String(fp);
  }

  // ── Authors with ORCID + affiliation hint when available ─────────────
  if (Array.isArray(w.authorships)) {
    const authors = w.authorships
      .map((a) => {
        const name = a?.author?.display_name;
        if (!name) return null;
        let orcid = a?.author?.orcid || '';
        if (orcid && orcid.startsWith('https://orcid.org/')) {
          orcid = orcid.slice('https://orcid.org/'.length);
        }
        const out = { name };
        if (orcid) out.orcid = orcid;
        const inst = a?.institutions?.[0]?.display_name;
        if (inst) out.affiliation = inst;
        return out;
      })
      .filter(Boolean);
    if (authors.length) out.authors = authors;
  }

  // ── Abstract (OpenAlex stores it as inverted index — unroll it) ──────
  if (w.abstract_inverted_index) {
    const abs = reconstructAbstract(w.abstract_inverted_index);
    if (abs) out.abstract = abs;
  }

  // ── Concepts/keywords (OpenAlex labels topical tags) ─────────────────
  if (Array.isArray(w.concepts) && w.concepts.length) {
    out.keywords = w.concepts
      .filter((c) => c?.display_name && (c.score == null || c.score >= 0.3))
      .map((c) => c.display_name)
      .slice(0, 12);
  }
  // OpenAlex also exposes a keywords array directly for some works
  if (Array.isArray(w.keywords) && w.keywords.length && !out.keywords) {
    out.keywords = w.keywords
      .map((k) => (typeof k === 'string' ? k : k?.display_name))
      .filter(Boolean)
      .slice(0, 12);
  }

  // ── Open access link the operator may want to verify ─────────────────
  const oaUrl = w.open_access?.oa_url || w.primary_location?.landing_page_url;
  if (oaUrl) out.url = oaUrl;

  return out;
}

async function pollScrape() {
  // ── Source ordering policy ──────────────────────────────────────────────
  // Per product spec (2026-05): the worker must finish OpenAlex BEFORE it
  // touches any profile-tab source. OpenAlex provides the publications
  // baseline (DOIs, titles, authorship) that WoS/Scopus/Scholar then enrich
  // with citation metrics. Running them in parallel produced races where the
  // operator panel saw partial pubs lists and stale metric merges.
  //
  // Order:  OPENALEX  →  WOS  →  SCOPUS  →  SCHOLAR   (serial)
  //         PlumX runs as its own pool, see pollPlumx() — that's expected,
  //         it's a per-paper enrichment side-channel, not a profile source.

  // 1) Drain OpenAlex first. While an OpenAlex task is in flight,
  //    we don't poll any profile sources at all.
  await pollOpenAlex();
  if (activeOpenAlexTask !== null) {
    return false;
  }

  // 2) Only one profile task at a time (serial across WOS/SCOPUS/SCHOLAR)
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
    const winId = await getOrCreateWorkerWindow();
    // active:true so PlumX's ScienceDirect-themed iframe actually renders
    // (it stalls on RAF when the tab is hidden), and the worker window
    // stays focused:false so the operator's main window isn't disturbed.
    const opts = { url, active: true };
    if (winId != null) opts.windowId = winId;
    const tab = await chrome.tabs.create(opts);
    if (winId != null) { await dismissWorkerPlaceholder(); await sweepBlankTabsInWorker(tab.id); }
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
//  WORKER WINDOW — keeps bot tabs out of background-throttle
// ═══════════════════════════════════════════════
// Chrome aggressively throttles JS timers + animation in tabs that are not
// "active in a visible window". WoS / Scopus / Scholar are SPAs that depend
// on those timers to render — when their tab is hidden, metric DOM nodes
// never appear and the scrape times out.
//
// We dedicate a separate Chrome window to bot work. The window is created
// `focused: false` so we don't disrupt the operator's current work, but its
// tabs are still considered "active in window" by Chrome's renderer, which
// means no background throttling. The user can position / minimize / move
// this window however they like; we recreate it transparently if closed.

let workerWindowId = null;
/** Tab id of the placeholder `about:blank` tab created with the worker window. */
let workerPlaceholderTabId = null;

// Reset cached id if user closes the worker window
chrome.windows.onRemoved.addListener((windowId) => {
  if (windowId === workerWindowId) {
    console.log('[Worker Window] Closed by user; will recreate on next task');
    workerWindowId = null;
    workerPlaceholderTabId = null;
  }
});

/**
 * Closes the placeholder `about:blank` tab once a real bot tab is open in
 * the worker window. Safe to call multiple times — only acts on the first
 * call after a window creation.
 *
 * Must be called AFTER a real tab has been added, otherwise removing the
 * last tab would close the window.
 */
async function dismissWorkerPlaceholder() {
  const placeholderId = workerPlaceholderTabId;
  if (placeholderId == null) return;
  workerPlaceholderTabId = null; // clear first so concurrent calls no-op
  try {
    // Sanity check: the worker window still has more than just the placeholder
    if (workerWindowId != null) {
      const tabs = await chrome.tabs.query({ windowId: workerWindowId });
      if (tabs.length <= 1) {
        // Only placeholder — don't remove or the window closes. Restore the id.
        workerPlaceholderTabId = placeholderId;
        return;
      }
    }
    await chrome.tabs.remove(placeholderId);
  } catch (_) {
    // Tab may already be gone; nothing to do
  }
}

/**
 * Sweep any leftover `about:blank` / new-tab pages from the worker window.
 * Catches the case where Chrome opens a new tab unexpectedly (e.g., a popup
 * blocker bypass, an extension dialog) or where the placeholder id we cached
 * went stale.
 */
async function sweepBlankTabsInWorker(keepTabId) {
  if (workerWindowId == null) return;
  try {
    const tabs = await chrome.tabs.query({ windowId: workerWindowId });
    if (tabs.length <= 1) return; // never empty the window
    for (const t of tabs) {
      if (t.id === keepTabId) continue;
      const u = t.url || t.pendingUrl || '';
      if (u === '' || u === 'about:blank' || u.startsWith('chrome://newtab')) {
        chrome.tabs.remove(t.id).catch(() => {});
      }
    }
  } catch (_) { /* ignore */ }
}

async function getOrCreateWorkerWindow() {
  // Validate cached id — user may have closed it
  if (workerWindowId != null) {
    try {
      await chrome.windows.get(workerWindowId);
      return workerWindowId;
    } catch (_) {
      workerWindowId = null;
    }
  }

  try {
    const win = await chrome.windows.create({
      url: 'about:blank',
      type: 'normal',
      focused: false,
      // Reasonable size — large enough that Chrome doesn't treat it as
      // occluded, small enough to tuck in a corner.
      width: 1100,
      height: 800,
      left: 50,
      top: 50,
    });
    workerWindowId = win.id;
    // Track the placeholder so we can remove it once a real bot tab joins.
    workerPlaceholderTabId = win.tabs?.[0]?.id ?? null;
    addLog('Worker window created — bot tabs will run there to avoid background throttling', 'info');
    return workerWindowId;
  } catch (e) {
    console.warn('[Worker Window] Create failed, falling back to current window:', e?.message || e);
    return null;
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

  // Open in the dedicated worker window so the tab is "active in window"
  // and avoids Chrome's background-tab throttling. Falls back to a normal
  // tab in the current window if window creation fails.
  const winId = await getOrCreateWorkerWindow();
  const createOpts = { url, active: true };
  if (winId != null) createOpts.windowId = winId;
  const tab = await chrome.tabs.create(createOpts);

  // Now that there's a real tab in the worker window, drop the placeholder
  // about:blank that was created with the window. Also sweep any other
  // empty tabs that may have crept in.
  if (winId != null) {
    await dismissWorkerPlaceholder();
    await sweepBlankTabsInWorker(tab.id);
  }

  const tabId = tab.id;
  await chrome.storage.session.set({ [tabId]: { taskId, externalId, source, taskType: taskType || 'FULL_SCRAPE' } });

  // Track WOS group jobs
  if (source === 'WOS') {
    activeWosJobs.profileTab = tabId;
    activeWosJobs.profileTaskId = taskId;
    addLog(`[WOS Group] Profile tab opened #${tabId} for task ${taskId}`, 'info');
  }

  pendingTabs.set(tabId, { taskId, externalId, source, taskType: taskType || 'FULL_SCRAPE', openedAt: Date.now(), readyAt: null });
  addLog(`Opened ${source} tab (focused, ${taskType || 'FULL_SCRAPE'})`, 'info');

  // Start scrape timeout (reset by PROGRESS_UPDATE / SCRAPE_READY)
  const timeoutId = setTimeout(() => {
    const current = pendingTabs.get(tabId);
    if (current && current.taskId === taskId) {
      handleTaskTimeout(tabId);
    }
  }, SCRAPE_TIMEOUT_MS);
  scrapeTimeouts.set(tabId, timeoutId);

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
    // Free WOS group slots
    if (entry.source === 'WOS') {
      if (activeWosJobs.profileTab === tabId) {
        activeWosJobs.profileTab = null;
        activeWosJobs.profileTaskId = null;
        addLog(`[WOS Group] Profile tab #${tabId} cleared`, 'info');
      }
      activeWosJobs.detailTabs.delete(tabId);
      if (activeWosJobs.citationReportTab === tabId) {
        activeWosJobs.citationReportTab = null;
      }
    }
    pendingTabs.delete(tabId);
  } else if (activeProfileTask) {
    // entry may be missing if it was already removed (e.g. double-clear),
    // but if the active task was tied to this tab we must still free it
    // to prevent the orchestrator from being permanently blocked.
    const sessionKey = String(tabId);
    chrome.storage.session.get([sessionKey]).then(stored => {
      const info = stored[sessionKey];
      if (info && activeProfileTask && activeProfileTask.taskId === info.taskId) {
        console.warn(`[WoS Worker] clearPendingTab: entry missing for tab #${tabId}, but freeing activeProfileTask ${info.taskId} via session storage.`);
        activeProfileTask = null;
      }
    }).catch(() => {
      // Session storage unavailable — force-clear to be safe
      console.warn(`[WoS Worker] clearPendingTab: no entry, no session for tab #${tabId}. Force-clearing activeProfileTask.`);
      activeProfileTask = null;
    });
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

        // Replace the pre-ready timeout with the real scrape timeout.
        // Using resetScrapeTimeout ensures the new timeout is stored in
        // scrapeTimeouts and can be cancelled on PROGRESS_UPDATE or clearPendingTab.
        resetScrapeTimeout(tabId);
      }
    }
    sendResponse({ ok: true });
    return true;
  }

  // ── WoS Session Handler: Login success signal ──
  if (msg.type === 'WOS_LOGIN_SUCCESS') {
    const tabId = sender.tab?.id;
    const tabUrl = sender.tab?.url;
    postSessionEvent('WOS', 'LOGIN_SUCCESS', 'auto-login completed');
    handleWosLoginSuccess(tabId, tabUrl).catch(e =>
        console.warn('[WoS Session] handleWosLoginSuccess failed:', e?.message || e));
    // A successful login also satisfies any in-flight pre-flight
    // probe. The probe tab itself may have been the one driving the
    // login flow (when the user logged out between sync runs); now
    // that auth is restored, mark the cached session authenticated so
    // the orchestrator can release the WoS phase gate.
    if (wosSession.pendingResolve) {
      finishWosProbe(true);
    } else {
      // Fresh login outside a probe — extend the cached TTL anyway so
      // the next ensureWosSession() call short-circuits.
      wosSession.status = 'authenticated';
      wosSession.lastVerifiedAt = Date.now();
    }
    sendResponse({ ok: true });
    return true;
  }

  // ── Pre-flight probe: session_handler reports session is OK ──
  if (msg.type === 'WOS_SESSION_OK') {
    if (wosSession.pendingResolve) {
      finishWosProbe(true);
    } else {
      // Late signal (probe already timed out / resolved) — still
      // bump the cache so subsequent ticks don't re-probe immediately.
      wosSession.status = 'authenticated';
      wosSession.lastVerifiedAt = Date.now();
    }
    sendResponse({ ok: true });
    return true;
  }

  // ── Generic session-state event from content scripts ──
  // Content scripts can send {type: 'SESSION_EVENT', source, event, detail}
  // for any source/event pair; we forward to the broker so backend stays in sync.
  if (msg.type === 'SESSION_EVENT') {
    if (msg.source && msg.event) {
      postSessionEvent(msg.source, msg.event, msg.detail);
    }
    sendResponse({ ok: true });
    return true;
  }

  // ── WoS return-URL persistence (storage.session not always usable from MAIN world) ──
  if (msg.type === 'WOS_SET_RETURN_URL') {
    // Awaitable so the caller (forceNavigateToLogin) can rely on the
    // write completing before triggering navigation.
    chrome.storage.session.set({ wos_return_url: msg.url || '' })
      .then(() => sendResponse({ ok: true }))
      .catch(e => {
        console.warn('[WoS Session] Failed to set return URL:', e?.message || e);
        sendResponse({ ok: false, error: e?.message });
      });
    return true; // async response
  }

  // ── WoS login pending sentinel ──
  // Set right before the login form is submitted; survives the post-
  // submit redirect. The post-login session_handler asks
  // WOS_CHECK_POST_LOGIN to learn whether to dispatch WOS_LOGIN_SUCCESS.
  // session_handler runs in MAIN world and can't touch chrome.storage
  // directly — all storage I/O happens here.
  if (msg.type === 'WOS_SET_LOGIN_PENDING') {
    chrome.storage.session.set({ wos_login_pending: Date.now() })
      .then(() => sendResponse({ ok: true }))
      .catch(e => {
        console.warn('[WoS Session] Failed to set login-pending:', e?.message || e);
        sendResponse({ ok: false, error: e?.message });
      });
    return true;
  }

  // ── Post-login breadcrumb check ──
  // Returns { fired: true } if the wos_login_pending flag was set and
  // we just dispatched the login-success navigation; false otherwise.
  // Idempotent — flag is consumed on first hit (inside handleWosLoginSuccess).
  if (msg.type === 'WOS_CHECK_POST_LOGIN') {
    (async () => {
      try {
        const tabId = sender.tab?.id;
        const tabUrl = sender.tab?.url;
        const stored = await chrome.storage.session.get(['wos_login_pending']);
        const ts = stored.wos_login_pending;
        if (!ts) {
          sendResponse({ fired: false, reason: 'no flag' });
          return;
        }
        if (Date.now() - ts > 5 * 60 * 1000) {
          await chrome.storage.session.remove(['wos_login_pending']);
          sendResponse({ fired: false, reason: 'stale' });
          return;
        }
        // Real flag, real tab — route through the same login-success
        // helper so navigation / dedup / hash-restamp is identical
        // to the WOS_LOGIN_SUCCESS message path.
        postSessionEvent('WOS', 'LOGIN_SUCCESS', 'post-login breadcrumb consumed');
        await handleWosLoginSuccess(tabId, tabUrl);
        sendResponse({ fired: true, tabId });
      } catch (e) {
        console.warn('[WoS Session] WOS_CHECK_POST_LOGIN failed:', e?.message || e);
        sendResponse({ fired: false, error: e?.message });
      }
    })();
    return true;
  }

  // ── Scopus session recovery: clear cookies/storage and retry ──
  // Triggered by scopus_session_handler.js when it sees a login redirect.
  if (msg.type === 'RECOVER_SCOPUS_SESSION') {
    const tabId = sender.tab?.id;
    const taskId = msg.taskId;
    const externalId = msg.externalId;
    if (tabId == null || !taskId || !externalId) {
      sendResponse({ ok: false });
      return false;
    }
    recoverScopusSession(tabId, taskId, externalId).catch(e => {
      console.warn('[Scopus Session] Recovery threw:', e?.message || e);
    });
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
    handleAuthorMetrics(msg, sender.tab?.id).then(sendResponse);
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

  // ── Citation Report URL stale → WoS redirected us to Smart Search ──
  // Content-script noticed the tab is NOT on /citation-report and
  // bailed out early. Close the tab, report failure to the broker so
  // operator panel surfaces a real error, and free the slot for the
  // next task. (See wos_citation_report_content.js
  // `isStaleCitationReportRedirect`.)
  if (msg.type === 'CITATION_REPORT_STALE_REDIRECT') {
    const tabId = sender.tab?.id;
    const entry = tabId != null ? pendingCitationReportTabs.get(tabId) : null;
    const taskId = msg.taskId || (entry ? entry.taskId : null);
    const citationReportTaskId = entry?.citationReportTaskId || null;
    console.warn(`[WoS Worker] Citation Report tab landed on ${msg.redirectedTo} — qid likely expired (task ${taskId})`);
    addLog('Citation Report URL stale (qid expired) — closing tab and failing task', 'warning');
    (async () => {
      try {
        if (citationReportTaskId) {
          await reportCitationReportFailure(citationReportTaskId,
              'WoS redirected the citation-report URL to Smart Search (qid expired). '
              + 'Re-run the worker sync — a fresh URL will be captured.');
        }
      } catch (e) {
        console.warn('[WoS Worker] Failed to report stale-redirect failure:', e);
      }
      try { if (tabId != null) await chrome.tabs.remove(tabId); } catch (_) { }
      if (tabId != null) {
        pendingCitationReportTabs.delete(tabId);
        if (activeWosJobs.citationReportTab === tabId) {
          activeWosJobs.citationReportTab = null;
        }
      }
    })();
    sendResponse({ ok: true });
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

async function handleAuthorMetrics(msg, senderTabId) {
  const { taskId, authorMetrics, url, source, taskType } = msg;

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
    const respBody = await resp.text().catch(() => '');
    if (!resp.ok) {
      throw new Error(`HTTP ${resp.status}: ${respBody || 'Empty body'}`);
    }
    addLog(`Author-metrics endpoint OK (HTTP ${resp.status})`, 'success');
    addLog(`Author metrics saved (h-index: ${authorMetrics.hIndex || 0})`, 'success');
  } catch (err) {
    console.error('[WoS Worker] Author metrics API error:', err);
    addLog(`Failed to save author metrics: ${err.message}`, 'warning');
  }

  // METRICS_ONLY or SCOPUS short-circuit (Scopus doesn't do detail pages yet)
  let targetTabId = senderTabId || null;
  let isShortCircuit = false;

  // Trust msg.source/msg.taskType from content script; fall back to pendingTabs if absent
  if (source === 'SCOPUS' || taskType === 'METRICS_ONLY') {
    isShortCircuit = true;
  }

  // Fallback lookup in pendingTabs if msg didn't carry source/taskType
  if (!isShortCircuit) {
    for (const [tabId, entry] of pendingTabs.entries()) {
      if (entry.taskId === taskId) {
        if (entry.taskType === 'METRICS_ONLY' || entry.source === 'SCOPUS') {
          targetTabId = tabId;
          isShortCircuit = true;
          break;
        }
      }
    }
  }

  if (isShortCircuit) {
    addLog(`Short-circuiting article scraping for task ${taskId}. Completing...`, 'info');

    try {
      const h = await brokerHeaders();
      const resp = await fetch(`${API_BASE}/api/tasks/${taskId}/complete`, {
        method: 'POST', headers: h,
        body: JSON.stringify({ rawData: { authorMetrics, articles: [], scrapedAt: new Date().toISOString(), url } }),
      });
      if (resp.ok) {
        addLog(`Task ${taskId} completed!`, 'success');
        if (diagTask) { diagTask.status = 'COMPLETED'; diagTask.completedAt = new Date().toISOString(); }
        // If this was a Scopus task that may have gone through recovery,
        // tell the backend the session is now OK and clear the per-task
        // recovery counter so future tasks start fresh.
        if (source === 'SCOPUS') {
          await postSessionEvent('SCOPUS', 'LOGIN_SUCCESS', `task ${taskId} completed`);
          await clearScopusRecoveryState(taskId);
        }
      } else {
        addLog(`Task ${taskId} complete returned ${resp.status}`, 'warning');
        if (diagTask) { diagTask.status = 'ERROR'; diagTask.error = `HTTP ${resp.status}`; diagTask.completedAt = new Date().toISOString(); }
      }
    } catch (err) {
      addLog(`Failed to complete short-circuited task ${taskId}`, 'error');
      if (diagTask) { diagTask.status = 'ERROR'; diagTask.error = err.message; diagTask.completedAt = new Date().toISOString(); }
    }

    if (targetTabId != null) {
      clearPendingTab(targetTabId);
      try { await chrome.tabs.remove(targetTabId); } catch (_) { }
    } else {
      // We don't know the tabId — try to find and close any tab with this taskId
      for (const [tabId, entry] of pendingTabs.entries()) {
        if (entry.taskId === taskId) {
          clearPendingTab(tabId);
          try { await chrome.tabs.remove(tabId); } catch (_) { }
          break;
        }
      }
    }

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
  const noUrlCount = articles.length - articlesToDetail.length;

  // Loud diagnostics — operator panel showed pubs without Q value /
  // Impact Factor / abstract because detail tabs weren't opening. The
  // root cause was article rows that came back without `articleUrl`.
  // Now we surface that count so the next time it happens it's
  // immediately visible from the worker's log strip.
  console.log(`[WoS Worker] Detail eligibility: ${articlesToDetail.length}/${articles.length} articles have URLs (${noUrlCount} missing)`);
  addLog(`Detail eligibility: ${articlesToDetail.length}/${articles.length} articles ready (${noUrlCount} no URL)`,
         articlesToDetail.length > 0 ? 'info' : 'warning');

  if (articlesToDetail.length === 0) {
    // Nothing to scrape — short-circuit straight to /complete with the
    // list-page data we already have. Otherwise the task would sit
    // forever in PROCESSING and the operator panel would never
    // transition out of "Çekiliyor".
    addLog(`No detail URLs found for ${source} — completing with citation-report data only`, 'warning');
    const rawData = { ...authorData, articles, source };
    try {
      const h = await brokerHeaders();
      await fetch(`${API_BASE}/api/tasks/${taskId}/complete`, {
        method: 'POST', headers: h,
        body: JSON.stringify({ rawData }),
      });
      if (diagTask) { diagTask.status = 'COMPLETED'; diagTask.completedAt = new Date().toISOString(); }
    } catch (err) {
      addLog(`Failed to complete task ${taskId} (no-detail path): ${err.message}`, 'error');
      if (diagTask) { diagTask.status = 'ERROR'; diagTask.error = err.message; }
    }
    clearPendingTab(authorTabId);
    try { await chrome.tabs.remove(authorTabId); } catch (_) { }
    updateState({
      status: 'IDLE', taskId: null, targetId: null,
      progress: { current: 0, total: 0, label: 'Waiting...' }
    });
    return;
  }

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
  // ALL sources are now serial because each detail tab opens active:true
  // (so its renderer isn't RAF-throttled). Multiple active tabs in the
  // same window would have every new tab demote the previous one to
  // background mid-scrape, breaking Angular renders. detailPoolSize is
  // hard-capped at DETAIL_POOL_MAX=1 above, but we still read it through
  // the variable so the rate-limit-driven shrink/grow telemetry continues
  // to log meaningful messages.
  const currentMax = detailPoolSize;

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
    const winId = await getOrCreateWorkerWindow();
    // active:true — WoS detail pages are Angular SPAs that depend on
    // requestAnimationFrame to mount JCR/quartile/abstract sections.
    // Background tabs in non-focused windows have RAF throttled, so the
    // detail content never appears and the scrape times out. Making the
    // tab active in the worker window unthrottles the renderer; the
    // window itself stays focused:false so we don't steal focus from
    // the operator's main panel.
    const opts = { url, active: true };
    if (winId != null) opts.windowId = winId;
    const tab = await chrome.tabs.create(opts);
    if (winId != null) { await dismissWorkerPlaceholder(); await sweepBlankTabsInWorker(tab.id); }
    job.activeTabIds.add(tab.id);
    job.tabToUrlMap.set(tab.id, url);
    // Track WOS detail tabs
    const authorTabEntry = pendingTabs.get(job.authorTabId);
    if (authorTabEntry?.source === 'WOS') {
      activeWosJobs.detailTabs.add(tab.id);
      // REGISTER in pendingTabs so clearPendingTab can clean activeWosJobs.detailTabs
      pendingTabs.set(tab.id, { source: 'WOS', taskId, type: 'DETAIL' });
    }
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

  let lastError = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const h = await brokerHeaders();
      const payload = JSON.stringify({ rawData });
      if (attempt === 1) {
        addLog(`Sending complete payload (${(payload.length/1024).toFixed(1)} KB, ${enrichedArticles.length} articles)`, 'info');
        console.log(`[WoS Worker] Task ${taskId}: Sending complete payload (${(payload.length/1024).toFixed(1)} KB, ${enrichedArticles.length} articles)`);
      }
      const resp = await fetch(`${API_BASE}/api/tasks/${taskId}/complete`, {
        method: 'POST', headers: h,
        body: payload,
      });
      const respBody = await resp.text().catch(() => '');
      if (!resp.ok) {
        throw new Error(`HTTP ${resp.status}: ${respBody || 'Empty body'}`);
      }
      addLog(`Complete endpoint OK (HTTP ${resp.status}, body=${respBody || '(empty)'})`, 'success');
      console.log(`[WoS Worker] Task ${taskId}: Complete endpoint returned HTTP ${resp.status}, body=${respBody || '(empty)'}`);
      addLog(`Task successfully completed!`, 'success');
      if (diagTask) { diagTask.status = 'COMPLETED'; diagTask.completedAt = new Date().toISOString(); }
      markSourceComplete(source);
      lastError = null;
      break;
    } catch (err) {
      lastError = err;
      console.error(`[WoS Worker] Backend API error (attempt ${attempt}):`, err);
      addLog(`Complete attempt ${attempt} failed: ${err.message}`, attempt < 3 ? 'warning' : 'error');
      if (attempt < 3) {
        await new Promise(r => setTimeout(r, 3000));
      }
    }
  }
  if (lastError) {
    if (diagTask) { diagTask.status = 'ERROR'; diagTask.error = lastError.message; diagTask.completedAt = new Date().toISOString(); }
    markSourceComplete(source, true);
  }

  // ── Citation Report Tab'ını Aç (detay scraping'den sonra) ──
  // Eğer bu task için kaydedilmiş bir Citation Report linki varsa aç
  const savedLink = savedCitationReportLinks.get(taskId);
  if (savedLink) {
    addLog(`Opening Citation Report tab for task ${taskId}...`, 'info');
    // Await so the tab is created and added to pendingCitationReportTabs BEFORE we clear activeProfileTask
    try {
      await openCitationReportTab(taskId);
    } catch (err) {
      console.warn('[WoS Worker] Failed to open Citation Report tab:', err);
    }
  }

  // Author tab'ını kapat (bu işlem activeProfileTask'i null yapar)
  clearPendingTab(authorTabId);
  try { await chrome.tabs.remove(authorTabId); } catch (_) { }

  // Also clear any dangling citation report tab reference so WOS phase can end
  if (activeWosJobs.citationReportTab !== null) {
    const citTabId = activeWosJobs.citationReportTab;
    activeWosJobs.citationReportTab = null;
    pendingCitationReportTabs.delete(citTabId);
    try { await chrome.tabs.remove(citTabId); } catch (_) { }
    addLog(`[WOS Group] Citation report tab #${citTabId} force-cleared on finalize`, 'info');
  }
  // Clear all WOS detail tab references so isWosPhaseActive() becomes false
  if (activeWosJobs.detailTabs.size > 0) {
    const count = activeWosJobs.detailTabs.size;
    activeWosJobs.detailTabs.clear();
    addLog(`[WOS Group] Cleared ${count} dangling detail tab reference(s) on finalize`, 'info');
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
  const { taskId, source, externalId } = entry;

  // ── Scopus auto-recovery on metric-extraction failure ──────────────
  // When scopus_content.js can't find h-index / publications on the
  // page, the most common cause is a stale login that's silently
  // serving an anonymous (metricsless) view rather than redirecting
  // to a login wall. The session_handler doesn't catch this case
  // because there's no redirect to detect. We do here: clear cookies
  // + storage and let the worker re-poll the same task on the next
  // orchestrator tick. The recovery counter caps it at
  // SCOPUS_MAX_RECOVERY_ATTEMPTS so we don't loop on a permanent
  // outage.
  if (source === 'SCOPUS' && externalId
      && msg.error && /could not find scopus author metrics|metrics on page in time/i.test(msg.error)) {
    const state = await getScopusRecoveryState(taskId);
    if (state.attempts < SCOPUS_MAX_RECOVERY_ATTEMPTS) {
      addLog(`Scopus metrics not found — clearing cookies and retrying (${state.attempts + 1}/${SCOPUS_MAX_RECOVERY_ATTEMPTS})`, 'warning');
      try {
        // recoverScopusSession increments the attempt counter, wipes
        // cookies+storage for Scopus/Elsevier, and reloads the tab to
        // the original Scopus profile URL — the content script will
        // re-scrape from a clean session.
        await recoverScopusSession(tabId, taskId, externalId);
      } catch (e) {
        console.warn('[Scopus Session] Recovery on metric-fail threw:', e?.message || e);
      }
      // Don't mark the task failed; recovery either reloads the same
      // tab in-place or (on exhaustion) marks failed itself.
      return;
    }
    // Recovery exhausted — fall through to the normal fail path below.
    addLog(`Scopus recovery exhausted (${state.attempts} attempts); marking task failed`, 'error');
  }

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
    const winId = await getOrCreateWorkerWindow();
    // active:true so smart-search's autocomplete + result render isn't
    // throttled. Worker window itself stays focused:false (set when
    // created) so the operator panel isn't disturbed.
    const opts = { url, active: true };
    if (winId != null) opts.windowId = winId;
    const tab = await chrome.tabs.create(opts);
    if (winId != null) { await dismissWorkerPlaceholder(); await sweepBlankTabsInWorker(tab.id); }
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
    const winId = await getOrCreateWorkerWindow();
    // active:true so the lookup page actually renders results (Scholar's
    // result list is RAF-driven). Worker window stays focused:false.
    const opts = { url, active: true };
    if (winId != null) opts.windowId = winId;
    const tab = await chrome.tabs.create(opts);
    if (winId != null) { await dismissWorkerPlaceholder(); await sweepBlankTabsInWorker(tab.id); }
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

const pendingCitationReportTabs = new Map(); // tabId → { taskId, authorWosId, citationReportTaskId }
// Per-WOS-author-task Map. Each entry now also carries the broker-side
// CitationReportTask.id we got back from /announce — needed when the
// worker posts /complete or /fail later. The URL is still kept here as
// well so the post-detail-scrape openCitationReportTab path doesn't need
// a second round-trip to the broker.
const savedCitationReportLinks = new Map(); // taskId → { citationReportUrl, authorWosId, citationReportTaskId }

/**
 * Announce a discovered Citation Report URL to the broker so it persists
 * as a CitationReportTask row (survives extension reload) and shows up
 * in the operator panel pipeline. Returns the broker-side task id so
 * later /complete / /fail calls can target it. {@code null} on failure
 * — caller can still proceed with the URL since the in-memory map keeps
 * the worker functional without broker tracking.
 */
async function announceCitationReportToBroker(articleTaskId, citationReportUrl, authorWosId) {
  try {
    const h = await brokerHeaders();
    const resp = await fetch(`${API_BASE}/api/citation-report-tasks/announce`, {
      method: 'POST',
      headers: h,
      body: JSON.stringify({
        articleTaskId,
        citationReportUrl,
        authorWosId: authorWosId || null,
      }),
    });
    if (!resp.ok) {
      console.warn(`[Citation Report] announce returned HTTP ${resp.status}`);
      return null;
    }
    const body = await resp.json().catch(() => null);
    const id = body && body.taskId;
    if (id == null || id === '') {
      console.warn('[Citation Report] announce ok but no taskId returned (article-task unknown to broker)');
      return null;
    }
    return Number(id);
  } catch (err) {
    console.warn('[Citation Report] announce failed:', err?.message || err);
    return null;
  }
}

// Citation Report linki kaydet (detay scraping'den sonra açılacak)
async function handleCitationReportLinkSaved(taskId, citationReportUrl, authorWosId) {
  console.log(`[WoS Worker] Citation Report link saved for task ${taskId}: ${citationReportUrl}`);
  // Persist to broker so the operator panel can show pipeline state
  // and the URL survives an extension reload. Best-effort — if the
  // broker is unreachable we still keep the in-memory copy and the
  // post-detail-scrape openCitationReportTab path works.
  const citationReportTaskId = await announceCitationReportToBroker(
      taskId, citationReportUrl, authorWosId);
  savedCitationReportLinks.set(taskId, {
    citationReportUrl,
    authorWosId,
    citationReportTaskId,
  });
  addLog(citationReportTaskId
      ? `Citation Report link saved (broker task #${citationReportTaskId})`
      : `Citation Report link saved (broker announce failed; in-memory only)`,
      'info');
  return { ok: true, citationReportTaskId };
}

// Citation Report tab'ını aç (detay scraping tamamlandıktan sonra çağrılır)
async function openCitationReportTab(taskId) {
  const savedLink = savedCitationReportLinks.get(taskId);
  if (!savedLink) {
    console.log(`[WoS Worker] No saved Citation Report link for task ${taskId}`);
    return { ok: false, error: 'No saved link' };
  }

  const { citationReportUrl, authorWosId, citationReportTaskId } = savedLink;
  savedCitationReportLinks.delete(taskId);

  console.log(`[WoS Worker] Opening Citation Report tab for task ${taskId}: ${citationReportUrl}`);
  addLog(`Opening Citation Report tab...`, 'info');

  return await handleCitationReportLinkFound(taskId, citationReportUrl, authorWosId, citationReportTaskId);
}

async function handleCitationReportLinkFound(taskId, citationReportUrl, authorWosId, citationReportTaskId) {
  // URL'e task ID'yi ekle
  let url = citationReportUrl;
  const sep = url.includes('#') ? '&' : '#';
  url = `${url}${sep}citation-report-task-id=${taskId}&author-wos-id=${authorWosId || ''}`;

  try {
    const winId = await getOrCreateWorkerWindow();
    // active:true — citation report's per-paper times-cited table is
    // virtualized and won't render its rows when the tab is hidden.
    const opts = { url, active: true };
    if (winId != null) opts.windowId = winId;
    const tab = await chrome.tabs.create(opts);
    if (winId != null) { await dismissWorkerPlaceholder(); await sweepBlankTabsInWorker(tab.id); }
    pendingCitationReportTabs.set(tab.id, { taskId, authorWosId, citationReportTaskId, openedAt: Date.now() });
    activeWosJobs.citationReportTab = tab.id;
    addLog(`[WOS Group] Citation report tab opened #${tab.id} for task ${taskId}`, 'info');
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

        // Mark the broker task as FAILED so the operator panel can show
        // the error and offer "Tekrar Dene".
        await reportCitationReportFailure(citationReportTaskId,
            'Content-script injection failed: ' + (injectErr?.message || injectErr));

        pendingCitationReportTabs.delete(tab.id);
        try { await chrome.tabs.remove(tab.id); } catch (_) { }
      }
    };
    chrome.tabs.onUpdated.addListener(injectionHandler);

    // Timeout: 3 minutes
    setTimeout(async () => {
      if (pendingCitationReportTabs.has(tab.id)) {
        console.warn(`[Citation Report] Tab ${tab.id} timed out`);
        await reportCitationReportFailure(citationReportTaskId,
            'Citation report tab timed out after 3 minutes');
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
  addLog(`Citation Report data received, sending to broker...`, 'info');

  // Look up the broker-side CitationReportTask id we got back from the
  // /announce call earlier. Without it, the broker can't route the
  // payload to the right sync request — fall back to logging only.
  const tabMeta = tabId != null ? pendingCitationReportTabs.get(tabId) : null;
  const citationReportTaskId = tabMeta && tabMeta.citationReportTaskId;

  if (citationReportTaskId == null) {
    console.warn('[Citation Report] No broker task id for tab', tabId,
        '— payload will not reach the operator panel');
    addLog(`Citation Report not linked to broker (no task id)`, 'warning');
  } else {
    try {
      const h = await brokerHeaders();
      const response = await fetch(
          `${API_BASE}/api/citation-report-tasks/${citationReportTaskId}/complete`,
          {
            method: 'POST',
            headers: h,
            body: JSON.stringify({ rawData: data }),
          });
      if (response.ok) {
        addLog(`Citation Report synced (broker task #${citationReportTaskId})`, 'success');
        console.log(`[Citation Report] Data synced to broker for task ${citationReportTaskId}`);
      } else {
        addLog(`Citation Report sync failed: HTTP ${response.status}`, 'error');
        console.warn(`[Citation Report] Broker returned ${response.status}`);
      }
    } catch (err) {
      console.warn('[Citation Report] Failed to sync data to broker:', err);
      addLog(`Failed to sync Citation Report data`, 'error');
    }
  }

  // Tab'ı kapat
  if (tabId) {
    pendingCitationReportTabs.delete(tabId);
    if (activeWosJobs.citationReportTab === tabId) {
      activeWosJobs.citationReportTab = null;
      addLog(`[WOS Group] Citation report tab #${tabId} cleared`, 'info');
    }
    try { await chrome.tabs.remove(tabId); } catch (_) { }
  }

  return { ok: true };
}

/**
 * Reports a citation-report failure to the broker so the operator panel
 * can surface a "FAILED" status with the error message and offer Retry.
 * Called from injection failures and the 3-minute tab timeout.
 */
async function reportCitationReportFailure(citationReportTaskId, errorMessage) {
  if (citationReportTaskId == null) return;
  try {
    const h = await brokerHeaders();
    await fetch(
        `${API_BASE}/api/citation-report-tasks/${citationReportTaskId}/fail`,
        {
          method: 'POST',
          headers: h,
          body: JSON.stringify({ errorMessage: errorMessage || 'Worker reported failure' }),
        });
  } catch (e) {
    console.warn('[Citation Report] Failed to report failure to broker:', e?.message || e);
  }
}

/**
 * Content script: DOM scraping on WoS author page.
 * - Angular'ın listeyi tam yüklemesi için DOM stabilizasyon beklemesi.
 * - "Show more" butonlarına insan benzeri tıklama (Gaussian delay).
 * - Tüm sayfaları dolaşma.
 *
 * v1.1 — Anti-bot detection: human-like scroll, timing, click patterns
 */

const SCRAPE_TIMEOUT_MS = 300_000; // 5 dakika

// ═══════════════════════════════════════════════
//  STEALTH UTILITIES (from stealth-utils.js via window.__stealthUtils)
// ═══════════════════════════════════════════════

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

function _randomInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function _humanScrollStep() {
  return _randomInt(180, 450);
}

async function _maybeReadingPause() {
  if (Math.random() < 0.12) {
    await _humanDelay(1500, 3500);
    return true;
  }
  return false;
}

// ═══════════════════════════════════════════════
//  HELPERS
// ═══════════════════════════════════════════════

function parseCount(text) {
  if (!text) return 0;
  const match = text.match(/[\d,]+/);
  if (!match) return 0;
  const num = match[0].replace(/,/g, '');
  const n = parseInt(num, 10);
  return Number.isNaN(n) ? 0 : n;
}

function waitForInitialLoad() {
  return new Promise((resolve) => {
    const deadline = Date.now() + SCRAPE_TIMEOUT_MS;
    console.log('[WoS Worker] İlk sayfa yüklenmesi bekleniyor...');
    chrome.runtime.sendMessage({
      type: 'PROGRESS_UPDATE',
      log: 'Waiting for initial profile page load...',
      action: 'INITIALIZING'
    });

    const check = () => {
      const anyRecord = document.querySelectorAll('app-record').length > 0;
      const documentsTab = document.querySelector('[data-test="author-tabs-documents-tab-label"]');
      const noContent = document.querySelector('.no-publications, .no-content, [data-test="no-documents"]');

      if (anyRecord || documentsTab || noContent) {
        console.log(`[WoS Worker] Sayfa hazır: records=${document.querySelectorAll('app-record').length}, tab=${!!documentsTab}`);
        clearInterval(intervalId);
        // Human-like delay before starting (not instant)
        setTimeout(() => resolve(true), _gaussianRandom(400, 800));
        return;
      }

      if (Date.now() >= deadline) {
        console.warn('[WoS Worker] TIMEOUT: Sayfa çok yavaş, yine de devam ediliyor...');
        clearInterval(intervalId);
        resolve(false);
      }
    };

    const intervalId = setInterval(check, _gaussianRandom(400, 700));
  });
}

async function waitForListUpdate() {
  console.log(`[WoS Worker] Sayfa değişimi (Angular yüklemesi) bekleniyor...`);
  return new Promise(async (resolve) => {
    // Human-like initial wait
    await _humanDelay(150, 500);

    // Spinner'ın bitmesini bekle (maks 45 saniye)
    for (let t = 0; t < 90; t++) {
      const lightbox = document.querySelector('.spinner-lightbox');
      if (!lightbox) break;
      const s = window.getComputedStyle(lightbox);
      if (s.visibility === 'hidden' || s.display === 'none' || s.opacity === '0') break;
      await _humanDelay(400, 700);
    }

    // Angular render'ı için son bekleme (human-like)
    await _humanDelay(800, 1500); // Increased wait
    resolve();
  });
}

// ═══════════════════════════════════════════════
//  CLICK DOCUMENTS TAB
// ═══════════════════════════════════════════════

async function clickDocumentsTab() {
  // If records are already visible, no need to click
  if (document.querySelectorAll('app-record, .search-results-item').length > 0) {
    console.log('[WoS Worker] Records already visible, skipping tab click.');
    return true;
  }

  // Try multiple selectors for the Documents tab
  const tabSelectors = [
    '[data-test="author-tabs-documents-tab-label"]',
    '[data-ta="author-tabs-documents-tab-label"]',
    'mat-tab-header .mat-tab-label:nth-child(2)',
    '.mat-mdc-tab:nth-child(2)',
    'a[role="tab"]:nth-child(2)',
    'button[role="tab"]:nth-child(2)',
  ];

  let documentsTab = null;
  for (const sel of tabSelectors) {
    documentsTab = document.querySelector(sel);
    if (documentsTab) {
      console.log(`[WoS Worker] Documents tab found via: ${sel}`);
      break;
    }
  }

  // Also try text-based matching
  if (!documentsTab) {
    const allTabs = document.querySelectorAll('[role="tab"], .mat-tab-label, .mat-mdc-tab, .mdc-tab');
    for (const tab of allTabs) {
      const text = tab.textContent.toLowerCase().trim();
      if (text.includes('document') || text.includes('yayın') || text.includes('publication')) {
        documentsTab = tab;
        console.log(`[WoS Worker] Documents tab found via text match: "${text}"`);
        break;
      }
    }
  }

  if (!documentsTab) {
    console.warn('[WoS Worker] Documents tab not found with any selector!');
    chrome.runtime.sendMessage({
      type: 'PROGRESS_UPDATE',
      log: 'WARNING: Documents tab not found on WoS page'
    });
    return false;
  }

  // Scroll to tab and click it
  documentsTab.scrollIntoView({ behavior: 'auto', block: 'center' });
  await _humanDelay(300, 700);

  // Human-like click
  const clickEvent = new MouseEvent('click', { view: window, bubbles: true, cancelable: true });
  documentsTab.dispatchEvent(clickEvent);
  console.log('[WoS Worker] Documents tab clicked!');

  chrome.runtime.sendMessage({
    type: 'PROGRESS_UPDATE',
    log: 'Clicked Documents tab, waiting for publications to load...'
  });

  // Wait for records to appear after click
  for (let t = 0; t < 40; t++) {
    // Wait for spinner to finish
    const lightbox = document.querySelector('.spinner-lightbox');
    if (lightbox) {
      const s = window.getComputedStyle(lightbox);
      if (s.visibility !== 'hidden' && s.display !== 'none' && s.opacity !== '0') {
        await _humanDelay(400, 700);
        continue;
      }
    }

    const recordCount = document.querySelectorAll('app-record, .search-results-item').length;
    if (recordCount > 0) {
      console.log(`[WoS Worker] Records loaded after tab click: ${recordCount}`);
      await _humanDelay(600, 1200);
      return true;
    }
    await _humanDelay(500, 900);
  }

  console.warn('[WoS Worker] No records appeared after Documents tab click.');
  return false;
}

// ═══════════════════════════════════════════════
//  HUMAN-LIKE SCROLL
// ═══════════════════════════════════════════════

async function smoothScrollToBottom() {
  console.log('[WoS Worker] Sayfa yüklenmesi bekleniyor...');

  // 1. Spinner bekle
  for (let t = 0; t < 60; t++) {
    const lightbox = document.querySelector('.spinner-lightbox');
    if (!lightbox) break;
    const s = window.getComputedStyle(lightbox);
    if (s.visibility === 'hidden' || s.display === 'none' || s.opacity === '0') break;
    await _humanDelay(400, 700);
  }

  // 2. Angular'ın ilk render'ı için human-like wait
  await _humanDelay(1200, 2200);

  // 3. Click Documents tab to ensure publications are visible
  await clickDocumentsTab();

  // 5. Find scroll container
  let mainScrollEl = null;
  const candidates = [
    'mat-sidenav-content', '.mat-sidenav-content', '.mat-drawer-content',
    '#primary-content', 'main',
  ];

  for (const sel of candidates) {
    const el = document.querySelector(sel);
    if (!el) continue;
    if (el.scrollHeight <= el.clientHeight) continue;
    const before = el.scrollTop;
    el.scrollTop = before + 10;
    await new Promise(r => setTimeout(r, 10));
    if (el.scrollTop !== before) {
      el.scrollTop = before;
      mainScrollEl = el;
      break;
    }
    el.scrollTop = before;
  }

  if (!mainScrollEl) {
    const all = Array.from(document.querySelectorAll('*'));
    for (const el of all) {
      if (el.clientHeight <= 300 || el.scrollHeight <= el.clientHeight + 50) continue;
      const s = window.getComputedStyle(el);
      if (s.overflowY !== 'auto' && s.overflowY !== 'scroll') continue;
      const before = el.scrollTop;
      el.scrollTop = before + 10;
      await new Promise(r => setTimeout(r, 10));
      if (el.scrollTop !== before) {
        el.scrollTop = before;
        mainScrollEl = el;
        break;
      }
      el.scrollTop = before;
    }
  }

  if (!mainScrollEl) {
    mainScrollEl = document.documentElement;
  }

  // 6. Track record count
  let lastCount = document.querySelectorAll('app-record').length;
  let stagnantCount = 0;

  console.log(`[WoS Worker] Kademeli scroll başlıyor. Başlangıç kayıt sayısı: ${lastCount}`);

  // 7. Human-like scroll — variable step size and speed
  for (let i = 0; i < 150; i++) {
    const step = _humanScrollStep();   // 180-450px random
    mainScrollEl.scrollTop += step;
    window.scrollBy(0, step);

    // Human-like delay between scroll steps
    await _humanDelay(500, 1200);

    // Occasional reading pause (12% chance)
    await _maybeReadingPause();

    const currentCount = document.querySelectorAll('app-record, .search-results-item').length;
    const scrollH = mainScrollEl.scrollHeight;
    const scrollT = mainScrollEl.scrollTop;
    const clientH = mainScrollEl.clientHeight;
    const containerAtBottom = (scrollT + clientH) >= (scrollH - 400);
    const windowAtBottom = (window.innerHeight + window.scrollY) >= (document.body.scrollHeight - 400);

    if (currentCount > lastCount) {
      stagnantCount = 0;
    } else if (containerAtBottom || windowAtBottom) {
      stagnantCount++;
      if (stagnantCount >= 3) {
        console.log('[WoS Worker] Sayfa sonuna ulaşıldı, scroll durduruluyor.');
        break;
      }
    }
    lastCount = currentCount;
  }

  // 8. Scroll back to top
  mainScrollEl.scrollTo({ top: 0, behavior: 'auto' });
  window.scrollTo({ top: 0, behavior: 'auto' });
  await _humanDelay(200, 500);
}

// ═══════════════════════════════════════════════
//  EXPAND ABSTRACTS — Human-like clicking
// ═══════════════════════════════════════════════

async function expandAbstracts() {
  try {
    await smoothScrollToBottom();

    const showMoreBtns = document.querySelectorAll(
      'app-record button.show-more, app-record .show-more-wrapper button, app-record [aria-label*="Show more"]'
    );
    let clickedCount = 0;

    for (let btn of showMoreBtns) {
      if (btn && btn.offsetParent !== null) {
        btn.click();
        clickedCount++;
        // Human-like delay between button clicks (not uniform)
        await _humanDelay(30, 180);

        // Occasionally skip a beat (5% chance — human distraction)
        if (Math.random() < 0.05) {
          await _humanDelay(500, 1500);
        }
      }
    }

    if (clickedCount > 0) {
      console.log(`[WoS Worker] ${clickedCount} adet özet genişletildi.`);
      await _humanDelay(1200, 2200);
    }
  } catch (err) {
    console.warn('[WoS Worker] Özet genişletme sırasında hata:', err);
  }
}

// ═══════════════════════════════════════════════
//  SCRAPE METRICS
// ═══════════════════════════════════════════════

function scrapeAuthorMetrics() {
  const metrics = { hIndex: 0, publications: 0, sumOfTimesCited: 0, citingArticles: 0, subjectCategories: [] };
  try {
    const summaryItems = document.querySelectorAll(
      '.summary-item, .metrics-item, [class*="metric-item"], [data-ta="summary-item"], .wat-author-metric-inline-block'
    );
    summaryItems.forEach(item => {
      const label = item.textContent.toLowerCase();
      if (label.includes('without self')) return;

      const rawCountTxt = item.querySelector(
        '.summary-count, .count, .value, .number, [data-ta*="count"], [data-ta*="value"], .wat-author-metric'
      )?.textContent || item.innerText || item.textContent;

      const count = parseCount(rawCountTxt);
      if (count > 0) {
        if (label.includes('h-index') || label.includes('h index')) { metrics.hIndex = count; return; }
        if (label.includes('sum of times cited') || label.includes('total citations')) { if (metrics.sumOfTimesCited === 0) metrics.sumOfTimesCited = count; return; }
        if (label.includes('citing article')) { if (metrics.citingArticles === 0) metrics.citingArticles = count; return; }
        if (label.includes('times cited') && metrics.sumOfTimesCited === 0) { metrics.sumOfTimesCited = count; return; }
        if (label.includes('publication') || label.includes('document')) { if (metrics.publications === 0) metrics.publications = count; return; }
      }
    });

    const testSelectors = [
      { key: 'hIndex', tests: ['h-index', 'hindex', 'h_index'] },
      { key: 'publications', tests: ['publications', 'total-documents', 'document-count'] },
      { key: 'sumOfTimesCited', tests: ['sum-of-times-cited', 'times-cited', 'citation-count'] },
      { key: 'citingArticles', tests: ['citing-articles'] },
    ];
    testSelectors.forEach(({ key, tests }) => {
      if (metrics[key] !== 0) return;
      tests.forEach(t => {
        const el = document.querySelector(`[data-test*="${t}"]`);
        if (!el) return;
        const num = parseCount(el.querySelector('[class*="count"],[class*="value"],[class*="number"]')?.textContent || el.textContent);
        if (num > 0) metrics[key] = num;
      });
    });

    if (Object.values(metrics).every(v => v === 0 || Array.isArray(v))) {
      const allText = document.body.innerText;
      const hMatch = allText.match(/h[\s-]?index[^\d]*(\d+)/i);
      if (hMatch) metrics.hIndex = parseInt(hMatch[1], 10);
      const citMatch = allText.match(/sum of times cited[^\d]*([\d,]+)/i);
      if (citMatch) metrics.sumOfTimesCited = parseCount(citMatch[1]);
    }

    // Extract Subject Categories
    const subjectCategoryEl = document.querySelector('[data-pendo="data-pendo-subject-cat"]');
    if (subjectCategoryEl) {
      const sectionContent = subjectCategoryEl.closest('.author-detail-section')?.querySelector('.author-detail-section-content');
      if (sectionContent) {
        const chips = sectionContent.querySelectorAll('.chip-span');
        chips.forEach(chip => {
          let text = chip.textContent.trim();
          // Remove trailing semicolons
          if (text.endsWith(';')) {
            text = text.substring(0, text.length - 1).trim();
          }
          if (text) {
            metrics.subjectCategories.push(text);
          }
        });
      }
    }
  } catch (e) {
    console.error('[WoS Worker] Metrik çekme hatası:', e);
  }
  return metrics;
}

// ═══════════════════════════════════════════════
//  SCRAPE ARTICLES
// ═══════════════════════════════════════════════

function scrapeCurrentPageArticles(handledUrls, handledTitles) {
  const articles = [];
  try {
    const items = document.querySelectorAll('app-record, .search-results-item');

    items.forEach((item) => {
      try {
        const titleEl = item.querySelector(
          'a.title, .summary-record-title a, h3 a, h2 a, [data-test="title"] a, [data-ta="summary-record-title-link"]'
        );
        const title = titleEl ? titleEl.textContent.trim() : null;
        let articleUrl = null;
        if (titleEl && titleEl.hasAttribute('href')) {
          const rawHref = titleEl.getAttribute('href');
          articleUrl = rawHref.startsWith('http') ? rawHref : `https://www.webofscience.com${rawHref}`;
        }

        if (!title) return;

        if (articleUrl) {
          if (handledUrls.has(articleUrl)) return;
          handledUrls.add(articleUrl);
        } else {
          const cleanTitle = title.toLowerCase().replace(/[^a-z0-9]/g, '');
          if (handledTitles.has(cleanTitle)) return;
          handledTitles.add(cleanTitle);
        }

        let abstractEl = item.querySelector(
          'div.abstract p, span[id*="AbstractPart"], [data-test="abstract"] p, '
          + '.abstract-text, p.abstract'
        );
        let abstractText = abstractEl ? abstractEl.textContent.trim() : '';
        if (abstractText) {
          abstractText = abstractText.replace(/Show more.*$/i, '').replace(/Show less.*$/i, '').trim();
        } else {
          // Regex fallback for abstract
          const body = item.innerText || '';
          const abstractMatch = body.match(/Abstract\s*\n\s*([^]{50,1500}?)(?:\n\n|\n[A-Z][a-z]+|\nAuthor Information)/);
          if (abstractMatch) {
            abstractText = abstractMatch[1].trim();
          }
        }

        let citations = 0;

        const statNums = item.querySelectorAll('.stat-number, .detail-stat, [class*="stat-count"]');
        statNums.forEach(el => {
          const parent = el.closest('[class*="stat"], [class*="cite"], [class*="citation"]');
          const parentText = parent?.textContent?.toLowerCase() || '';
          if (parentText.includes('cited') || parentText.includes('citation')) {
            const n = parseCount(el.textContent);
            if (n > 0) citations = n;
          }
        });

        if (citations === 0) {
          item.querySelectorAll('.link-container a, .stats-section a, [class*="times-cited"] a').forEach(a => {
            const txt = a.textContent.toLowerCase();
            if (txt.includes('time') || txt.includes('cited') || txt.includes('citation')) {
              const n = parseCount(a.textContent.replace(/[^\d]/g, ''));
              if (n > 0) citations = n;
            }
          });
        }

        if (citations === 0) {
          const citeEl = item.querySelector(
            '[data-test*="citation"], [data-test*="cited"], '
            + '[aria-label*="cited"], [aria-label*="citation"], '
            + '[cdxanalyticslabel*="citation"], [cdxanalyticslabel*="cited"]'
          );
          if (citeEl) {
            const numText = citeEl.textContent.replace(/[^\d]/g, '');
            citations = parseCount(numText);
          }
        }

        if (citations === 0) {
          const fullText = item.textContent;
          const m = fullText.match(/(?:times?\s+cited|cited\s+by)[:\s]*(\d+)/i);
          if (m) citations = parseInt(m[1], 10);
        }

        const authorsEl = item.querySelector('.authors-list, [data-ta="authors-list"], [aria-label*="authors"]');
        const authors = authorsEl ? authorsEl.textContent.trim() : '';

        if (title) {
          articles.push({ title, abstract: abstractText, citations, articleUrl, authors });
        }
      } catch (err) {
        console.warn('[WoS Worker] Tekil makale atlandı:', err);
      }
    });
  } catch (e) {
    console.error('[WoS Worker] Sayfa makalelerini çekerken hata:', e);
  }
  return articles;
}

// ═══════════════════════════════════════════════
//  PAGINATION — Human-like next page clicks
// ═══════════════════════════════════════════════

async function scrapeAllPages() {
  let allArticles = [];
  let pageCount = 0;
  let hasNextPage = true;
  const MAX_PAGES = 100;
  const handledUrls = new Set();
  const handledTitles = new Set();

  while (hasNextPage && pageCount < MAX_PAGES) {
    pageCount++;
    console.log(`[WoS Worker] >>> Sayfa ${pageCount} Taranıyor <<<`);
    chrome.runtime.sendMessage({
      type: 'PROGRESS_UPDATE',
      log: `Scanning page ${pageCount} for articles...`,
      stats: { pagesScanned: pageCount, articlesFound: allArticles.length },
      action: 'PAGINATING'
    });

    await smoothScrollToBottom();

    // Human-like post-scroll wait
    await _humanDelay(1200, 2500);

    const pageArticles = scrapeCurrentPageArticles(handledUrls, handledTitles);
    allArticles = allArticles.concat(pageArticles);

    chrome.runtime.sendMessage({
      type: 'PROGRESS_UPDATE',
      stats: { articlesFound: allArticles.length }
    });

    // Human-like pause before looking for next page button
    await _humanDelay(300, 800);

    const nextBtns = Array.from(document.querySelectorAll(
      'button[aria-label*="Next Page"], button[cdxanalyticscategory="wos_navigation_next_page"]'
    ));
    const activeNextBtn = nextBtns.find(btn => {
      return !btn.disabled && btn.getAttribute('disabled') !== 'true' && !btn.classList.contains('mat-mdc-button-disabled');
    });

    if (activeNextBtn) {
      console.log('[WoS Worker] Sonraki sayfaya geçiliyor...');

      // Human-like pre-click delay
      await _humanDelay(400, 1200);

      const clickEvent = new MouseEvent('click', { view: window, bubbles: true, cancelable: true });
      activeNextBtn.dispatchEvent(clickEvent);
      await waitForListUpdate();
    } else {
      console.log('[WoS Worker] Son sayfa bitti. Taramalar tamamlandı.');
      hasNextPage = false;
    }
  }

  return allArticles;
}

// ═══════════════════════════════════════════════
//  TASK IDENTIFICATION
// ═══════════════════════════════════════════════

function getTaskInfoFromBackground() {
  return new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage({ type: 'GET_TASK_INFO' }, (response) => {
        if (chrome.runtime.lastError) resolve(null);
        else resolve(response);
      });
    } catch (e) { resolve(null); }
  });
}

async function getTaskId() {
  const hashMatch = window.location.hash.match(/wos-task-id=(\d+)/);
  if (hashMatch) return parseInt(hashMatch[1], 10);
  const info = await getTaskInfoFromBackground();
  return info?.taskId || null;
}

// ═══════════════════════════════════════════════
//  VIEW CITATION REPORT - Link bul ve kaydet (detay scraping'den sonra açılacak)
// ═══════════════════════════════════════════════

async function findAndSaveCitationReportLink(taskId, authorWosId) {
  try {
    // "View citation report" linkini bul - çeşitli seçiciler dene
    const citationReportSelectors = [
      'a[href*="citation-report"]',
      'a[data-ta="view-citation-report"]',
      'a[cdxanalyticslabel*="citation-report"]',
      'button[data-ta="view-citation-report"]',
      '.citation-report-link a',
      'a[title*="citation report" i]',
      'a[aria-label*="citation report" i]',
    ];

    let citationReportLink = null;
    for (const selector of citationReportSelectors) {
      const el = document.querySelector(selector);
      if (el) {
        citationReportLink = el;
        console.log(`[WoS Worker] Citation report link found via: ${selector}`);
        break;
      }
    }

    // Eğer link bulunamadıysa, tüm linkleri tara ve metin eşleştir
    if (!citationReportLink) {
      const allLinks = document.querySelectorAll('a, button');
      for (const el of allLinks) {
        const text = (el.textContent || el.innerText || '').toLowerCase();
        const href = el.getAttribute('href') || '';
        if ((text.includes('view citation report') || text.includes('citation report')) && 
            (href.includes('citation-report') || href.includes('citation_report'))) {
          citationReportLink = el;
          console.log(`[WoS Worker] Citation report link found via text match: "${text}"`);
          break;
        }
      }
    }

    if (citationReportLink) {
      let citationReportUrl = citationReportLink.getAttribute('href') || '';
      
      // Relative URL'yi absolute yap
      if (citationReportUrl && !citationReportUrl.startsWith('http')) {
        citationReportUrl = `https://www.webofscience.com${citationReportUrl}`;
      }

      // WoS ID'yi URL'den veya sayfadan çıkar
      let wosId = authorWosId;
      if (!wosId) {
        // URL'den WoS ID çıkarmaya çalış
        const urlMatch = window.location.pathname.match(/\/author\/(?:record\/)?([^\/]+)/);
        if (urlMatch) {
          wosId = urlMatch[1];
        }
      }

      console.log(`[WoS Worker] Citation Report URL saved: ${citationReportUrl}`);
      console.log(`[WoS Worker] Author WoS ID: ${wosId}`);

      // Background'a KAYDET - detay scraping'den sonra açılacak
      // Linki sakla, tab açma
      chrome.runtime.sendMessage({
        type: 'CITATION_REPORT_LINK_SAVED',
        taskId,
        citationReportUrl,
        authorWosId: wosId
      });

      return { url: citationReportUrl, authorWosId: wosId };
    } else {
      console.log('[WoS Worker] Citation report link not found on page');
      return null;
    }
  } catch (err) {
    console.warn('[WoS Worker] Error finding citation report link:', err);
    return null;
  }
}

// ═══════════════════════════════════════════════
//  MAIN ENTRY POINT
// ═══════════════════════════════════════════════

async function run() {
  console.log('[WoS Worker] Content script BAŞLATILDI.');

  let taskId = await getTaskId();
  if (!taskId) {
    console.warn('[WoS Worker] Task ID bulunamadı.');
    return;
  }

  // ── Handshake: Signal that the content script is ready ──
  chrome.runtime.sendMessage({ type: 'SCRAPE_READY', source: 'WOS' });
  console.log('[WoS Worker] SCRAPE_READY signal sent.');

  const taskInfo = await getTaskInfoFromBackground();
  const taskType = taskInfo?.taskType || 'FULL_SCRAPE';
  const externalId = taskInfo?.externalId || null;

  try {
    await waitForInitialLoad();
  } catch (e) {
    chrome.runtime.sendMessage({ type: 'SCRAPE_FAIL', taskId, source: 'WOS', error: e.message });
    return;
  }

  // ── Citation Report Link Bul ve Kaydet ──
  // Sayfa yüklendikten sonra citation report linkini ara ve kaydet
  // Detay scraping tamamlandıktan sonra açılacak
  await _humanDelay(1000, 2000);
  const citationReportInfo = await findAndSaveCitationReportLink(taskId, externalId);
  if (citationReportInfo) {
    console.log('[WoS Worker] Citation report link kaydedildi:', citationReportInfo);
  }

  let authorMetrics = { hIndex: 0, publications: 0, sumOfTimesCited: 0, citingArticles: 0, subjectCategories: [] };

  try {
    // Retry mechanism for metrics with human-like delays
    for (let i = 0; i < 5; i++) {
      authorMetrics = scrapeAuthorMetrics();
      if (authorMetrics.hIndex > 0 || authorMetrics.sumOfTimesCited > 0) break;
      await _humanDelay(800, 1500);
    }

    chrome.runtime.sendMessage({
      type: 'AUTHOR_METRICS_COMPLETE',
      taskId, authorMetrics,
      url: window.location.href,
      source: 'WOS',
    });

    if (taskType === 'METRICS_ONLY') {
      return;
    }

    const articles = await scrapeAllPages();

    // If 0 articles, try clicking Documents tab explicitly and retry
    let finalArticles = articles;
    if (articles.length === 0) {
      console.log('[WoS Worker] 0 article found, retrying after Documents tab click...');
      chrome.runtime.sendMessage({
        type: 'PROGRESS_UPDATE',
        log: 'No articles found, retrying with Documents tab...'
      });
      const tabClicked = await clickDocumentsTab();
      if (tabClicked) {
        finalArticles = await scrapeAllPages();
        console.log(`[WoS Worker] Retry result: ${finalArticles.length} articles found.`);
      }
    }

    chrome.runtime.sendMessage({
      type: 'SCRAPE_DETAILS_NEEDED',
      taskId,
      source: 'WOS',
      authorData: {
        authorMetrics, articles: finalArticles,
        scrapedAt: new Date().toISOString(),
        url: window.location.href,
        source: 'WOS',
      }
    });
  } catch (e) {
    chrome.runtime.sendMessage({ type: 'SCRAPE_FAIL', taskId, source: 'WOS', error: 'Data parsing error: ' + e.message });
  }
}

// Human-like initial delay before starting (not instant script execution)
setTimeout(run, _gaussianRandom(800, 2000));

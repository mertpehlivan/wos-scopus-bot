/**
 * WoS Citation Report Content Script
 * 
 * This script runs on Web of Science "Citation Report" pages and extracts:
 * 1. Researcher profile statistics (from #snChart SVG and totals row)
 * 2. Individual publication citation data (from table.citation-report-records)
 * 
 * The data is then sent to background.js which forwards it to the backend API.
 * 
 * @version 1.2 — Improved DOM selectors and debugging
 */

console.log('[WoS Citation Report] ========== SCRIPT LOADED ==========');
console.log('[WoS Citation Report] URL:', window.location.href);

// ─── Configuration ───────────────────────────────────────────────────────────

const CONFIG = {
    SELECTORS: {
        // Chart selectors - multiple fallbacks
        CHART_BARS: ['#snChart rect.bar', '#snChart rect[aria-label]', 'svg rect.bar', '.chart rect[aria-label]', 'circle.circle', 'rect.bar'],
        CHART_SVG: ['#snChart', 'svg.sn-chart', '.citation-chart svg', 'svg[aria-label="Citation Chart"]'],
        // Table selectors - multiple fallbacks
        PUBLICATION_ROWS: [
            'app-citation-report-record',
            'app-record',
            '.search-results-item',
            'table.citation-report-records tr.record',
            'tr.record',
            'tbody tr.record',
            'tr[class*="record"]',
            'app-citation-report-records tr.record',
            '.record-row',
            '.citation-report-record'
        ],
        TITLE_LINK: [
            'a[data-ta="summary-record-title-link"]',
            'a[href*="full-record"]',
            'a[href*="WOS:"]',
            '[data-ta="title-link"]',
            '.title a',
            'td a',
            'h3 a'
        ],
        // Totals selectors
        TOTALS_ROW: [
            'tr.total',
            'tr[class*="total"]',
            'tfoot tr',
            '.total-row',
            '.grand-total',
            'app-citation-report-totals',
            '.summary-metrics',
            '.citation-report-summary'
        ],
        NUMBER_CELLS: 'td.number, .stat-number, [data-ta*="citation"]',
        CITATION_LINK: 'a.wos-standard-link'
    },
    TIMEOUTS: {
        ELEMENT_WAIT: 90000,  // Increased timeout
        RETRY_INTERVAL: 1000,
        INITIAL_DELAY: 3000   // Increased initial delay
    }
};

// ─── Utility Functions ────────────────────────────────────────────────────────

function humanDelay(min = 500, max = 2000) {
    const delay = Math.floor(Math.random() * (max - min + 1)) + min;
    return new Promise(resolve => setTimeout(resolve, delay));
}

/**
 * Try multiple selectors until one finds elements
 */
function querySelectorWithFallbacks(selectors, parent = document) {
    for (const selector of selectors) {
        try {
            const elements = parent.querySelectorAll(selector);
            if (elements.length > 0) {
                console.log(`[WoS Citation Report] Selector matched: ${selector} (${elements.length} elements)`);
                return elements;
            }
        } catch (e) {
            console.warn(`[WoS Citation Report] Selector failed: ${selector}`, e);
        }
    }
    return [];
}

/**
 * Wait for an element to appear in the DOM with MutationObserver
 */
function waitForElement(selectors, timeout = CONFIG.TIMEOUTS.ELEMENT_WAIT) {
    return new Promise((resolve, reject) => {
        const selectorArray = Array.isArray(selectors) ? selectors : [selectors];

        // Check if already exists
        for (const selector of selectorArray) {
            const element = document.querySelector(selector);
            if (element) {
                console.log(`[WoS Citation Report] Element already exists: ${selector}`);
                resolve(element);
                return;
            }
        }

        const observer = new MutationObserver((mutations, obs) => {
            for (const selector of selectorArray) {
                const el = document.querySelector(selector);
                if (el) {
                    obs.disconnect();
                    console.log(`[WoS Citation Report] Element found via observer: ${selector}`);
                    resolve(el);
                    return;
                }
            }
        });

        observer.observe(document.body, {
            childList: true,
            subtree: true,
            attributes: true,
            attributeFilter: ['class', 'aria-label']
        });

        setTimeout(() => {
            observer.disconnect();
            // Final check
            for (const selector of selectorArray) {
                const el = document.querySelector(selector);
                if (el) {
                    resolve(el);
                    return;
                }
            }
            reject(new Error(`Elements not found within ${timeout}ms. Tried: ${selectorArray.join(', ')}`));
        }, timeout);
    });
}

/**
 * Wait for multiple elements to appear
 */
function waitForElements(selectors, minCount = 1, timeout = CONFIG.TIMEOUTS.ELEMENT_WAIT) {
    return new Promise((resolve, reject) => {
        const selectorArray = Array.isArray(selectors) ? selectors : [selectors];

        // Check if already exists
        for (const selector of selectorArray) {
            const elements = document.querySelectorAll(selector);
            if (elements.length >= minCount) {
                console.log(`[WoS Citation Report] Elements already exist: ${selector} (${elements.length})`);
                resolve(elements);
                return;
            }
        }

        const observer = new MutationObserver((mutations, obs) => {
            for (const selector of selectorArray) {
                const els = document.querySelectorAll(selector);
                if (els.length >= minCount) {
                    obs.disconnect();
                    console.log(`[WoS Citation Report] Elements found via observer: ${selector} (${els.length})`);
                    resolve(els);
                    return;
                }
            }
        });

        observer.observe(document.body, {
            childList: true,
            subtree: true,
            attributes: true,
            attributeFilter: ['class', 'aria-label']
        });

        setTimeout(() => {
            observer.disconnect();
            // Final check
            for (const selector of selectorArray) {
                const els = document.querySelectorAll(selector);
                if (els.length >= minCount) {
                    resolve(els);
                    return;
                }
            }
            // Log all available elements for debugging
            console.log('[WoS Citation Report] Available tables:', document.querySelectorAll('table'));
            console.log('[WoS Citation Report] Available tr elements:', document.querySelectorAll('tr'));
            console.log('[WoS Citation Report] Available SVGs:', document.querySelectorAll('svg'));
            reject(new Error(`Only found < ${minCount} elements. Tried: ${selectorArray.join(', ')}`));
        }, timeout);
    });
}

/**
 * Parse number from text
 */
function parseNumber(text) {
    if (!text) return null;
    const cleaned = text.trim().replace(/,/g, '').replace(/\s+/g, '');
    const num = parseFloat(cleaned);
    return isNaN(num) ? null : num;
}

/**
 * Extract WoS ID from URL
 */
function extractWosId(href) {
    if (!href) return null;
    const match = href.match(/(WOS:[A-Z0-9]+)/i);
    return match ? match[1] : null;
}

/**
 * Get task ID and author WoS ID from URL hash or background script
 */
async function getTaskInfo() {
    // 1. Ask background script based on our Tab ID
    try {
        const bgInfo = await new Promise((resolve) => {
            chrome.runtime.sendMessage({ type: 'GET_CITATION_TASK' }, (response) => {
                resolve(response || {});
            });
        });

        if (bgInfo && bgInfo.taskId) {
            console.log(`[WoS Citation Report] Task info received from background:`, bgInfo);
            return bgInfo;
        }
    } catch (err) {
        console.warn('[WoS Citation Report] Failed querying background for task info:', err);
    }

    // 2. Fallback to URL hash
    const hash = window.location.hash;
    console.log('[WoS Citation Report] Fallback URL hash:', hash);

    const taskIdMatch = hash.match(/citation-report-task-id=(\d+)/);
    const authorIdMatch = hash.match(/author-wos-id=([^&]+)/);

    return {
        taskId: taskIdMatch ? parseInt(taskIdMatch[1], 10) : null,
        authorWosId: authorIdMatch ? decodeURIComponent(authorIdMatch[1]) : null
    };
}

// ─── Data Extraction Functions ────────────────────────────────────────────────

/**
 * Extract yearly statistics (publications + citations per year) from the chart.
 *
 * The "Times Cited and Publications Over Time" chart in #snChart contains two
 * kinds of SVG elements that both carry the same data in their aria-label:
 *   - <rect class="bar"> for publications (purple bars)
 *   - <circle class="circle"> for citations (line markers, opacity:0)
 *
 * Each aria-label has one of these formats — order of "Publications" and
 * "Citations" depends on which element it is:
 *   "For year 2010 with 1 Publications and 0 Citations"
 *   "For year 2010 with 0 Citations and 1 Publications"
 *
 * Strategy: target every aria-labelled descendant of #snChart, parse the
 * label using a single regex that captures both numbers + their kinds, then
 * dedup by year.
 */
async function extractYearlyStats() {
    console.log('[WoS Citation Report] Extracting yearly chart data...');

    const CHART_ARIA_SEL = '#snChart [aria-label*="For year"]';
    // Format: "For year YYYY with N {Publications|Citations} and M {Publications|Citations}"
    const ARIA_REGEX = /For year (\d{4}) with (\d+)\s*(Publications?|Citations?)\s+and\s+(\d+)\s*(Publications?|Citations?)/i;

    try {
        // 1. Wait until the chart has rendered at least one labelled element.
        await waitForElements([CHART_ARIA_SEL, ...CONFIG.SELECTORS.CHART_BARS], 1, 20000);

        // 2. Wait for the count to stabilise — the chart animates in and we
        //    don't want to read it mid-render. Poll up to ~5s for the count
        //    to stop changing.
        let lastCount = -1;
        for (let i = 0; i < 8; i++) {
            const c = document.querySelectorAll(CHART_ARIA_SEL).length;
            if (c > 0 && c === lastCount) break;
            lastCount = c;
            await humanDelay(500, 700);
        }

        const elements = Array.from(document.querySelectorAll(CHART_ARIA_SEL));
        console.log(`[WoS Citation Report] Chart elements found: ${elements.length}`);

        const statsMap = new Map();
        let unparsed = 0;

        for (const el of elements) {
            const aria = (el.getAttribute('aria-label') || '').replace(/,/g, '');
            const m = aria.match(ARIA_REGEX);
            if (!m) {
                unparsed++;
                console.warn('[WoS Citation Report] Could not parse aria-label:', aria);
                continue;
            }

            const year = parseInt(m[1], 10);
            const firstNum = parseInt(m[2], 10);
            const firstIsPub = /^publ/i.test(m[3]);
            const secondNum = parseInt(m[4], 10);

            const publications = firstIsPub ? firstNum : secondNum;
            const citations = firstIsPub ? secondNum : firstNum;

            // Both rect (publications-first label) and circle (citations-first
            // label) carry identical numbers, so the first occurrence per
            // year is authoritative.
            if (!statsMap.has(year)) {
                statsMap.set(year, { year, publications, citations });
            }
        }

        if (unparsed > 0) {
            console.warn(`[WoS Citation Report] ${unparsed} aria-labels failed to parse`);
        }

        const yearlyStats = Array.from(statsMap.values()).sort((a, b) => a.year - b.year);

        // Sanity check: log totals so we can compare against the page header.
        const totalCit = yearlyStats.reduce((s, y) => s + y.citations, 0);
        const totalPub = yearlyStats.reduce((s, y) => s + y.publications, 0);
        console.log(
            `[WoS Citation Report] Extracted ${yearlyStats.length} years; ` +
            `Σpublications=${totalPub}, Σcitations=${totalCit}`,
            yearlyStats
        );

        return yearlyStats;
    } catch (error) {
        console.warn('[WoS Citation Report] Could not extract yearly stats:', error.message);
        return [];
    }
}

/**
 * Extract overall totals from the table footer
 */
async function extractTotals() {
    console.log('[WoS Citation Report] Extracting totals...');

    let totalAveragePerYear = null;
    let overallTotalCitations = null;

    try {
        // ── Strategy A: explicit "Sum of Times Cited" / "Total Citations"
        //    metric block. Modern WoS Citation Report renders these as
        //    discrete metric tiles (`app-citation-report-summary` /
        //    `.summary-metrics`) — find the value paired with each label.
        const findMetricByLabel = (labelKeywords) => {
            const all = document.querySelectorAll(
                'app-citation-report-summary *, .summary-metrics *, .citation-report-summary *, app-citation-report-totals *, mat-card *, .summary-section *');
            for (const el of all) {
                const text = (el.textContent || '').replace(/\s+/g, ' ').trim().toLowerCase();
                if (text.length === 0 || text.length > 60) continue;
                if (!labelKeywords.some(k => text.includes(k))) continue;
                // Look near this element for a numeric sibling/child.
                const container = el.closest('[class*="metric"], [class*="summary-item"], div, p, mat-card-content') || el.parentElement;
                if (!container) continue;
                const numberEl = container.querySelector(
                    '.metric-value, .stat-number, .summary-count, [class*="metric-value"], [class*="summary-count"]');
                if (numberEl) {
                    const n = parseNumber(numberEl.textContent);
                    if (n !== null) return n;
                }
                // Fallback: scan container's text for the first big integer.
                const m = (container.textContent || '').match(/(\d[\d,]*)/);
                if (m) {
                    const n = parseNumber(m[1]);
                    if (n !== null && n > 0) return n;
                }
            }
            return null;
        };

        const sumCited = findMetricByLabel(['sum of times cited', 'times cited', 'total citations']);
        if (sumCited !== null) {
            overallTotalCitations = sumCited;
            console.log('[WoS Citation Report] Strategy A: Sum of Times Cited =', sumCited);
        }
        const avgCited = findMetricByLabel(['average citations per item', 'average per item', 'average per year']);
        if (avgCited !== null) {
            totalAveragePerYear = avgCited;
            console.log('[WoS Citation Report] Strategy A: Average =', avgCited);
        }

        // ── Strategy B (existing): table totals row. Used when the
        //    page exposes a classic <tr> "Total" row alongside the
        //    metric tiles, or when Strategy A misses one of the two
        //    fields.
        // Find the totals row - look for "Total" text in any cell
        const allRows = document.querySelectorAll('tr, .total-row, app-citation-report-totals, .summary-metrics, .citation-report-summary');
        let totalsRow = null;

        for (const row of allRows) {
            const cells = row.querySelectorAll('td, th, span, div, a');
            for (const cell of cells) {
                if (cell.textContent.trim().toLowerCase().includes('total')) {
                    totalsRow = row;
                    console.log('[WoS Citation Report] Found totals row:', row);
                    break;
                }
            }
            if (totalsRow) break;
        }

        if (totalsRow) {
            const allCells = totalsRow.querySelectorAll('td, th, span.stat-number, div.stat-number, div.metric-value');
            console.log(`[WoS Citation Report] Totals row has ${allCells.length} cells`);

            const cellTexts = Array.from(allCells).map((td, idx) => {
                const text = td.textContent.trim();
                console.log(`[WoS Citation Report] Cell ${idx}: "${text}"`);
                return text;
            });

            // Parse all numbers
            const numbers = cellTexts.map(text => parseNumber(text)).filter(n => n !== null);
            console.log('[WoS Citation Report] Parsed numbers:', numbers);

            // Find average (has decimal) and total (largest integer)
            for (const text of cellTexts) {
                const num = parseNumber(text);
                if (num !== null) {
                    if (text.includes('.') || text.includes(',')) {
                        // Likely an average
                        if (totalAveragePerYear === null || num > totalAveragePerYear) {
                            totalAveragePerYear = num;
                        }
                    } else if (num > (overallTotalCitations || 0)) {
                        overallTotalCitations = num;
                    }
                }
            }
        } else {
            console.warn('[WoS Citation Report] No totals row found');
        }

        console.log(`[WoS Citation Report] Totals - Avg: ${totalAveragePerYear}, Total: ${overallTotalCitations}`);
    } catch (error) {
        console.warn('[WoS Citation Report] Could not extract totals:', error.message);
    }

    return { totalAveragePerYear, overallTotalCitations };
}

/**
 * Extract publication data from the citation report table
 */
async function extractPublications() {
    console.log('[WoS Citation Report] Extracting publications...');
    // Step 2: Extract Publications Data
    const publications = [];
    console.log('[WoS Citation Report] Found table rows:', Array.from(document.querySelectorAll(CONFIG.SELECTORS.PUBLICATION_ROWS.join(', '))).length);

    // Try multiple selectors until one works
    let rows = querySelectorWithFallbacks(CONFIG.SELECTORS.PUBLICATION_ROWS);
    console.log(`[WoS Citation Report] Found ${rows.length} publication rows`);

    if (rows.length === 0) {
        // Log what's actually in the page
        console.log('[WoS Citation Report] No rows found. Logging page structure...');
        const allLinks = document.querySelectorAll('a[href*="WOS:"], a[href*="full-record"]');
        console.log(`[WoS Citation Report] Found ${allLinks.length} WoS links in page`);

        allLinks.forEach((link, idx) => {
            console.log(`[WoS Citation Report] Link ${idx}:`, link.href, link.textContent.substring(0, 50));
        });
    }

    try {
        // Try to scrape publication data rows
        rows.forEach((row, index) => {
            try {
                console.log(`[WoS Citation Report] Processing row ${index}...`);

                // Extract title and WoS ID
                const titleLinks = querySelectorWithFallbacks(CONFIG.SELECTORS.TITLE_LINK, row);
                const titleLink = titleLinks[0];

                if (!titleLink) {
                    console.warn(`[WoS Citation Report] Row ${index}: No title link found`);
                    // Try to find any link
                    const anyLink = row.querySelector('a');
                    if (anyLink) {
                        console.log(`[WoS Citation Report] Row ${index}: Found alternative link:`, anyLink.href);
                    }
                    return;
                }

                const title = titleLink.textContent.trim();
                const href = titleLink.getAttribute('href') || '';
                const wosId = extractWosId(href);

                console.log(`[WoS Citation Report] Row ${index}: title="${title.substring(0, 50)}...", wosId=${wosId}`);

                // Extract citation numbers
                const numberCells = row.querySelectorAll('td.number, td[class*="number"], td.align-right, .stat-number, [data-ta*="citation"], [class*="citation-count"], .citations');
                let totalCitations = null;
                let averagePerYear = null;

                // 1. Try explicit elements first
                const explicitTotal = row.querySelector('[data-ta="citation-report-record-total"], [class*="total-citations"], .total-column');
                if (explicitTotal) {
                    totalCitations = parseNumber(explicitTotal.textContent);
                }
                const explicitAvg = row.querySelector('[data-ta="citation-report-record-average"], [class*="average-citations"], .average-column');
                if (explicitAvg) {
                    averagePerYear = parseNumber(explicitAvg.textContent);
                }

                // 2. Try the general number cells
                if (totalCitations === null && numberCells.length > 0) {
                    console.log(`[WoS Citation Report] Row ${index}: ${numberCells.length} number cells`);

                    numberCells.forEach((td, idx) => {
                        const text = td.textContent.trim();
                        const num = parseNumber(text);
                        console.log(`[WoS Citation Report] Row ${index}, cell ${idx}: "${text}" -> ${num}`);

                        if (num !== null) {
                            if (text.includes('.')) {
                                averagePerYear = num;
                            } else if (num > (totalCitations || 0)) {
                                totalCitations = num;
                            }
                        }
                    });
                }

                // Alternative: Look for any number in the row
                if (totalCitations === null) {
                    const allCellTexts = Array.from(row.querySelectorAll('td, span, div')).map(el => el.textContent.trim()).filter(t => t.length > 0);
                    console.log(`[WoS Citation Report] Row ${index} all cells:`, allCellTexts.slice(0, 10));

                    // Specific logic for recent WoS where columns are years, Total, Average
                    // Let's filter texts that represent purely numbers and > 0, ignoring obvious year values
                    const nums = allCellTexts.map(t => parseNumber(t)).filter(n => n !== null && n > 0 && n < 1900); // 1900+ usually years
                    if (nums.length > 0) {
                        // The max represents total citations usually
                        const safeInts = nums.filter(n => n % 1 === 0);
                        if (safeInts.length > 0) {
                            totalCitations = Math.max(...safeInts);
                        } else {
                            totalCitations = Math.max(...nums);
                        }
                    }

                    const floats = allCellTexts.map(t => parseNumber(t)).filter(n => n !== null && n > 0 && n % 1 !== 0);
                    if (floats.length > 0) {
                        averagePerYear = Math.max(...floats);
                    }
                }

                if (totalCitations !== null || wosId) {
                    publications.push({
                        wosId,
                        title,
                        totalCitations,
                        averagePerYear
                    });
                }

            } catch (rowError) {
                console.warn('[WoS Citation Report] Error parsing row:', rowError);
            }
        });

        console.log(`[WoS Citation Report] Extracted ${publications.length} publications`);
    } catch (error) {
        console.warn('[WoS Citation Report] Could not extract publications:', error.message);
    }

    return publications;
}

/**
 * Get author WoS ID from the page (fallback)
 */
function getAuthorWosIdFromPage() {
    // Try URL params
    const urlMatch = window.location.href.match(/[&?]author=([^&]+)/);
    if (urlMatch) {
        return decodeURIComponent(urlMatch[1]);
    }

    // Try to find in page content
    const authorIdElement = document.querySelector('[data-author-id]');
    if (authorIdElement) {
        return authorIdElement.getAttribute('data-author-id');
    }

    // Try to find in page title or header
    const headerText = document.querySelector('h1, .page-title, .citation-report-title');
    if (headerText) {
        const idMatch = headerText.textContent.match(/[A-Z]{2,}-[A-Z0-9]+/);
        if (idMatch) {
            return idMatch[0];
        }
    }

    return null;
}

// ─── Main Sync Function ───────────────────────────────────────────────────────

/**
 * Main function to extract all data and send to background.js
 */
async function syncCitationReport() {
    console.log('[WoS Citation Report] ========== STARTING SYNC ==========');

    const { taskId, authorWosId: urlAuthorId } = await getTaskInfo();
    console.log('[WoS Citation Report] Task ID:', taskId, 'Author WoS ID:', urlAuthorId);

    if (!taskId) {
        console.warn('[WoS Citation Report] No task ID found. Running in standalone mode.');
        showNotification('No task ID - standalone mode', 'info');
    }

    try {
        // Wait for page to fully load
        console.log('[WoS Citation Report] Waiting for page elements...');

        // Log current page state
        console.log('[WoS Citation Report] Document ready state:', document.readyState);
        console.log('[WoS Citation Report] Body innerHTML length:', document.body?.innerHTML?.length || 0);

        // Wait for publications table (primary data)
        let publications = [];
        try {
            await waitForElements(CONFIG.SELECTORS.PUBLICATION_ROWS, 1, 15000);
            await humanDelay(2000, 3000);
            publications = await extractPublications();
        } catch (waitErr) {
            console.error('[WoS Citation Report] Failed to find publication rows:', waitErr);
            showNotification('Could not find publication data, but will try scraping other stats...', 'warning');
        }

        // Extract yearly stats (optional)
        const yearlyStats = await extractYearlyStats();

        // Extract totals (optional)
        const totals = (await extractTotals()) || {};

        // Fallback: derive totals from the yearly chart when the totals
        // row scrape failed. The bar chart's aria-labels are the most
        // reliable signal on the page — every year is reported with both
        // its citation and publication counts, so summing them gives the
        // overall total. The "average per year" displayed by WoS is the
        // simple arithmetic mean across the years shown.
        let overallTotalCitations = totals.overallTotalCitations;
        let totalAveragePerYear = totals.totalAveragePerYear;
        if ((overallTotalCitations == null || totalAveragePerYear == null)
                && yearlyStats && yearlyStats.length > 0) {
            const sumCit = yearlyStats.reduce(
                (s, y) => s + (typeof y.citations === 'number' ? y.citations : 0), 0);
            if (overallTotalCitations == null) {
                overallTotalCitations = sumCit;
                console.log('[WoS Citation Report] overallTotalCitations derived from yearlyStats:', sumCit);
            }
            if (totalAveragePerYear == null && yearlyStats.length > 0) {
                totalAveragePerYear = +(sumCit / yearlyStats.length).toFixed(2);
                console.log('[WoS Citation Report] totalAveragePerYear derived from yearlyStats:', totalAveragePerYear);
            }
        }

        // Build the payload
        const authorWosId = urlAuthorId || getAuthorWosIdFromPage();
        const payload = {
            authorWosId: authorWosId || 'unknown',
            researcherProfileStats: {
                totalAveragePerYear: totalAveragePerYear ?? null,
                overallTotalCitations: overallTotalCitations ?? null,
                yearlyStats: yearlyStats || []
            },
            publications
        };

        console.log('[WoS Citation Report] ========== PAYLOAD PREPARED ==========');
        console.log('[WoS Citation Report] Payload:', JSON.stringify(payload, null, 2));

        // Always send to background.js
        console.log(`[WoS Citation Report] Sending data to background... (taskId: ${taskId || "unknown"})`);
        showNotification(`Processing ${publications.length} publications...`, 'info');

        chrome.runtime.sendMessage({
            type: 'CITATION_REPORT_COMPLETE',
            taskId: taskId || null,
            data: payload
        }, (response) => {
            if (chrome.runtime.lastError) {
                console.error('[WoS Citation Report] Failed to send to background:', chrome.runtime.lastError);
                showNotification('Failed to sync data: ' + chrome.runtime.lastError.message, 'error');
            } else {
                console.log('[WoS Citation Report] Background response:', response);
                showNotification(`✓ Citation report synced! (${publications.length} publications)`, 'success');
            }
        });

        return payload;

    } catch (error) {
        console.error('[WoS Citation Report] ========== SYNC ERROR ==========');
        console.error('[WoS Citation Report] Error:', error);
        showNotification('Sync error: ' + error.message, 'error');

        // Always Report failure to background
        chrome.runtime.sendMessage({
            type: 'CITATION_REPORT_COMPLETE',
            taskId: taskId || null,
            data: null,
            error: error.message
        });
    }
}
/**
 * Show notification to user
 */
function showNotification(message, type = 'info') {
    console.log(`[WoS Citation Report] Notification (${type}): ${message}`);

    const notification = document.createElement('div');
    notification.id = 'wos-citation-report-notification';
    notification.style.cssText = `
        position: fixed;
        top: 20px;
        right: 20px;
        padding: 15px 20px;
        border-radius: 8px;
        color: white;
        font-family: Arial, sans-serif;
        font-size: 14px;
        z-index: 10000;
        box-shadow: 0 4px 12px rgba(0,0,0,0.3);
        background: ${type === 'success' ? '#4CAF50' : type === 'error' ? '#f44336' : '#2196F3'};
        transition: opacity 0.3s ease;
        max-width: 300px;
    `;
    notification.textContent = message;

    // Remove existing notification
    const existing = document.getElementById('wos-citation-report-notification');
    if (existing) existing.remove();

    document.body.appendChild(notification);

    setTimeout(() => {
        notification.style.opacity = '0';
        setTimeout(() => notification.remove(), 300);
    }, 5000);
}

// ─── Initialization ──────────────────────────────────────────────────────────

console.log('[WoS Citation Report] Setting up initialization...');

/**
 * Detect WoS's "stale qid → Smart Search redirect" failure mode.
 * The Citation-Report URL we saved on the author page embeds a query
 * id (`qid`) that's session-bound; by the time the worker re-opens
 * the URL after detail-scraping (which can take many minutes) the qid
 * has expired and WoS silently sends the tab to the Smart Search
 * home (or /search/eo/) instead of rendering the report. Our scraper
 * then sits there waiting for selectors that never appear, eats the
 * 90 s timeout, and the task fails with an unhelpful "no chart bars
 * found".
 *
 * <p>This helper runs early and reports the redirect to background.js
 * so it can recover (re-open the author profile, fetch a fresh
 * Citation-Report URL with a live qid, retry) instead of letting the
 * scraper churn against the wrong page.
 */
function isStaleCitationReportRedirect() {
    const path = window.location.pathname || '';
    // Anything outside /citation-report/* is the wrong page. WoS
    // redirects most commonly to /wos/woscc/basic-search,
    // /wos/woscc/search, /wos/alldb/basic-search, or the bare
    // /wos/woscc/ home.
    if (path.includes('/citation-report')) return false;
    return path.includes('/basic-search')
        || path.includes('/search')
        || path === '/wos/woscc/'
        || path === '/wos/alldb/'
        || path === '/wos/';
}

function reportStaleRedirect() {
    try {
        const taskId = (window.location.hash || '').match(/citation-report-task-id=([^&]+)/);
        const wosId = (window.location.hash || '').match(/author-wos-id=([^&]+)/);
        chrome.runtime.sendMessage({
            type: 'CITATION_REPORT_STALE_REDIRECT',
            redirectedTo: window.location.href,
            taskId: taskId ? decodeURIComponent(taskId[1]) : null,
            authorWosId: wosId ? decodeURIComponent(wosId[1]) : null,
        });
    } catch (e) {
        console.warn('[WoS Citation Report] Could not notify background of stale redirect:', e);
    }
}

// Early redirect check — runs immediately, no startDelay. The user
// sees this as Smart Search "Welcome, ..." with no citation report
// content; trying to scrape that wastes 90 s waiting for selectors
// that will never match.
if (isStaleCitationReportRedirect()) {
    console.warn('[WoS Citation Report] Redirected away from /citation-report; URL is stale:',
            window.location.href);
    reportStaleRedirect();
} else {
    // Run after page stabilizes
    const startDelay = CONFIG.TIMEOUTS.INITIAL_DELAY + Math.random() * 1000;

    setTimeout(() => {
        // Recheck — Angular sometimes navigates client-side between
        // load and our timer firing.
        if (isStaleCitationReportRedirect()) {
            console.warn('[WoS Citation Report] Stale redirect detected after delay');
            reportStaleRedirect();
            return;
        }
        console.log('[WoS Citation Report] Starting after initial delay...');
        syncCitationReport().catch(err => {
            console.error('[WoS Citation Report] Unhandled error:', err);
        });
    }, startDelay);
}

// Listen for messages from popup/background
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    console.log('[WoS Citation Report] Received message:', request);

    if (request.action === 'syncCitationReport') {
        syncCitationReport()
            .then(data => sendResponse({ success: true, data }))
            .catch(error => sendResponse({ success: false, error: error.message }));
        return true; // Keep channel open for async response
    }
});
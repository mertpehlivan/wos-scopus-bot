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
 * Extract yearly statistics from the SVG bar chart
 */
async function extractYearlyStats() {
    console.log('[WoS Citation Report] Extracting yearly stats from chart...');

    const statsMap = new Map();

    try {
        // Wait for chart to render actually bars or circles
        await waitForElements(CONFIG.SELECTORS.CHART_BARS, 1, 15000);
        await humanDelay(1000, 2000);

        // Try getting all bars matching any of the selectors
        const bars = [];
        for (const selector of CONFIG.SELECTORS.CHART_BARS) {
            try {
                const elements = document.querySelectorAll(selector);
                if (elements.length > 0) {
                    elements.forEach(el => {
                        if (!bars.includes(el)) bars.push(el);
                    });
                }
            } catch (e) {
                // ignore invalid selectors
            }
        }

        console.log(`[WoS Citation Report] Found ${bars.length} unique chart bars/circles`);

        bars.forEach((bar, index) => {
            const ariaLabel = bar.getAttribute('aria-label');
            if (!ariaLabel) {
                // Try to get data from other attributes
                const dataYear = bar.getAttribute('data-year');
                const dataPub = bar.getAttribute('data-publications');
                const dataCit = bar.getAttribute('data-citations');

                if (dataYear) {
                    const year = parseInt(dataYear, 10);
                    if (!statsMap.has(year)) {
                        statsMap.set(year, {
                            year: year,
                            publications: parseInt(dataPub || '0', 10),
                            citations: parseInt(dataCit || '0', 10)
                        });
                    }
                    return;
                }

                console.log(`[WoS Citation Report] Bar ${index}: No aria-label, trying title...`);
                // Try title attribute
                const title = bar.getAttribute('title');
                if (title) {
                    const cleanTitle = title.replace(/,/g, '');
                    const match = cleanTitle.match(/(\d{4}).*?(\d+).*?(\d+)/i);
                    if (match) {
                        const year = parseInt(match[1], 10);
                        if (!statsMap.has(year)) {
                            statsMap.set(year, {
                                year: year,
                                publications: parseInt(match[2], 10),
                                citations: parseInt(match[3], 10)
                            });
                        }
                    }
                }
                return;
            }

            console.log(`[WoS Citation Report] Bar ${index} aria-label:`, ariaLabel);
            const cleanAria = ariaLabel.replace(/,/g, '');

            // Parse aria-label: "For year 2010 with 1 Publications and 0 Citations"
            // Also try alternative formats
            let match = cleanAria.match(/For year (\d{4}) with (\d+)\s*Publications? and (\d+)\s*Citations?/i);
            if (!match) {
                // Alternative order: For year 2010 with 0 Citations and 1 Publications
                let altMatch = cleanAria.match(/For year (\d{4}) with (\d+)\s*Citations? and (\d+)\s*Publications?/i);
                if (altMatch) {
                    match = [altMatch[0], altMatch[1], altMatch[3], altMatch[2]]; // Output as [full, year, pub, cit]
                }
            }
            if (!match) {
                match = cleanAria.match(/(\d{4})[.:]\s*(\d+)\s*pub.*?,\s*(\d+)\s*cit/i);
            }
            if (!match) {
                match = cleanAria.match(/Year\s*(\d{4}).*?(\d+)\s*pub.*?(\d+)\s*cit/i);
            }

            if (match) {
                const year = parseInt(match[1], 10);
                const pubs = parseInt(match[2], 10);
                const cits = parseInt(match[3], 10);

                // Deduplicate by year since circles and rects contain the same data
                if (!statsMap.has(year)) {
                    statsMap.set(year, {
                        year: year,
                        publications: pubs,
                        citations: cits
                    });
                }
            } else {
                console.log(`[WoS Citation Report] Bar ${index}: Failed to parse aria-label "${ariaLabel}"`);
            }
        });

        const yearlyStats = Array.from(statsMap.values());

        // Sort by year
        yearlyStats.sort((a, b) => a.year - b.year);

        console.log(`[WoS Citation Report] Extracted ${yearlyStats.length} yearly stats:`, yearlyStats);
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

        // Build the payload
        const authorWosId = urlAuthorId || getAuthorWosIdFromPage();
        const payload = {
            authorWosId: authorWosId || 'unknown',
            researcherProfileStats: {
                totalAveragePerYear: totals.totalAveragePerYear || null,
                overallTotalCitations: totals.overallTotalCitations || null,
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

// Run after page stabilizes
const startDelay = CONFIG.TIMEOUTS.INITIAL_DELAY + Math.random() * 1000;

setTimeout(() => {
    console.log('[WoS Citation Report] Starting after initial delay...');
    syncCitationReport().catch(err => {
        console.error('[WoS Citation Report] Unhandled error:', err);
    });
}, startDelay);

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
/**
 * article_detail.js
 * WoS makale detay sayfası (full-record) için content script.
 * - "View Journal Impact" butonuna tıklar, sidenav açılınca JCR verilerini çeker.
 * - "See more data fields" butonuna tıklayarak gizli alanları açar.
 * - Abstract için "Show more" / expand butonuna tıklar.
 * - Keywords, Q değeri (indexType), ve document type mapping yapar.
 *
 * v1.3 — Full detail injection: keywords, abstract expand, Q-value, doc type mapping
 */

// ── WoS Document Type → System Publication Type Mapping ──────────────────────
const WOS_TO_SYSTEM_TYPE = {
    // Temel Akademik Yayınlar
    'article': 'article',
    'review': 'review',
    'review article': 'review',
    'proceedings paper': 'proceedings_paper',
    'book': 'book',
    'book chapter': 'book_chapter',
    'data paper': 'data_paper',

    // Editöryal ve Eleştiri Yayınları
    'editorial material': 'editorial_material',
    'editorial': 'editorial_material',
    'letter': 'letter',
    'meeting abstract': 'meeting_abstract',
    'news item': 'news_item',
    'discussion': 'discussion',
    'correction': 'correction',

    // Düzeltme ve Güncellemeler
    'retraction': 'retraction',
    'retracted publication': 'retraction',
    'expression of concern': 'expression_of_concern',
    'reprint': 'reprint',

    // Sanat ve Beşeri Bilimler
    'art exhibit review': 'art_exhibit_review',
    'film review': 'film_review',
    'music score': 'music_score',
    'music score review': 'music_score_review',
    'music performance review': 'music_performance_review',
    'dance performance review': 'dance_performance_review',
    'poetry': 'poetry',
    'fiction': 'fiction',
    'fiction, creative writing': 'fiction',
    'creative writing': 'fiction',
    'script': 'script',
    'theater review': 'theater_review',

    // Diğerleri
    'biographical-item': 'biographical_item',
    'biographical item': 'biographical_item',
    'bibliography': 'bibliography',
    'book review': 'book_review',
    'chronology': 'chronology',
    'excerpt': 'excerpt',
    'hardware review': 'hardware_review',
    'software review': 'software_review',
};

function mapWosDocType(wosType) {
    if (!wosType) return null;
    return WOS_TO_SYSTEM_TYPE[wosType.toLowerCase().trim()] || null;
}

// ── Stealth utilities ──────────────────────────────────────────────────────────
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

function getText(selector, root = document) {
    return root.querySelector(selector)?.textContent?.trim() || '';
}

async function waitForDetailLoad() {
    let spinnerFound = false;
    for (let i = 0; i < 30; i++) {
        const spinner = document.querySelector('.spinner-lightbox, .cdx-spinner, mat-spinner');
        if (!spinner) break;

        const s = window.getComputedStyle(spinner);
        if (s.visibility === 'hidden' || s.display === 'none' || s.opacity === '0') break;

        spinnerFound = true;
        await _humanDelay(400, 700);
    }
    await _humanDelay(spinnerFound ? 800 : 200, spinnerFound ? 1500 : 500);
}

// ── Click "See more data fields" to reveal hidden section ─────────────────────
async function openHiddenSection() {
    const btn = document.querySelector('[data-ta="HiddenSecTa-showMoreDataButton"], #HiddenSecTa-showMoreDataButton');
    if (!btn) return false;

    const style = window.getComputedStyle(btn);
    if (style.display === 'none') return false;

    await _humanDelay(200, 500);
    btn.dispatchEvent(new MouseEvent('click', { view: window, bubbles: true, cancelable: true }));
    await _humanDelay(600, 1200);
    return true;
}

// ── Click abstract "Show more" / expand button ────────────────────────────────
async function expandAbstract() {
    // Try various abstract expand button selectors used by WoS
    const expandSelectors = [
        '[data-ta="show-more-abstract"]',
        '[id*="abstract-show-more"]',
        '[id*="abstractShowMore"]',
        '.abstract-show-more button',
        'button[aria-label*="abstract"]',
        '.show-abstract-button',
        '[data-ta="FullRTa-abstractShowMore"]',
        'button.show-more-less-abstract',
    ];

    for (const sel of expandSelectors) {
        const btn = document.querySelector(sel);
        if (btn && window.getComputedStyle(btn).display !== 'none') {
            await _humanDelay(200, 500);
            btn.dispatchEvent(new MouseEvent('click', { view: window, bubbles: true, cancelable: true }));
            await _humanDelay(500, 1000);
            return true;
        }
    }

    // Also try mat-expansion-panel for abstract
    const expansionPanels = document.querySelectorAll('mat-expansion-panel');
    for (const panel of expansionPanels) {
        const header = panel.querySelector('mat-expansion-panel-header');
        const txt = header?.textContent?.toLowerCase() || '';
        if (txt.includes('abstract')) {
            const isExpanded = panel.classList.contains('mat-expanded') ||
                panel.getAttribute('aria-expanded') === 'true';
            if (!isExpanded) {
                await _humanDelay(200, 500);
                header.dispatchEvent(new MouseEvent('click', { view: window, bubbles: true, cancelable: true }));
                await _humanDelay(600, 1200);
            }
            return true;
        }
    }
    return false;
}

// ── Open JCR Sidenav ──────────────────────────────────────────────────────────
async function openJcrSidenav() {
    const btn = document.querySelector('[data-ta="jcr-link"]');
    if (!btn) return false;

    await _humanDelay(300, 800);

    const originalHref = btn.getAttribute('href');
    if (originalHref && originalHref.startsWith('javascript:')) {
        btn.removeAttribute('href');
    }

    const clickEvent = new MouseEvent('click', { view: window, bubbles: true, cancelable: true });
    btn.dispatchEvent(clickEvent);

    if (originalHref) {
        btn.setAttribute('href', originalHref);
    }

    for (let i = 0; i < 20; i++) {
        await _humanDelay(150, 350);
        const sidenav = document.querySelector('mat-sidenav.jcr-sidenav');
        if (sidenav && window.getComputedStyle(sidenav).visibility !== 'hidden') {
            await _humanDelay(400, 900);
            return true;
        }
    }

    return false;
}

// ── Extract abstract text (full) ──────────────────────────────────────────────
function extractAbstract() {
    // Primary selectors
    const selectors = [
        '[data-ta="FullRTa-abstract-basic"] p',
        '#FullRTa-abstract-basic p',
        '.abstract-text p',
        '[data-ta="FullRTa-abstract"] p',
        '#snMainArticle [class*="abstract"] p',
        'p.value[lang]',
    ];

    for (const sel of selectors) {
        const el = document.querySelector(sel);
        if (el?.textContent?.trim()) return el.textContent.trim();
    }

    // Collect all paragraphs inside abstract container
    const abstractContainers = [
        document.querySelector('[data-ta="FullRTa-abstract-basic"]'),
        document.querySelector('#FullRTa-abstract-basic'),
        document.querySelector('.abstract-text'),
        document.querySelector('[data-ta="FullRTa-abstract"]'),
    ].filter(Boolean);

    for (const container of abstractContainers) {
        const text = container.textContent.trim();
        if (text) return text;
    }

    return '';
}

// ── Extract keywords ──────────────────────────────────────────────────────────
function extractKeywords() {
    const keywords = [];

    // Author keywords - GÜNCEL SELECTOR'LAR (WoS 2024/2025)
    const authorKwSelectors = [
        // Yeni WoS selector pattern (gönderilen HTML'den)
        '[id^="FRkeywordsTa-authorKeywordLink"]',
        'a[id^="FRkeywordsTa-authorKeywordLink"]',
        // Eski selector'lar (fallback)
        '[data-ta^="KeywordsTa-keyword-"]',
        '[id^="KeywordsTa-keyword-"]',
        '.keywords-section .value',
        '[data-ta="FullRTa-keywords"] span.value',
        '[id*="authorKeyword"]',
        'app-full-record-keywords .value',
        // Ek fallback'ler
        '[data-ta^="FRkeywordsTa-authorKeyword"]',
        'span[id^="FRkeywordsTa-authorKeyword"]',
    ];

    for (const sel of authorKwSelectors) {
        document.querySelectorAll(sel).forEach(el => {
            const txt = el.textContent.trim().replace(/[;,]$/, '');
            if (txt && !keywords.includes(txt)) keywords.push(txt);
        });
        if (keywords.length > 0) break;
    }

    // KeyWords Plus (WoS generated) - GÜNCEL SELECTOR'LAR
    const kwPlusSelectors = [
        // Yeni WoS selector pattern (gönderilen HTML'den)
        '[id^="FRkeywordsTa-keyWordsPlusLink"]',
        'a[id^="FRkeywordsTa-keyWordsPlusLink"]',
        // Eski selector'lar (fallback)
        '[data-ta^="KeywordsPlusTa-keyword-"]',
        '[id^="KeywordsPlusTa-keyword-"]',
        // Ek fallback'ler
        '[data-ta^="FRkeywordsTa-keyWordsPlus"]',
        'span[id^="FRkeywordsTa-keyWordsPlus"]',
    ];
    const kwPlus = [];
    for (const sel of kwPlusSelectors) {
        document.querySelectorAll(sel).forEach(el => {
            const txt = el.textContent.trim().replace(/[;,]$/, '');
            if (txt && !kwPlus.includes(txt)) kwPlus.push(txt);
        });
        if (kwPlus.length > 0) break;
    }

    return { authorKeywords: keywords, keywordsPlus: kwPlus };
}

// ── Derive indexType (Q value) from JCR data ──────────────────────────────────
function deriveIndexType(jcrCategories) {
    if (!jcrCategories || jcrCategories.length === 0) return null;

    // Prefer the first quartile found (e.g., "Q1", "Q2")
    for (const cat of jcrCategories) {
        const q = (cat.quartile || '').trim();
        if (q.match(/^Q[1-4]$/i)) return q.toUpperCase();
    }
    return null;
}

// ── Extract Author Identifiers (ORCID, ResearcherID) ──────────────────────────
function extractAuthorIdentifiers() {
    const orcidList = [];
    const researcherIdList = [];

    // ORCID selectors (gönderilen HTML'den)
    const orcidSelectors = [
        '[data-ta^="AidTa-ContribNameOrcId"]',
        'a[data-ta^="AidTa-ContribNameOrcId"]',
        '[id^="AidTa-ContribNameOrcId"]',
        'a[href*="orcid.org"]',
        '.orcid-id a',
        '[class*="orcid"] a',
    ];

    for (const sel of orcidSelectors) {
        document.querySelectorAll(sel).forEach(el => {
            // href'ten ORCID çıkar
            const href = el.getAttribute('href') || '';
            const orcidMatch = href.match(/orcid\.org\/(\d{4}-\d{4}-\d{4}-\d{4})/);
            if (orcidMatch) {
                const orcid = orcidMatch[1];
                if (!orcidList.includes(orcid)) orcidList.push(orcid);
            }
            // Text olarak da kontrol et
            const txt = el.textContent.trim();
            const textMatch = txt.match(/(\d{4}-\d{4}-\d{4}-\d{4})/);
            if (textMatch && !orcidList.includes(textMatch[1])) {
                orcidList.push(textMatch[1]);
            }
        });
        if (orcidList.length > 0) break;
    }

    // ResearcherID selectors (gönderilen HTML'den)
    const ridSelectors = [
        '[data-ta^="AidTa-ContribNameRid"]',
        'a[data-ta^="AidTa-ContribNameRid"]',
        '[id^="AidTa-ContribNameRid"]',
        'a[href*="researcherid.com"]',
        '.researcher-id a',
    ];

    for (const sel of ridSelectors) {
        document.querySelectorAll(sel).forEach(el => {
            const href = el.getAttribute('href') || '';
            const ridMatch = href.match(/researcherid\.com\/rid\/([A-Z0-9-]+)/i);
            if (ridMatch) {
                const rid = ridMatch[1];
                if (!researcherIdList.includes(rid)) researcherIdList.push(rid);
            }
            const txt = el.textContent.trim();
            if (txt && txt.length > 0 && !researcherIdList.includes(txt)) {
                researcherIdList.push(txt);
            }
        });
        if (researcherIdList.length > 0) break;
    }

    return { orcidList, researcherIdList };
}

// ── Extract WoS ID (UT Code) ──────────────────────────────────────────────────
function extractWoSId() {
    // WoS ID / UT Code selectors
    const wosIdSelectors = [
        '[data-ta="HiddenSecTa-accessionNo"]',
        '#HiddenSecTa-accessionNo',
        '[id*="accessionNo"]',
        '.accession-number',
    ];

    for (const sel of wosIdSelectors) {
        const el = document.querySelector(sel);
        if (el) {
            const txt = el.textContent.trim();
            // WoS ID format: WOS:000123456789 veya UT:WOS:000123456789
            const match = txt.match(/(WOS:\d+|UT:\w+:\d+)/i);
            if (match) return match[1];
            if (txt && txt.length > 5) return txt;
        }
    }
    return null;
}

// ── Extract Times Cited (GÜNCEL) ──────────────────────────────────────────────
function extractTimesCited() {
    // Güncel WoS Times Cited selector (gönderilen HTML'den)
    const timesCitedSelectors = [
        '#FullRRPTa-wos-citation-network-times-cited-count-link-1',
        '[id^="FullRRPTa-wos-citation-network-times-cited-count-link"]',
        '[data-ta^="FullRRPTa-wos-citation-network-times-cited"]',
        '[data-ta="FullRRPTa-citationsLabelPluralNoLink-0"]',
        '[data-ta="FullRRPTa-citationCountLinkValue"]',
        '.times-cited-count',
        '.citation-count-number',
    ];

    for (const sel of timesCitedSelectors) {
        const el = document.querySelector(sel);
        if (el) {
            const txt = el.textContent.trim().replace(/,/g, '');
            const count = parseInt(txt, 10);
            if (!isNaN(count) && count >= 0) return count;
        }
    }

    // Fallback: metin içinden ara
    const bodyText = document.body.innerText || '';
    const m = bodyText.match(/times?\s*cited[^:\d]*:?\s*([\d,]+)/i);
    return m ? parseInt(m[1].replace(/,/g, ''), 10) : 0;
}

// ── Extract JCR Values from Sidenav (GÜNCEL) ───────────────────────────────────
function extractJcrValues() {
    const result = {
        quartile: null,
        impactFactor: null,
        jciValue: null,
        jcrYear: null,
    };

    // Quartile - güncel selector
    const quartileSelectors = [
        '[data-ta^="Sidenav-0-JCR-quartile"]',
        '[id^="Sidenav-0-JCR-quartile"]',
        '#Sidenav-0-JCR-quartile_0',
        '.jcr-quartile',
        '[class*="quartile-badge"]',
    ];

    for (const sel of quartileSelectors) {
        const el = document.querySelector(sel);
        if (el) {
            const txt = el.textContent.trim().toUpperCase();
            if (txt.match(/^Q[1-4]$/)) {
                result.quartile = txt;
                break;
            }
        }
    }

    // Journal Impact Factor (JIF) - güncel selector
    const jifSelectors = [
        '#Sidenav-0-JCR-value',
        '[id^="Sidenav-0-JCR-value"]',
        '[data-ta^="Sidenav-0-JCR-value"]',
        '.jif-value',
        '.impact-factor-value',
        '[data-ta*="JIF-value"]',
    ];

    for (const sel of jifSelectors) {
        const el = document.querySelector(sel);
        if (el) {
            const txt = el.textContent.trim();
            const val = parseFloat(txt);
            if (!isNaN(val) && val > 0) {
                result.impactFactor = val;
                break;
            }
        }
    }

    // Journal Citation Indicator (JCI) - güncel selector
    const jciSelectors = [
        '#Sidenav-0-JCI-value',
        '[id^="Sidenav-0-JCI-value"]',
        '[data-ta^="Sidenav-0-JCI-value"]',
        '.jci-value',
        '[data-ta*="JCI-value"]',
    ];

    for (const sel of jciSelectors) {
        const el = document.querySelector(sel);
        if (el) {
            const txt = el.textContent.trim();
            const val = parseFloat(txt);
            if (!isNaN(val) && val > 0) {
                result.jciValue = val;
                break;
            }
        }
    }

    // JCR Year
    const yearSelectors = [
        '#Sidenav-0-JCR-year',
        '[data-ta^="Sidenav-0-JCR-year"]',
        '.jcr-year',
    ];

    for (const sel of yearSelectors) {
        const el = document.querySelector(sel);
        if (el) {
            const txt = el.textContent.trim();
            const year = parseInt(txt, 10);
            if (year > 2000 && year <= new Date().getFullYear()) {
                result.jcrYear = year;
                break;
            }
        }
    }

    return result;
}

// ── Main scrape function ──────────────────────────────────────────────────────
function scrapeArticleDetail() {
    // Index types (edition/database info)
    const indexTypes = [];
    document.querySelectorAll('[id^="FullRRPTa-edition"]').forEach(el => {
        const txt = el.textContent.trim();
        if (txt) indexTypes.push(txt);
    });
    if (indexTypes.length === 0) {
        document.querySelectorAll('.single-division-alignments li .section-label-data').forEach(el => {
            const txt = el.textContent.trim();
            if (txt) indexTypes.push(txt);
        });
    }

    const abstract = extractAbstract();
    const { authorKeywords, keywordsPlus } = extractKeywords();
    const { orcidList, researcherIdList } = extractAuthorIdentifiers();
    const wosId = extractWoSId();
    const timesCited = extractTimesCited();
    const jcrValues = extractJcrValues();

    // Authors extraction
    const authorsList = [];
    document.querySelectorAll('[id^="SumAuthTa-DisplayName-author-en-"], [data-ta^="author-name-"]').forEach(el => {
        let name = el.textContent.trim().replace(/;$/, '');

        // Try to find full name in parentheses (e.g., Ozturk, AB (Ozturk, Akif Berke))
        // The display name el usually doesn't contain the full name span, but its parent or sibling might.
        // Based on the provided HTML, 'SumAuthTa-FrAuthStandard-author-en-X' span inside a span sibling of the link contains it.
        const parentSpan = el.parentElement;
        if (parentSpan) {
            const fullNameSpan = parentSpan.querySelector('[id^="SumAuthTa-FrAuthStandard-author-en-"] .section-label-data');
            if (fullNameSpan && fullNameSpan.textContent.trim()) {
                name = fullNameSpan.textContent.trim();
            }
        }

        if (name && !authorsList.includes(name)) authorsList.push(name);
    });
    const authors = authorsList.join('; ');

    let doi = getText('[data-ta="FullRTa-DOI"], [data-ta="doi-value"]');
    let volume = getText('[data-ta="FullRTa-volume"]');
    let issue = getText('[data-ta="FullRTa-issue"]');
    let pages = getText('[data-ta="FullRTa-pages"]');
    let pubDate = getText('[data-ta="FullRTa-pubdate"]');
    let articleNo = getText('[data-ta="FullRTa-articleNumberValue"]');
    let journal = getText('.source-title-display a, [data-ta="FullRTa-source"] a, .journal-title a');
    let indexed = getText('[data-ta="FullRTa-indexedDate"]');
    let accession = getText('[data-ta="HiddenSecTa-accessionNo"]');
    let issn = getText('[data-ta="HiddenSecTa-ISSN"]');
    let eissn = getText('[data-ta="HiddenSecTa-EISSN"]');
    let language = getText('[data-ta="HiddenSecTa-language-0"]');
    let idsNumber = getText('[data-ta="HiddenSecTa-recordIds"]');
    let earlyAccess = getText('[data-ta="FullRTa-earlyAccess"]');

    // ── FALLBACK TEX-BASED EXTRACTION ──
    const bodyText = document.body.innerText || '';
    if (!doi) {
        const m = bodyText.match(/DOI:?\s*(10\.\d{4,9}\/[-._;()/:A-Za-z0-9]+)/i);
        if (m) doi = m[1].trim();
    }
    if (!journal) {
        // Look for the uppercase journal name immediately followed by Volume or similar
        const m = bodyText.match(/^([A-Z\s&-]+)\s*\nVolume[:\s]/im);
        if (m) journal = m[1].trim();
    }
    if (!volume) {
        const m = bodyText.match(/Volume[:\s]*(\d+)/i);
        if (m) volume = m[1].trim();
    }
    if (!issue) {
        const m = bodyText.match(/Issue[:\s]*([\w\d]+)/i);
        if (m) issue = m[1].trim();
    }
    if (!pages) {
        const m = bodyText.match(/(?:Pages|Page)[:\s]*([\w\d-]+)/i);
        if (m) pages = m[1].trim();
    }
    if (!pubDate) {
        const m = bodyText.match(/Published[:\s]*([A-Za-z0-9\s-]+(?:\d{4}))/i);
        if (m) pubDate = m[1].trim();
    }
    if (!issn) {
        const m = bodyText.match(/ISSN[:\s]*(\d{4}-\d{3}[\dX])/i);
        if (m) issn = m[1].trim();
    }
    if (!eissn) {
        const m = bodyText.match(/eISSN[:\s]*(\d{4}-\d{3}[\dX])/i);
        if (m) eissn = m[1].trim();
    }

    // Funding & Addresses
    const fundingTexts = [];
    document.querySelectorAll('[data-ta="FullRTa-funding-basic"] p, .funding-text').forEach(el => {
        const t = el.textContent.trim();
        if (t) fundingTexts.push(t);
    });
    const funding = fundingTexts.join('\n');

    const addressTexts = [];
    document.querySelectorAll('[data-ta="FullRTa-addresses"] .address-row, .address-text').forEach(el => {
        const t = el.textContent.trim();
        if (t) addressTexts.push(t);
    });
    const addresses = addressTexts.join(' | ');

    // Document types
    const documentTypes = [];
    document.querySelectorAll('[data-ta^="FullRTa-doctype"]').forEach(el => {
        const t = el.textContent.trim();
        if (t) documentTypes.push(t);
    });

    // Mapped publication type (system category)
    const mappedPublicationType = documentTypes.length > 0 ? mapWosDocType(documentTypes[0]) : null;

    const wosCategories = [];
    document.querySelectorAll('[data-ta^="CategoriesTa-WOSCategory"]').forEach(el => {
        const t = el.textContent.trim();
        if (t) wosCategories.push(t);
    });

    const researchAreas = [];
    document.querySelectorAll('[data-ta^="CategoriesTa-subject"]').forEach(el => {
        const t = el.textContent.trim();
        if (t) researchAreas.push(t);
    });

    // JCR Categories (from sidenav Sidenav-0-*)
    const jcrCategories = [];
    let i = 0;
    while (true) {
        const nameEl = document.querySelector(`[data-ta="Sidenav-0-JCR-category-name_${i}"]`);
        if (!nameEl) break;
        const name = nameEl.textContent.trim();
        const quartile = getText(`[data-ta="Sidenav-0-JCR-quartile_${i}"]`);
        const edition = getText(`[data-ta="Sidenav-0-JCR-edition_${i}"]`)
            .replace(/^in\s+/i, '').trim();
        if (name) jcrCategories.push({ name, quartile, edition });
        i++;
    }

    // JCI Categories
    const jciCategories = [];
    let j = 0;
    while (true) {
        const nameEl = document.querySelector(`[data-ta="Sidenav-0-JCI-category-name_${j}"]`);
        if (!nameEl) break;
        const name = nameEl.textContent.trim();
        const quartile = getText(`[data-ta="Sidenav-0-JCI-quartile_${j}"]`);
        const rank = getText(`[data-ta="Sidenav-0-JCI-rank_${j}"]`);
        if (name) jciCategories.push({ name, quartile, rank });
        j++;
    }

    // JIF/JCI values
    const jifValues = [];
    document.querySelectorAll('.jif-div').forEach(div => {
        const year = div.querySelector('[data-ta*="JCI-year"], [data-ta*="JCI-journal-year"]')?.textContent?.trim() || '';
        const value = div.querySelector('[data-ta*="JCI-value"], .jif-label-value')?.textContent?.trim() || '';
        if (year && value) jifValues.push({ year, value });
    });

    // Derive Q value (indexType) from JCR data
    const indexType = deriveIndexType(jcrCategories);

    // Citation counts
    const citationsEl = document.querySelector('[data-ta="FullRRPTa-citationsLabelPluralNoLink-0"], [data-ta="FullRRPTa-citationCountLinkValue"]');
    const wosCitations = citationsEl ? parseInt(citationsEl.textContent.trim(), 10) || 0 : 0;

    // Quartile öncelik sırası: jcrValues > jcrCategories > deriveIndexType
    const finalQuartile = jcrValues.quartile || indexType || deriveIndexType(jcrCategories);

    return {
        abstract,
        authorKeywords,
        keywordsPlus,
        authors,
        funding,
        addresses,
        indexTypes,
        indexType: finalQuartile,  // Q value (Q1-Q4)
        doi,
        volume,
        issue,
        pages,
        pubDate,
        earlyAccess,
        articleNo,
        journal,
        indexed,
        accession,
        issn,
        eissn,
        language,
        idsNumber,
        documentTypes,
        mappedPublicationType, // Mapped to system's publication type ID
        wosCategories,
        researchAreas,
        jcrCategories,
        jciCategories,
        jifValues,
        wosCitations: timesCited,  // Güncel times cited
        // YENİ ALANLAR - Eksik veriler için eklendi
        wosId,                     // WoS UT Code
        orcidList,                 // Yazar ORCID'leri
        researcherIdList,          // ResearcherID'ler
        quartile: finalQuartile,   // Q değeri (alias)
        impactFactor: jcrValues.impactFactor,  // JIF değeri
        jciValue: jcrValues.jciValue,          // JCI değeri
        jcrYear: jcrValues.jcrYear,            // JCR yılı
        pageUrl: window.location.href,
    };
}

(async () => {
    try {
        await waitForDetailLoad();

        // 1. Try to open hidden section ("See more data fields")
        await _humanDelay(200, 500);
        await openHiddenSection();

        // 2. Expand abstract if collapsed
        await _humanDelay(200, 500);
        await expandAbstract();

        // 3. Open JCR sidenav to get Q value and JCI data
        await _humanDelay(200, 600);
        await openJcrSidenav();

        // 4. Wait for all data to render
        await _humanDelay(400, 900);

        const detail = scrapeArticleDetail();
        console.log('[WoS Detail] Scrape tamamlandı:', detail.doi || detail.pageUrl,
            '| JCR:', detail.jcrCategories.length, 'kategori',
            '| Q:', detail.indexType || 'N/A',
            '| Abstract:', detail.abstract ? detail.abstract.length + ' chars' : 'BOŞTU',
            '| Keywords:', (detail.authorKeywords || []).length,
            '| MappedType:', detail.mappedPublicationType || 'N/A');
        chrome.runtime.sendMessage({ type: 'ARTICLE_DETAIL_COMPLETE', detail });
    } catch (e) {
        console.error('[WoS Detail] Hata:', e);
        chrome.runtime.sendMessage({ type: 'ARTICLE_DETAIL_COMPLETE', detail: null, error: e.message });
    }
})();

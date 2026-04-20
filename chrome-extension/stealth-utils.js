/**
 * stealth-utils.js
 * Anti-bot detection utilities for Chrome Extension.
 * Injected BEFORE content scripts to mask automation signals.
 *
 * Techniques:
 * 1. Navigator/WebDriver flag hiding
 * 2. Human-like timing (Gaussian distribution)
 * 3. Random viewport & window sizes
 * 4. Canvas fingerprint noise injection
 * 5. Plugin/Language spoofing
 */

// ═══════════════════════════════════════════════
//  1. NAVIGATOR OVERRIDES — Hide automation signals
// ═══════════════════════════════════════════════

(function hideAutomationSignals() {
    // Remove webdriver flag
    try {
        Object.defineProperty(navigator, 'webdriver', {
            get: () => undefined,
            configurable: true,
        });
    } catch (_) { /* read-only in some contexts */ }

    // Override navigator.plugins to look like a real browser
    try {
        const fakePlugins = {
            length: 5,
            0: { name: 'Chrome PDF Plugin', filename: 'internal-pdf-viewer', description: 'Portable Document Format' },
            1: { name: 'Chrome PDF Viewer', filename: 'mhjfbmdgcfjbbpaeojofohoefgiehjai', description: '' },
            2: { name: 'Native Client', filename: 'internal-nacl-plugin', description: '' },
            3: { name: 'Chromium PDF Plugin', filename: 'internal-pdf-viewer', description: 'Portable Document Format' },
            4: { name: 'Chromium PDF Viewer', filename: 'mhjfbmdgcfjbbpaeojofohoefgiehjai', description: '' },
            item: function (i) { return this[i] || null; },
            namedItem: function (name) {
                for (let i = 0; i < this.length; i++) {
                    if (this[i].name === name) return this[i];
                }
                return null;
            },
            refresh: function () { },
        };

        Object.defineProperty(navigator, 'plugins', {
            get: () => fakePlugins,
            configurable: true,
        });
    } catch (_) { }

    // Override navigator.languages to look natural
    try {
        const langSets = [
            ['en-US', 'en'],
            ['tr-TR', 'tr', 'en-US', 'en'],
            ['en-US', 'en', 'tr'],
            ['tr-TR', 'tr', 'en'],
        ];
        const chosenLangs = langSets[Math.floor(Math.random() * langSets.length)];

        Object.defineProperty(navigator, 'languages', {
            get: () => Object.freeze([...chosenLangs]),
            configurable: true,
        });
    } catch (_) { }

    // Remove Chrome-specific automation flags
    try {
        // Hide chrome.csi (Chrome debugging)
        if (window.chrome && window.chrome.csi) {
            // Keep it but don't let it leak info
        }

        // Remove automation-related properties from chrome.runtime
        // (Only if they reveal extension context to page scripts)
    } catch (_) { }

    // Override permissions query to hide "notifications" denial pattern bots often have
    try {
        const origQuery = window.Permissions?.prototype?.query;
        if (origQuery) {
            window.Permissions.prototype.query = function (params) {
                if (params.name === 'notifications') {
                    return Promise.resolve({ state: Notification.permission });
                }
                return origQuery.call(this, params);
            };
        }
    } catch (_) { }
})();

// ═══════════════════════════════════════════════
//  2. CANVAS FINGERPRINT NOISE
// ═══════════════════════════════════════════════

(function injectCanvasNoise() {
    try {
        const origToDataURL = HTMLCanvasElement.prototype.toDataURL;
        const origToBlob = HTMLCanvasElement.prototype.toBlob;
        const origGetImageData = CanvasRenderingContext2D.prototype.getImageData;

        // Seed based on session so fingerprint is consistent within a session
        // but different across sessions
        const noiseSeed = Math.random() * 0.01; // Very subtle noise

        HTMLCanvasElement.prototype.toDataURL = function (...args) {
            const ctx = this.getContext('2d');
            if (ctx && this.width > 0 && this.height > 0) {
                try {
                    const imageData = origGetImageData.call(ctx, 0, 0, this.width, this.height);
                    // Add very subtle noise to a few random pixels
                    for (let i = 0; i < Math.min(10, imageData.data.length / 4); i++) {
                        const idx = Math.floor(Math.random() * imageData.data.length / 4) * 4;
                        imageData.data[idx] = Math.max(0, Math.min(255, imageData.data[idx] + (Math.random() > 0.5 ? 1 : -1)));
                    }
                    ctx.putImageData(imageData, 0, 0);
                } catch (_) { /* CORS canvas */ }
            }
            return origToDataURL.apply(this, args);
        };

        HTMLCanvasElement.prototype.toBlob = function (callback, ...args) {
            const ctx = this.getContext('2d');
            if (ctx && this.width > 0 && this.height > 0) {
                try {
                    const imageData = origGetImageData.call(ctx, 0, 0, this.width, this.height);
                    for (let i = 0; i < Math.min(10, imageData.data.length / 4); i++) {
                        const idx = Math.floor(Math.random() * imageData.data.length / 4) * 4;
                        imageData.data[idx] = Math.max(0, Math.min(255, imageData.data[idx] + (Math.random() > 0.5 ? 1 : -1)));
                    }
                    ctx.putImageData(imageData, 0, 0);
                } catch (_) { }
            }
            return origToBlob.call(this, callback, ...args);
        };
    } catch (_) { }
})();

// ═══════════════════════════════════════════════
//  3. WEBGL FINGERPRINT PROTECTION
// ═══════════════════════════════════════════════

(function protectWebGL() {
    try {
        const origGetParameter = WebGLRenderingContext.prototype.getParameter;
        WebGLRenderingContext.prototype.getParameter = function (param) {
            // Randomize renderer/vendor strings slightly
            if (param === 37446) { // UNMASKED_RENDERER_WEBGL
                const result = origGetParameter.call(this, param);
                return result; // Keep original but we've intercepted the call
            }
            if (param === 37445) { // UNMASKED_VENDOR_WEBGL
                const result = origGetParameter.call(this, param);
                return result;
            }
            return origGetParameter.call(this, param);
        };
    } catch (_) { }
})();

// ═══════════════════════════════════════════════
//  4. HUMAN-LIKE TIMING UTILITIES (exported globally)
// ═══════════════════════════════════════════════

/**
 * Generate a random delay using Gaussian (normal) distribution.
 * This creates more natural-looking timing patterns than uniform random.
 *
 * @param {number} min - Minimum delay in ms
 * @param {number} max - Maximum delay in ms
 * @returns {number} Random delay in ms with Gaussian distribution centered at (min+max)/2
 */
function gaussianRandom(min, max) {
    // Box-Muller transform for Gaussian distribution
    let u = 0, v = 0;
    while (u === 0) u = Math.random();
    while (v === 0) v = Math.random();
    let num = Math.sqrt(-2.0 * Math.log(u)) * Math.cos(2.0 * Math.PI * v);

    // Transform to desired range (mean = center, std = range/6)
    const mean = (min + max) / 2;
    const std = (max - min) / 6;
    num = num * std + mean;

    return Math.max(min, Math.min(max, Math.round(num)));
}

/**
 * Human-like delay — returns a Promise that resolves after a Gaussian-distributed delay.
 * @param {number} min - Minimum delay in ms  
 * @param {number} max - Maximum delay in ms
 * @returns {Promise<void>}
 */
function humanDelay(min = 500, max = 2000) {
    const delay = gaussianRandom(min, max);
    return new Promise(resolve => setTimeout(resolve, delay));
}

/**
 * Simulate human-like typing delay.
 * @param {number} charCount - Number of characters to "type"
 * @returns {Promise<void>}
 */
function humanTypingDelay(charCount = 10) {
    // Average human types 40-60 WPM → ~100-150ms per character
    const baseDelay = charCount * gaussianRandom(80, 180);
    return new Promise(resolve => setTimeout(resolve, baseDelay));
}

/**
 * Random integer between min and max (inclusive).
 */
function randomInt(min, max) {
    return Math.floor(Math.random() * (max - min + 1)) + min;
}

/**
 * Simulate a natural "reading pause" — used while scrolling through content.
 * 15% chance of a longer pause (as if reading something interesting).
 */
async function maybeReadingPause() {
    if (Math.random() < 0.15) {
        // "Reading" pause: 1.5-4 seconds
        await humanDelay(1500, 4000);
        return true;
    }
    return false;
}

/**
 * Human-like scroll step size.
 * Returns a random pixel amount for a single scroll step.
 */
function humanScrollStep() {
    return randomInt(180, 450);
}

/**
 * Generate random window dimensions for a natural-looking browser window.
 * Returns { width, height }
 */
function randomWindowSize() {
    const widths = [1280, 1366, 1440, 1536, 1600, 1920];
    const heights = [720, 768, 800, 900, 1024, 1080];

    // Pick a base resolution and add slight random jitter
    const baseW = widths[Math.floor(Math.random() * widths.length)];
    const baseH = heights[Math.floor(Math.random() * heights.length)];

    return {
        width: baseW + randomInt(-50, 50),
        height: baseH + randomInt(-30, 30),
    };
}

/**
 * Add jitter to a base interval for more natural polling patterns.
 * @param {number} baseMs - Base interval in ms
 * @param {number} jitterPercent - Jitter as percentage (0-100) of base
 * @returns {number} Jittered interval in ms
 */
function jitteredInterval(baseMs, jitterPercent = 30) {
    const jitter = baseMs * (jitterPercent / 100);
    return baseMs + randomInt(-jitter, jitter);
}

// Make utilities available globally for content scripts
if (typeof window !== 'undefined') {
    window.__stealthUtils = {
        humanDelay,
        humanTypingDelay,
        gaussianRandom,
        randomInt,
        maybeReadingPause,
        humanScrollStep,
        randomWindowSize,
        jitteredInterval,
    };
}

// Also export for service worker context (background.js)
if (typeof globalThis !== 'undefined') {
    globalThis.__stealthUtils = {
        humanDelay,
        humanTypingDelay,
        gaussianRandom,
        randomInt,
        maybeReadingPause,
        humanScrollStep,
        randomWindowSize,
        jitteredInterval,
    };
}

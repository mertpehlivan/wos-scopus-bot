/**
 * scopus_session_handler.js
 *
 * Detects Scopus / Elsevier OAuth login redirects that block author-metric
 * scraping. Unlike WoS, Scopus auto-login isn't reliably automatable (no
 * stable form selectors, frequent CAPTCHAs), so the recovery strategy is:
 *
 *   1. Detect we've landed on a login screen instead of the Scopus profile.
 *   2. Ask background.js to wipe cookies + local/session storage for
 *      *.scopus.com and *.elsevier.com.
 *   3. Reload the tab back to the original profile URL.
 *   4. If that doesn't help after MAX_RECOVERY_ATTEMPTS, surface
 *      LOGIN_FAILED so the orchestrator gives up cleanly.
 *
 * Runs on every Scopus and Elsevier auth-related page so we catch redirects
 * regardless of which step they happened on.
 */
(function () {
    if (window.__scopusSessionHandlerRunning) return;
    window.__scopusSessionHandlerRunning = true;

    const MAX_RECOVERY_ATTEMPTS = 2;
    const url = window.location.href;
    const host = window.location.host;

    function looksLikeLoginUrl() {
        // Definite redirect destinations. Use pathname so query-string params
        // like `?ref=signin` don't false-positive on legitimate Scopus pages.
        const path = window.location.pathname;
        if (host.includes('id.elsevier.com')) return true;
        if (path.includes('/authenticate/') || path.includes('/oauth/')) return true;
        if (path === '/signin' || path.startsWith('/signin/')) return true;
        if (path === '/login' || path.startsWith('/login/')) return true;
        return false;
    }

    function looksLikeLoginPage() {
        // Strict: visible AND focused login form fields on a Scopus page.
        // We require BOTH email + password inputs to avoid false-positives
        // from Scopus' inline sign-in widgets that ship on every page.
        // Body-text matching ("please sign in") was removed — Scopus footers
        // and tooltips contain those phrases on perfectly logged-in pages.
        const emailInput = document.querySelector(
            'input[type="email"]:not([disabled]), input#bdd-email:not([disabled])'
        );
        const passwordInput = document.querySelector('input[type="password"]:not([disabled])');
        if (!emailInput || !passwordInput) return false;
        // Both must actually be visible — checking offsetParent is enough
        // for inputs (they're never position:fixed inside login forms).
        return emailInput.offsetParent !== null && passwordInput.offsetParent !== null;
    }

    if (!looksLikeLoginUrl() && !looksLikeLoginPage()) {
        // Page looks fine — nothing to do.
        return;
    }

    console.log('[Scopus Session] Login redirect detected. host=' + host + ', path=' + window.location.pathname);

    // Ask background.js for the original task URL so we can return to it
    // after clearing storage.
    chrome.runtime.sendMessage({ type: 'GET_TASK_INFO' }, (tabInfo) => {
        const taskId = tabInfo?.taskId;
        const externalId = tabInfo?.externalId;
        const source = tabInfo?.source;

        // Tell backend: login required
        chrome.runtime.sendMessage({
            type: 'SESSION_EVENT',
            source: 'SCOPUS',
            event: 'LOGIN_DETECTED',
            detail: 'redirected to ' + host,
        });

        // Only perform recovery for active SCOPUS tasks. Random Scopus browsing
        // by the operator should not trigger storage wipes.
        if (!taskId || source !== 'SCOPUS' || !externalId) {
            console.log('[Scopus Session] No active SCOPUS task — skipping recovery');
            return;
        }

        chrome.runtime.sendMessage({
            type: 'RECOVER_SCOPUS_SESSION',
            taskId,
            externalId,
            currentUrl: url,
        });
    });
})();

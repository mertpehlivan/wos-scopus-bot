/**
 * wos_session_bridge.js — ISOLATED-world relay for wos_session_handler.js.
 *
 * Why this exists: wos_session_handler.js runs in the page's MAIN world
 * (it needs input.__ngContext__ to drive Angular's FormControl on the login
 * form, and page globals such as Pendo's buttonPrimary). In the MAIN world
 * `chrome.runtime.sendMessage` does not exist (no externally_connectable),
 * so every message the handler sent — return URL, login-pending sentinel,
 * post-login breadcrumb, probe OK, session events — was silently dropped.
 * Result: after an auto-login the tab stayed on the WoS search page and the
 * task hung until the 60-minute timeout.
 *
 * Protocol (same-window postMessage, request/response by id):
 *   MAIN → here:  { __wosBridge: 'req', id, msg }
 *   here → MAIN:  { __wosBridge: 'res', id, response }
 *
 * Only the handler's own message types are relayed; the page could post the
 * same shape, so background.js validates every payload (e.g. return URLs
 * must be WoS data pages).
 */
(function () {
    if (window.__wosSessionBridgeInstalled) return;
    window.__wosSessionBridgeInstalled = true;

    const ALLOWED_TYPES = new Set([
        'SESSION_EVENT',
        'WOS_SET_RETURN_URL',
        'WOS_SET_LOGIN_PENDING',
        'WOS_CHECK_POST_LOGIN',
        'WOS_SESSION_OK',
    ]);

    // ── WoS login credentials (R6) ──────────────────────────────────────
    // Kept in chrome.storage.local (entered in the popup), never in source.
    // Answered here, in the ISOLATED world, without a background round trip,
    // and only while the page actually shows a password field — so scripts
    // on ordinary WoS data pages can't fish them out through this relay.
    // The reply is visible to the page, but so is a filled login form.
    const CREDENTIALS_KEY = 'wosCredentials';
    const MAX_CREDENTIAL_REPLIES = 5;
    let credentialReplies = 0;

    function hasPasswordField() {
        return !!document.querySelector('input[type="password"], input[name="password"], input[formcontrolname="password"]');
    }

    async function answerCredentials(id) {
        if (!hasPasswordField() || credentialReplies >= MAX_CREDENTIAL_REPLIES) {
            reply(id, { ok: false, error: 'not a login page' });
            return;
        }
        credentialReplies++;
        let creds = null;
        try {
            creds = (await chrome.storage.local.get(CREDENTIALS_KEY))[CREDENTIALS_KEY] || null;
        } catch (err) {
            console.warn('[WoS Bridge] credential read failed:', err?.message || err);
        }
        if (creds && creds.email && creds.password) {
            reply(id, { ok: true, email: creds.email, password: creds.password });
            return;
        }
        try { chrome.runtime.sendMessage({ type: 'WOS_CREDENTIALS_MISSING' }).catch(() => { }); } catch (_) { }
        reply(id, { ok: false, missing: true });
    }

    function reply(id, response) {
        try {
            window.postMessage({ __wosBridge: 'res', id, response }, window.location.origin);
        } catch (_) { /* page navigating away */ }
    }

    window.addEventListener('message', (event) => {
        if (event.source !== window) return;
        const data = event.data;
        if (!data || data.__wosBridge !== 'req' || typeof data.id !== 'string') return;
        const msg = data.msg;
        if (msg && msg.type === 'WOS_GET_CREDENTIALS') { answerCredentials(data.id); return; }
        if (!msg || typeof msg.type !== 'string' || !ALLOWED_TYPES.has(msg.type)) return;

        try {
            chrome.runtime.sendMessage(msg).then(
                (response) => reply(data.id, response),
                (err) => {
                    console.warn('[WoS Bridge] sendMessage failed for', msg.type, err?.message || err);
                    reply(data.id, { ok: false, error: String(err?.message || err) });
                });
        } catch (err) {
            // Extension reloaded under the page → context invalidated.
            console.warn('[WoS Bridge] extension context unavailable for', msg.type, err?.message || err);
            reply(data.id, { ok: false, error: 'extension context unavailable' });
        }
    });
})();

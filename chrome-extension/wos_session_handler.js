/**
 * wos_session_handler.js
 * Handles WoS session expiry by auto-dismissing the Pendo "free view" popup,
 * clicking "Sign In", filling credentials via Angular FormControl API, and submitting.
 *
 * Runs on all *.webofscience.com pages.
 */
(function () {
    if (window.__wosSessionHandlerRunning) return;
    window.__wosSessionHandlerRunning = true;

    console.log('[WoS Session] Handler initialized on URL:', window.location.href);

    // Capture pre-flight probe mode at script load — the WoS Angular SPA
    // strips URL fragments aggressively during its initial bootstrap, so
    // by the time our 1.5s setup timer fires the #wos-session-probe=1
    // marker is gone and the handler can't tell it's running on the
    // hidden probe tab. Memoizing at module-init means subsequent reads
    // (in attemptRecovery) see the original value regardless of what
    // Angular did to the URL. Also accept the flag from sessionStorage
    // — background sets it as a belt-and-suspenders for the case where
    // even the initial document.location.hash has already been
    // rewritten (rare but observed during forced reloads).
    const __PROBE_MODE = (() => {
        try {
            const hash = window.location.hash || '';
            if (hash.includes('wos-session-probe=1')) return true;
            if (sessionStorage.getItem('__wos_probe_mode__') === '1') return true;
        } catch (_) { /* sessionStorage may be blocked */ }
        return false;
    })();
    if (__PROBE_MODE) {
        try { sessionStorage.setItem('__wos_probe_mode__', '1'); } catch (_) {}
        console.log('[WoS Session] Probe mode active for this tab');
    }

    const CONFIG = {
        email: 'info@rawdatalibrary.net',
        password: 'sakarya54qA*',
        checkIntervalMs: 2000,
        maxCheckAttempts: 90, // ~3 minutes of polling
    };

    let checkAttempts = 0;
    let loginDetectedReported = false;
    let loginInProgressReported = false;
    let forceNavigatedToLogin = false;
    /** Number of times we've tried clicking the in-page Sign In control. */
    let signInClickAttempts = 0;
    /** Max click retries before we give up on the dropdown and jump straight
     *  to the canonical login URL. WoS's new Angular layout sometimes opens
     *  the sign-in dropdown but closes it again before we can click the menu
     *  item — looping forever doesn't help. After this many tries we
     *  navigate to access.clarivate.com/login directly. */
    const MAX_SIGN_IN_CLICK_ATTEMPTS = 2;

    /** Best-effort report to background → broker → backend. */
    function reportSession(event, detail) {
        try {
            chrome.runtime.sendMessage({ type: 'SESSION_EVENT', source: 'WOS', event, detail });
        } catch (e) {
            // Ignore — extension context may be closed
        }
    }

    /**
     * Detail / citation-report / search pages may show a session-expired state
     * without a visible "Sign In" button (just a partial preview or a paywall).
     * In that case the handler can sit forever waiting for an element that
     * never appears. After a few unsuccessful checks we save the current URL
     * and force-navigate to the auth URL — the login form there is auto-filled
     * by this same script's existing form-handling code.
     */
    function isDataPage() {
        const path = window.location.pathname;
        return path.includes('/full-record/')
            || path.includes('/citation-report')
            || path.includes('/summary')
            || path.includes('/wos/author/record/');
    }

    function hasArticleContent() {
        // Heuristic: if any of these are present, the page is rendering real
        // content and we shouldn't intervene.
        return !!(
            document.querySelector('[data-ta="record-summary"]')
            || document.querySelector('app-record-content')
            || document.querySelector('app-author-name-link')
            || document.querySelector('app-records-list')
            || document.querySelector('[data-author-metrics-h-index]')
        );
    }

    /**
     * Detects WoS's anonymous "free view" mode. The banner reads
     * "You are accessing a free view of the Web of Science" and is shown
     * above the page content when the user isn't authenticated. Page
     * still renders some metrics + author name, so {@link hasArticleContent}
     * returns true — but the data is incomplete and the operator panel
     * needs us to log in before we trust the scrape.
     *
     * <p>If this banner is visible, we MUST recover (find Sign In or
     * force-navigate) regardless of the article-content heuristic.
     */
    function hasFreeViewBanner() {
        const text = (document.body && document.body.innerText) || '';
        if (!text) return false;
        // Match either the English banner or the Turkish translation.
        return /you are accessing a free view of the web of science/i.test(text)
            || /web of science.{0,40}\bfree view\b/i.test(text);
    }

    /**
     * Detects the "Welcome, <name>! As a new user, please follow the
     * steps to build your profile." onboarding screen WoS shows for
     * accounts that haven't created a researcher profile yet. Trying
     * to load /wos/woscc/citation-report on such an account silently
     * redirects to the Smart Search home with this banner — the
     * scrape can't recover and an operator sitting there with a
     * stuck task never finds out why.
     *
     * <p>Returns true if the page is showing this onboarding state.
     * Caller should stop polling and report ONBOARDING_REQUIRED so
     * the operator panel can surface a clear "WoS account needs
     * profile setup" error.
     */
    function hasOnboardingProfileRequired() {
        const text = (document.body && document.body.innerText) || '';
        if (!text) return false;
        // Match the English screen the user sees; cover Turkish wording too
        // in case Clarivate localizes the onboarding banner.
        const en = /create your researcher profile/i.test(text)
            && /follow the steps to build your profile/i.test(text);
        const tr = /araştırmacı profilinizi oluşturun/i.test(text)
            && /profilinizi oluşturmak için adımları takip edin/i.test(text);
        return en || tr;
    }

    /**
     * Saves the current page URL as the post-login return target — but
     * only if the URL is a data page worth coming back to. Saving an
     * already-on-login-page URL would create a redirect loop after
     * successful auth.
     *
     * <p>Awaitable: sends WOS_SET_RETURN_URL via chrome.runtime.sendMessage
     * and resolves only after the background's storage write returns.
     * Critical because the caller (forceNavigateToLogin) follows up with
     * window.location.href = ... that kills the JS context — without
     * awaiting, the storage write can lose the race against navigation.
     *
     * @returns {Promise<boolean>} true if the URL was eligible and stored
     */
    async function saveReturnUrlIfDataPage(reason) {
        const url = window.location.href;
        const host = window.location.host;
        // Don't save Clarivate / Sign-in pages — those aren't where we
        // wanted to be in the first place.
        if (host.includes('clarivate.com')) return false;
        if (host.includes('access.clarivate.com')) return false;
        const path = window.location.pathname;
        if (path.startsWith('/login') || path.startsWith('/signin')) return false;

        try {
            // Await delivery so the storage write completes before the
            // caller initiates navigation. chrome.runtime.sendMessage
            // returns a Promise in Manifest V3.
            await chrome.runtime.sendMessage({ type: 'WOS_SET_RETURN_URL', url });
            console.log('[WoS Session] Saved return URL (' + reason + '):', url);
            return true;
        } catch (e) {
            console.warn('[WoS Session] Could not save return URL:', e?.message || e);
            return false;
        }
    }

    async function forceNavigateToLogin() {
        if (forceNavigatedToLogin) return false;
        forceNavigatedToLogin = true;
        // AWAIT the return-URL save so it lands in storage before we
        // tear down this JS context with window.location.href below.
        // Without awaiting, the storage write was being dropped in
        // practice — background.js then had no return URL after
        // login, fell through to Priority 2/3 (rebuild from entry or
        // sender.tab.url, which was the post-login basic-search), and
        // tab stayed on the home page instead of going back to the
        // task URL.
        await saveReturnUrlIfDataPage('forceNavigate');
        if (!loginDetectedReported) {
            loginDetectedReported = true;
            reportSession('LOGIN_DETECTED', 'no Sign In control on data page — forcing login URL');
        }
        console.log('[WoS Session] Force-navigating to login URL, return =', window.location.href);
        // Clarivate's canonical login entry point — wos_session_handler will run
        // there too (manifest matches /clarivate.com/login*) and handle the form.
        window.location.href = 'https://access.clarivate.com/login?app=wos&alternative=true';
        return true;
    }

    function _humanDelay(min = 300, max = 800) {
        return new Promise(resolve => setTimeout(resolve, Math.floor(Math.random() * (max - min + 1)) + min));
    }

    function isVisible(el) {
        if (!el) return false;
        // offsetParent is null for `position: fixed` elements and elements
        // inside CSS containment, so check rect + computed style instead.
        const rect = el.getBoundingClientRect();
        if (rect.width === 0 && rect.height === 0) return false;
        const style = window.getComputedStyle(el);
        if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
        return true;
    }

    function getVisibleElement(selectors) {
        if (typeof selectors === 'string') selectors = [selectors];
        for (const sel of selectors) {
            const el = document.querySelector(sel);
            if (isVisible(el)) return el;
        }
        return null;
    }

    /**
     * Finds the visible "Sign In" control. WoS rebrands periodically and
     * wraps the label in nested Angular Material elements, so we cast a
     * wide net:
     *   1. Direct match on button/a/[role=button] with "sign in" text or
     *      aria/data attribute.
     *   2. Any visible element whose own text is exactly "sign in" → climb
     *      to the nearest clickable ancestor.
     *   3. Attribute-only fallback ([aria-label], cdxanalyticscategory).
     *
     * Returns the element to {@code .click()}, or null if nothing found.
     */
    function findSignInControl() {
        const matchesText = (s) => {
            if (!s) return false;
            const t = s.replace(/\s+/g, ' ').trim().toLowerCase();
            if (t.length === 0 || t.length > 40) return false;
            return t === 'sign in'
                || t === 'sign in »'
                || t.startsWith('sign in')
                || t.endsWith('sign in');
        };

        // Pass 1 — direct clickable elements
        const directs = Array.from(document.querySelectorAll(
            'button, a, [role="button"], mat-menu-item, [cdxanalyticscategory*="sign" i]'
        ));
        for (const el of directs) {
            if (!isVisible(el)) continue;
            const text = el.textContent || el.innerText || '';
            const aria = (el.getAttribute && el.getAttribute('aria-label')) || '';
            const cat = (el.getAttribute && el.getAttribute('cdxanalyticscategory')) || '';
            if (matchesText(text)) return el;
            if (matchesText(aria)) return el;
            const catLow = cat.toLowerCase();
            if (catLow.includes('sign_in') || catLow.includes('signin')) return el;
        }

        // Pass 2 — any visible element whose own immediate text is "sign in";
        // climb to nearest clickable ancestor.
        const candidates = document.querySelectorAll('span, div, p, label, mat-label');
        for (const el of candidates) {
            // Use only this node's own text, not descendants', so we don't
            // match the whole header that contains "Sign In" along with
            // other labels.
            const ownText = ownNodeText(el);
            if (!matchesText(ownText)) continue;
            if (!isVisible(el)) continue;
            const clickable = climbToClickable(el);
            if (clickable) return clickable;
        }

        return null;
    }

    /** Returns text from this element ignoring child elements' content. */
    function ownNodeText(el) {
        let s = '';
        for (const n of el.childNodes) {
            if (n.nodeType === 3) s += n.nodeValue || '';
        }
        return s;
    }

    /** Climbs up the DOM until it hits a clickable ancestor (or null). */
    function climbToClickable(el) {
        let cursor = el;
        while (cursor && cursor !== document.body) {
            const tag = cursor.tagName;
            if (tag === 'BUTTON' || tag === 'A' || cursor.getAttribute?.('role') === 'button'
                    || tag === 'MAT-MENU-ITEM') {
                if (isVisible(cursor)) return cursor;
            }
            cursor = cursor.parentElement;
        }
        return null;
    }

    // ── Angular FormControl API access ──
    function setAngularInputValue(input, value, fieldName) {
        if (!input) {
            console.log(`[WoS Session] ❌ ${fieldName} input not found`);
            return false;
        }

        console.log(`[WoS Session] 📝 Setting ${fieldName} via Angular FormControl...`);
        input.scrollIntoView({ block: 'center', behavior: 'instant' });

        // Try to access Angular's FormControl via __ngContext__
        let angularSucceeded = false;
        try {
            const ctx = input.__ngContext__;
            if (ctx && Array.isArray(ctx)) {
                for (let i = 0; i < ctx.length; i++) {
                    const item = ctx[i];
                    // Look for FormControl-like object with setValue method
                    if (item && typeof item === 'object' && item.control && typeof item.control.setValue === 'function') {
                        console.log(`[WoS Session] Found Angular FormControl at context[${i}]`);
                        item.control.setValue(value);
                        item.control.markAsDirty();
                        item.control.markAsTouched();
                        item.control.updateValueAndValidity();
                        console.log(`[WoS Session] ✓ Angular FormControl.setValue() succeeded for ${fieldName}`);
                        angularSucceeded = true;
                        break;
                    }
                }
            }
        } catch (e) {
            console.warn(`[WoS Session] Angular FormControl access failed: ${e.message}`);
        }

        // Fallback: native value setter
        if (!angularSucceeded) {
            console.log(`[WoS Session] Falling back to native value setter for ${fieldName}`);
            try {
                // Try property descriptor
                const descriptor = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value');
                if (descriptor && descriptor.set) {
                    descriptor.set.call(input, value);
                    console.log(`[WoS Session] ✓ Native descriptor.set() succeeded`);
                } else {
                    // Direct assignment fallback
                    input.value = value;
                    console.log(`[WoS Session] ✓ Direct value assignment succeeded`);
                }

                // Dispatch validation events
                input.dispatchEvent(new Event('input', { bubbles: true }));
                input.dispatchEvent(new Event('change', { bubbles: true }));
                input.dispatchEvent(new Event('blur', { bubbles: true }));
            } catch (e) {
                console.warn(`[WoS Session] Native setter also failed: ${e.message}`);
            }
        }

        console.log(`[WoS Session] ✓ ${fieldName} = "${input.value}"`);
        return input.value === value;
    }

    // ── Step 1: Dismiss Pendo popup ──
    async function dismissPendoPopup() {
        const pendoContainer = document.querySelector('[id^="pendo-g-"]');
        if (!pendoContainer) return false;

        console.log('[WoS Session] Pendo popup detected, attempting dismissal...');

        // Primary: "Got it" / dismissGuides button
        const dismissBtn = pendoContainer.querySelector('#dismissGuides, button.wos-primary-button');
        if (dismissBtn) {
            dismissBtn.scrollIntoView({ block: 'center', behavior: 'instant' });
            await _humanDelay(200, 400);
            dismissBtn.click();
            console.log('[WoS Session] Pendo popup dismissed (dismissGuides)');
            await _humanDelay(600, 1000);
            return true;
        }

        // Fallback: close button (if visible)
        const closeBtn = pendoContainer.querySelector('[id^="pendo-close-guide-"]');
        if (isVisible(closeBtn)) {
            closeBtn.click();
            console.log('[WoS Session] Pendo popup dismissed (close button)');
            await _humanDelay(600, 1000);
            return true;
        }

        // Last resort: try triggering the inline function if defined in global scope
        if (typeof window.buttonPrimary === 'function') {
            try {
                window.buttonPrimary();
                console.log('[WoS Session] Pendo popup dismissed (buttonPrimary)');
                return true;
            } catch (e) {
                // ignore
            }
        }

        return false;
    }

    // ── Step 2: Click header "Sign In" button (opens dropdown menu) ──
    async function clickHeaderSignIn() {
        const btn = findSignInControl();
        if (!btn) {
            console.log('[WoS Session] Header Sign In control not found via any selector');
            return false;
        }
        // Persist the URL so that whatever flow login triggers (modal,
        // Clarivate redirect, intermediate landing page), the post-success
        // navigation lands us back exactly where the worker was scraping.
        // Crucial for article-detail / citation-report tasks where a
        // `wos/author/record/<id>` reconstruction would be wrong.
        saveReturnUrlIfDataPage('beforeSignIn');

        const text = (btn.textContent || '').replace(/\s+/g, ' ').trim();
        console.log('[WoS Session] Clicking Sign In control: tag=' + btn.tagName +
                    ', text="' + text.slice(0, 40) + '"' +
                    ', aria="' + (btn.getAttribute('aria-label') || '') + '"');
        try {
            btn.scrollIntoView({ block: 'center', behavior: 'instant' });
        } catch (_) { /* scrollIntoView may throw inside iframes */ }
        await _humanDelay(200, 500);

        // Fire a real MouseEvent — Angular Material buttons sometimes ignore
        // .click() because they bind to mousedown/mouseup pairs.
        try {
            const rect = btn.getBoundingClientRect();
            const x = rect.left + rect.width / 2;
            const y = rect.top + rect.height / 2;
            for (const type of ['mousedown', 'mouseup', 'click']) {
                btn.dispatchEvent(new MouseEvent(type, {
                    view: window, bubbles: true, cancelable: true, button: 0,
                    clientX: x, clientY: y,
                }));
            }
        } catch (e) {
            console.warn('[WoS Session] dispatchEvent click failed, falling back to .click()', e);
            btn.click();
        }
        await _humanDelay(800, 1500);
        return true;
    }

    // ── Step 2b: Click "Sign In" inside the opened dropdown menu ──
    async function clickMenuSignIn() {
        const menuPanel = document.querySelector('.mat-mdc-menu-panel');
        if (!menuPanel || !isVisible(menuPanel)) return false;

        const signInItem = Array.from(menuPanel.querySelectorAll('a[role="menuitem"], button[role="menuitem"], .mat-mdc-menu-item')).find(el => {
            const text = (el.textContent || '').trim().toLowerCase();
            return text === 'sign in';
        });

        if (signInItem) {
            // Same as the header button — save the page we're abandoning so
            // background.js can restore it after login.
            saveReturnUrlIfDataPage('beforeMenuSignIn');
            console.log('[WoS Session] Clicking Sign In menu item');
            signInItem.scrollIntoView({ block: 'center', behavior: 'instant' });
            await _humanDelay(200, 400);
            signInItem.click();
            await _humanDelay(800, 1500);
            return true;
        }
        return false;
    }

    // ── Step 3: Fill credentials and submit ──
    async function fillAndSubmitLogin() {
        const emailInput = document.querySelector('input#mat-input-1, input[name="email"], input[formcontrolname="email"], input[type="email"]');
        const passwordInput = document.querySelector('input#mat-input-0, input[name="password"], input[formcontrolname="password"]');
        const submitBtn = document.querySelector('button#signIn-btn, button[type="submit"][name="login-btn"], form[name="loginForm"] button[type="submit"]');

        if (!emailInput || !passwordInput) {
            console.warn('[WoS Session] Email or password input not found');
            return false;
        }

        // If by some flow we reached the login page without saveReturnUrl
        // having fired (e.g. the user already had the page open when the
        // session expired), we can't recover the original URL — but we can
        // still log the attempt for debugging.
        console.log('\n[WoS Session] 🔐 LOGIN PROCESS STARTING from URL:', window.location.href, '\n');

        // STEP 1: EMAIL
        emailInput.click();
        emailInput.focus();
        await _humanDelay(400, 700);
        setAngularInputValue(emailInput, CONFIG.email, 'EMAIL');
        await _humanDelay(3000, 5000);

        // STEP 2: PASSWORD
        passwordInput.click();
        passwordInput.focus();
        await _humanDelay(400, 700);
        setAngularInputValue(passwordInput, CONFIG.password, 'PASSWORD');
        await _humanDelay(3000, 5000);

        // STEP 3: SUBMIT
        console.log('[WoS Session] 📤 Submitting form...');
        console.log(`[WoS Session] Email: "${emailInput.value}"`);
        console.log(`[WoS Session] Password: "${passwordInput.value}"`);

        // Persist a "login was just submitted" sentinel BEFORE clicking
        // submit. The form post triggers a redirect chain that kills
        // this JS context within ~1 second — any
        // chrome.runtime.sendMessage we fire AFTER submit is racing
        // navigation and was being lost in practice. The sentinel goes
        // into chrome.storage.session via the background (this script
        // runs in MAIN world and can't touch chrome.storage directly).
        // Storage survives navigation so the post-login attemptRecovery
        // on the landed-on WoS page picks up the breadcrumb and asks
        // background to fire WOS_LOGIN_SUCCESS.
        try {
            await chrome.runtime.sendMessage({ type: 'WOS_SET_LOGIN_PENDING' });
            console.log('[WoS Session] wos_login_pending sentinel set via background');
        } catch (e) {
            console.warn('[WoS Session] Could not set login-pending sentinel:', e?.message || e);
        }

        const form = document.querySelector('form[name="loginForm"], form.steam-login-panel');
        if (submitBtn) {
            submitBtn.scrollIntoView({ block: 'center', behavior: 'instant' });
            await _humanDelay(1500, 2500);
            console.log('[WoS Session] ✓ SUBMIT CLICKED');
            submitBtn.click();
        } else {
            console.warn('[WoS Session] ❌ Submit button not found!');
        }

        if (form) {
            console.log('[WoS Session] Dispatching form submit event');
            form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
        }
        // DO NOT fire WOS_LOGIN_SUCCESS here. The form post hasn't even
        // completed — auth cookies aren't set yet — and any navigation
        // background.js triggers in response would race the redirect
        // chain and either land on an anonymous page (re-triggering
        // login → loop) or, more commonly, get overwritten by the
        // chain itself, leaving the tab on basic-search. Worse, this
        // call also consumes the wos_return_url + wos_login_pending
        // flags from storage, which kills the post-login breadcrumb
        // path that IS reliable. The breadcrumb (checkPostLoginBreadcrumb
        // → WOS_CHECK_POST_LOGIN) fires on the post-redirect WoS page
        // when auth is fully established, and is the single source of
        // truth for "login finished, navigate back to task URL".

        console.log('\n[WoS Session] 🔐 LOGIN PROCESS COMPLETE\n');
        return true;
    }

    /**
     * Post-login breadcrumb: on any subsequent page load, ask the
     * background whether a {@code wos_login_pending} sentinel is set.
     * If yes, background consumes the flag and fires WOS_LOGIN_SUCCESS
     * internally to navigate the tab back to the saved return URL.
     *
     * <p>This script runs in MAIN world so it has no direct access to
     * {@code chrome.storage} — all storage interactions must go through
     * the background via {@code chrome.runtime.sendMessage}.
     */
    async function checkPostLoginBreadcrumb() {
        try {
            const host = window.location.host;
            // Only fire on WoS pages — login redirects through Clarivate,
            // and we don't want to ask while still on the auth domain.
            if (!host.includes('webofscience.com')) return false;
            const resp = await chrome.runtime.sendMessage({ type: 'WOS_CHECK_POST_LOGIN' });
            if (resp?.fired) {
                console.log('[WoS Session] Post-login breadcrumb consumed by background — login success dispatched');
            }
            return resp?.fired === true;
        } catch (e) {
            console.warn('[WoS Session] checkPostLoginBreadcrumb failed:', e?.message || e);
            return false;
        }
    }

    // ── Main recovery loop ──
    async function attemptRecovery() {
        try {
            // First thing every tick: if we just submitted the login form
            // and the redirect chain landed us on a WoS page, fire the
            // WOS_LOGIN_SUCCESS signal so background.js can navigate the
            // tab back to the original task URL. The sentinel was set
            // pre-submit; this consumes it once.
            await checkPostLoginBreadcrumb();

            const ctrl = findSignInControl()
            const articleVisible = hasArticleContent()
            const loginFormVisible = !!document.querySelector('input[name="email"], input[formcontrolname="email"], input#mat-input-1')
            const pendoVisible = !!document.querySelector('[id^="pendo-g-"]')
            const freeViewBanner = hasFreeViewBanner()

            console.log('[WoS Session] attempt', checkAttempts + 1,
                'host=', window.location.host,
                'path=', window.location.pathname,
                'hasArticleContent=', articleVisible,
                'signInControl=', ctrl ? `${ctrl.tagName}<${(ctrl.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 40)}>` : 'NULL',
                'loginForm=', loginFormVisible,
                'pendoPopup=', pendoVisible,
                'freeViewBanner=', freeViewBanner,
                'menuPanel=', !!document.querySelector('.mat-mdc-menu-panel'))

            // ★ Early exit when the session is clearly fine: real article /
            //   profile content is rendered AND there's no Sign In control
            //   to click AND we're not on a login form AND the "free view"
            //   banner isn't there (banner means the page is anonymous,
            //   metrics are partial, scrape will be incomplete — we MUST
            //   log in even if author name etc. is rendered).
            // Probe mode is captured at script init (Angular strips the
            // hash before our timers fire). The probe lives on
            // /wos/woscc/basic-search which has no article content, so
            // the regular `articleVisible` precondition would never
            // fire for a logged-in probe — leaving the handler looping
            // until the 90s timeout and the orchestrator stuck in a
            // probe → expire → re-probe cycle. In probe mode we accept
            // "no Sign In, no login form, no free-view banner, no
            // Pendo" as proof of an active session.
            const isProbeMode = __PROBE_MODE;
            const sessionLooksFine = !ctrl && !loginFormVisible && !pendoVisible && !freeViewBanner;
            if (sessionLooksFine && (articleVisible || isProbeMode)) {
                // Stop polling; nothing for us to do here.
                clearInterval(intervalId);
                console.log('[WoS Session] Session looks fine'
                    + (isProbeMode ? ' (probe mode — no article content required)' : '')
                    + '. Standing down.');
                // Probe tab: tell background the session is verified so
                // the orchestrator can release the WoS phase gate. The
                // probe tab itself will be closed by background.
                if (isProbeMode) {
                    try {
                        chrome.runtime.sendMessage({ type: 'WOS_SESSION_OK', reason: 'probe-clear' });
                        console.log('[WoS Session] Probe: WOS_SESSION_OK sent');
                    } catch (e) {
                        // Swallow — background will time the probe out.
                    }
                }
                return false;
            }

            // ★ WoS onboarding screen — account lacks a researcher
            //   profile and WoS is forcing /create-profile flow,
            //   silently redirecting away from /citation-report
            //   and /full-record pages. The scrape can never
            //   succeed in this state; loop forever doesn't help.
            //   Stop polling and report so the operator panel can
            //   surface a clear "account needs profile setup" error.
            if (hasOnboardingProfileRequired()) {
                clearInterval(intervalId);
                console.warn('[WoS Session] Onboarding required — WoS is blocking access until a researcher profile is created. Standing down.');
                try {
                    chrome.runtime.sendMessage({
                        type: 'SESSION_EVENT',
                        source: 'WOS',
                        event: 'ONBOARDING_REQUIRED',
                        detail: 'WoS account has no researcher profile; citation report is redirected to onboarding screen',
                    });
                } catch (e) {
                    // Ignore — extension context may be closed
                }
                return false;
            }

            // Anonymous mode on a data page → go straight to login.
            // Trigger conditions (any of):
            //   • free-view banner is visible (English or Turkish), OR
            //   • a Sign In control is visible (modern WoS layouts often
            //     drop the banner but still show Sign In in the header
            //     when anonymous).
            // Both reliably mean "we're not logged in and the scrape will
            // come back partial". The previous code tried to click the
            // header Sign In button up to 2 times before giving up — but
            // clicking it on the new Angular layout often opens-and-
            // closes the dropdown in the same tick, so we'd loop. Direct
            // navigation to access.clarivate.com/login is deterministic
            // and the form-fill code there picks up automatically.
            if ((freeViewBanner || ctrl) && !loginFormVisible && isDataPage()) {
                const reason = freeViewBanner ? 'free-view banner' : 'Sign In control';
                console.log('[WoS Session] Anonymous data page detected (' + reason + ') — forcing login URL immediately');
                await forceNavigateToLogin();
                return true;
            }

            // 1. Dismiss Pendo if present
            const pendoDismissed = await dismissPendoPopup();

            // 2. If login form is already visible, fill & submit
            const emailInput = document.querySelector('input[name="email"], input[formcontrolname="email"], input#mat-input-1');
            if (emailInput) {
                if (!loginInProgressReported) {
                    loginInProgressReported = true;
                    reportSession('LOGIN_IN_PROGRESS', 'login form visible, filling credentials');
                }
                await fillAndSubmitLogin();
                return true;
            }

            // 3. If a dropdown menu is open with Sign In inside, click it
            const menuPanel = document.querySelector('.mat-mdc-menu-panel');
            if (menuPanel && isVisible(menuPanel)) {
                const menuSignIn = Array.from(menuPanel.querySelectorAll('a[role="menuitem"], button[role="menuitem"], .mat-mdc-menu-item')).find(el => {
                    const text = (el.textContent || '').trim().toLowerCase();
                    return text === 'sign in';
                });
                if (menuSignIn) {
                    await clickMenuSignIn();
                    return true;
                }
            }

            // 4. If a "Sign In" control is anywhere on the page, click it.
            //    But cap our trust in the dropdown flow: WoS's new layout
            //    occasionally opens-and-closes the menu within the same
            //    Angular tick, so blind retries loop forever. After
            //    MAX_SIGN_IN_CLICK_ATTEMPTS we abandon the dropdown and
            //    force-navigate to the Clarivate login URL directly — the
            //    form-handling code in this same script will pick up there.
            const signInBtn = findSignInControl();
            if (signInBtn) {
                if (!loginDetectedReported) {
                    loginDetectedReported = true;
                    reportSession('LOGIN_DETECTED', 'Sign In control visible — session expired');
                }
                if (signInClickAttempts >= MAX_SIGN_IN_CLICK_ATTEMPTS) {
                    console.log('[WoS Session] Sign In click attempted '
                        + signInClickAttempts + ' times without opening the login form — switching to direct nav');
                    await forceNavigateToLogin();
                    return true;
                }
                signInClickAttempts++;
                console.log('[WoS Session] Sign In click attempt #' + signInClickAttempts + '/' + MAX_SIGN_IN_CLICK_ATTEMPTS);
                await clickHeaderSignIn();
                return true;
            }

            // 5. Last resort: data page where we couldn't find any Sign In
            //    control after several attempts (we lowered the threshold
            //    from 5 → 3 because the user-visible "free view" banner
            //    means the page is anonymous; we shouldn't loiter waiting).
            //    background.js stores the original URL and will navigate
            //    back after WOS_LOGIN_SUCCESS.
            if (checkAttempts >= 3 && isDataPage()) {
                console.log('[WoS Session] No actionable Sign In control after '
                    + checkAttempts + ' attempts — forcing login URL');
                await forceNavigateToLogin();
                return true;
            }

            return pendoDismissed;
        } catch (e) {
            console.warn('[WoS Session] Recovery error:', e);
            return false;
        }
    }

    // Run once shortly after load, then keep polling
    setTimeout(() => {
        console.log('[WoS Session] Initial recovery attempt...');
        attemptRecovery();
    }, 1500);

    const intervalId = setInterval(() => {
        checkAttempts++;
        if (checkAttempts > CONFIG.maxCheckAttempts) {
            console.log('[WoS Session] Max checks reached, stopping session monitor.');
            // If we got far enough to attempt login but it never resolved, signal failure.
            if (loginInProgressReported) {
                reportSession('LOGIN_FAILED', 'auto-login did not complete within ' + CONFIG.maxCheckAttempts + ' checks');
            }
            clearInterval(intervalId);
            return;
        }
        console.log('[WoS Session] Check attempt', checkAttempts, 'of', CONFIG.maxCheckAttempts);
        attemptRecovery();
    }, CONFIG.checkIntervalMs);
})();

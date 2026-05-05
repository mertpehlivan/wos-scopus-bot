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

    async function forceNavigateToLogin() {
        if (forceNavigatedToLogin) return false;
        forceNavigatedToLogin = true;
        const currentUrl = window.location.href;
        // chrome.storage.* may be unavailable in MAIN-world content scripts,
        // so route the persistence through background.js via runtime.sendMessage.
        try {
            chrome.runtime.sendMessage({ type: 'WOS_SET_RETURN_URL', url: currentUrl });
        } catch (e) {
            console.warn('[WoS Session] Could not store return URL:', e);
        }
        if (!loginDetectedReported) {
            loginDetectedReported = true;
            reportSession('LOGIN_DETECTED', 'no Sign In control on data page — forcing login URL');
        }
        console.log('[WoS Session] Force-navigating to login URL, return =', currentUrl);
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
     * Finds the visible "Sign In" control by looking at multiple signals:
     * exact text, partial text, aria-label, data-* attributes, role.
     * WoS rebrands periodically and exact-text-only matching breaks.
     */
    function findSignInControl() {
        const candidates = Array.from(document.querySelectorAll(
            'button, a, [role="button"], mat-menu-item, [cdxanalyticscategory*="sign"]'
        ));
        for (const el of candidates) {
            if (!isVisible(el)) continue;
            const text = (el.textContent || el.innerText || '').replace(/\s+/g, ' ').trim().toLowerCase();
            const aria = ((el.getAttribute && el.getAttribute('aria-label')) || '').toLowerCase();
            const cat = ((el.getAttribute && el.getAttribute('cdxanalyticscategory')) || '').toLowerCase();
            // Match exact "sign in", "sign in to access", "sign in / register" etc.
            // Cap length so we don't match a paragraph that contains the phrase.
            if (text.length < 30 && (text === 'sign in' || text.startsWith('sign in') || text.endsWith('sign in'))) {
                return el;
            }
            if (aria.includes('sign in') || cat.includes('sign_in') || cat.includes('signin')) {
                return el;
            }
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
        const text = (btn.textContent || '').replace(/\s+/g, ' ').trim();
        console.log('[WoS Session] Clicking Sign In control: text="' + text + '", tag=' + btn.tagName);
        try {
            btn.scrollIntoView({ block: 'center', behavior: 'instant' });
        } catch (_) { /* scrollIntoView may throw inside iframes */ }
        await _humanDelay(200, 500);
        btn.click();
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

        console.log('\n[WoS Session] 🔐 LOGIN PROCESS STARTING\n');

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
        await _humanDelay(1000, 2000);

        // Signal background that login succeeded - background will reload tab to retry scraping
        setTimeout(() => {
            try {
                chrome.runtime.sendMessage({ type: 'WOS_LOGIN_SUCCESS' });
                console.log('[WoS Session] WOS_LOGIN_SUCCESS signal sent to background');
            } catch (e) {
                console.warn('[WoS Session] Failed to send login success signal:', e);
            }
        }, 1000);

        console.log('\n[WoS Session] 🔐 LOGIN PROCESS COMPLETE\n');
        return true;
    }

    // ── Main recovery loop ──
    async function attemptRecovery() {
        try {
            // Quick health check log so we know the script is running and
            // can see what state the page is in when we couldn't act.
            console.log('[WoS Session] attempt', checkAttempts + 1,
                'url=', window.location.pathname,
                'hasArticleContent=', hasArticleContent(),
                'signInControl=', !!findSignInControl(),
                'loginForm=', !!document.querySelector('input[name="email"], input[formcontrolname="email"], input#mat-input-1'));

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

            // 4. If a "Sign In" control is anywhere on the page, click it
            const signInBtn = findSignInControl();
            if (signInBtn) {
                if (!loginDetectedReported) {
                    loginDetectedReported = true;
                    reportSession('LOGIN_DETECTED', 'Sign In control visible — session expired');
                }
                await clickHeaderSignIn();
                return true;
            }

            // 5. Last resort: detail/citation pages without any Sign In control
            //    AND without article content visible. After a few attempts of
            //    finding nothing, force-navigate to the canonical login URL so
            //    the form-handling code below picks up. The backend's
            //    pendingTabs.entry tracks the original URL via the hash so
            //    background.js can restore it after WOS_LOGIN_SUCCESS.
            if (checkAttempts >= 3 && isDataPage() && !hasArticleContent()) {
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

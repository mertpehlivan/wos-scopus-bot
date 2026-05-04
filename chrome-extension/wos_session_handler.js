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

    function _humanDelay(min = 300, max = 800) {
        return new Promise(resolve => setTimeout(resolve, Math.floor(Math.random() * (max - min + 1)) + min));
    }

    function isVisible(el) {
        return el && el.offsetParent !== null;
    }

    function getVisibleElement(selectors) {
        if (typeof selectors === 'string') selectors = [selectors];
        for (const sel of selectors) {
            const el = document.querySelector(sel);
            if (isVisible(el)) return el;
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
        const btns = Array.from(document.querySelectorAll('button, a'));
        console.log('[WoS Session] Found', btns.length, 'buttons/links on page');

        // Try exact match first
        const signInBtn = btns.find(b => {
            const text = (b.textContent || b.innerText || '').trim().toLowerCase();
            const visible = isVisible(b);
            if (text.includes('sign')) {
                console.log('[WoS Session] Found button with "sign":', text, 'visible:', visible, 'classes:', b.className);
            }
            return text === 'sign in' && visible;
        });
        if (signInBtn) {
            console.log('[WoS Session] Clicking header Sign In button (exact match)');
            signInBtn.scrollIntoView({ block: 'center', behavior: 'instant' });
            await _humanDelay(200, 500);
            signInBtn.click();
            await _humanDelay(800, 1500);
            return true;
        }

        // Fallback: try to find by cdxanalyticscategory attribute
        const wosSignInBtn = document.querySelector('button[cdxanalyticscategory="wos-header-sign_in"], button.wos-sign-in');
        if (wosSignInBtn && isVisible(wosSignInBtn)) {
            console.log('[WoS Session] Clicking header Sign In button (attribute match)');
            wosSignInBtn.scrollIntoView({ block: 'center', behavior: 'instant' });
            await _humanDelay(200, 500);
            wosSignInBtn.click();
            await _humanDelay(800, 1500);
            return true;
        }

        console.log('[WoS Session] Header Sign In button not found');
        return false;
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
            // 1. Dismiss Pendo if present
            const pendoDismissed = await dismissPendoPopup();

            // 2. If login form is already visible, fill & submit
            const emailInput = document.querySelector('input[name="email"], input[formcontrolname="email"], input#mat-input-1');
            if (emailInput) {
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

            // 4. If header "Sign In" button is visible, click it to open the dropdown
            const signInBtn = Array.from(document.querySelectorAll('button, a')).find(b => {
                const text = (b.textContent || '').trim().toLowerCase();
                return text === 'sign in' && isVisible(b);
            });
            if (signInBtn) {
                await clickHeaderSignIn();
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
            clearInterval(intervalId);
            return;
        }
        console.log('[WoS Session] Check attempt', checkAttempts, 'of', CONFIG.maxCheckAttempts);
        attemptRecovery();
    }, CONFIG.checkIntervalMs);
})();

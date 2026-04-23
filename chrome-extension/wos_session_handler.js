/**
 * wos_session_handler.js
 * Handles WoS session expiry by auto-dismissing the Pendo "free view" popup,
 * clicking "Sign In", filling credentials, and submitting the login form.
 *
 * Runs on all *.webofscience.com pages.
 */
(function () {
    if (window.__wosSessionHandlerRunning) return;
    window.__wosSessionHandlerRunning = true;

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

    // ── Step 2: Click header "Sign In" button ──
    async function clickHeaderSignIn() {
        const btns = Array.from(document.querySelectorAll('button, a'));
        const signInBtn = btns.find(b => {
            const text = (b.textContent || b.innerText || '').trim().toLowerCase();
            return text === 'sign in' && isVisible(b);
        });
        if (signInBtn) {
            console.log('[WoS Session] Clicking header Sign In button');
            signInBtn.scrollIntoView({ block: 'center', behavior: 'instant' });
            await _humanDelay(200, 500);
            signInBtn.click();
            await _humanDelay(800, 1500);
            return true;
        }
        return false;
    }

    // ── Step 3: Fill credentials and submit ──
    async function fillAndSubmitLogin() {
        const emailInput = getVisibleElement([
            'input#mat-input-1',
            'input[name="email"]',
            'input[formcontrolname="email"]',
            'input[type="email"]'
        ]);
        const passwordInput = getVisibleElement([
            'input#mat-input-0',
            'input[name="password"]',
            'input[formcontrolname="password"]'
        ]);
        const submitBtn = getVisibleElement([
            'button#signIn-btn',
            'button[type="submit"][name="login-btn"]',
            'form[name="loginForm"] button[type="submit"]'
        ]);

        if (!emailInput || !passwordInput) {
            return false;
        }

        console.log('[WoS Session] Filling login credentials');

        // Fill email
        emailInput.focus();
        await _humanDelay(100, 300);
        emailInput.value = CONFIG.email;
        emailInput.dispatchEvent(new Event('input', { bubbles: true }));
        emailInput.dispatchEvent(new Event('change', { bubbles: true }));
        await _humanDelay(200, 500);

        // Fill password
        passwordInput.focus();
        await _humanDelay(100, 300);
        passwordInput.value = CONFIG.password;
        passwordInput.dispatchEvent(new Event('input', { bubbles: true }));
        passwordInput.dispatchEvent(new Event('change', { bubbles: true }));
        await _humanDelay(400, 800);

        // Submit
        if (submitBtn) {
            console.log('[WoS Session] Clicking Sign In submit button');
            submitBtn.scrollIntoView({ block: 'center', behavior: 'instant' });
            await _humanDelay(200, 400);
            submitBtn.click();
        } else {
            const form = document.querySelector('form[name="loginForm"], form.steam-login-panel');
            if (form) {
                form.dispatchEvent(new Event('submit', { bubbles: true }));
            }
        }
        await _humanDelay(1000, 2000);
        return true;
    }

    // ── Main recovery loop ──
    async function attemptRecovery() {
        try {
            // 1. Dismiss Pendo if present
            const pendoDismissed = await dismissPendoPopup();

            // 2. If login form is already visible, fill & submit
            const emailInput = document.querySelector('input[name="email"], input[formcontrolname="email"], input#mat-input-1');
            if (isVisible(emailInput)) {
                await fillAndSubmitLogin();
                return true;
            }

            // 3. If header "Sign In" button is visible, click it to reveal the form
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
        attemptRecovery();
    }, 1500);

    const intervalId = setInterval(() => {
        checkAttempts++;
        if (checkAttempts > CONFIG.maxCheckAttempts) {
            console.log('[WoS Session] Max checks reached, stopping session monitor.');
            clearInterval(intervalId);
            return;
        }
        attemptRecovery();
    }, CONFIG.checkIntervalMs);
})();

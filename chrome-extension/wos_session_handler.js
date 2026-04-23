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

    async function setNativeValue(element, value) {
        console.log('[WoS Session] Typing value for', element.name || element.id);
        
        element.scrollIntoView({ block: 'center', behavior: 'instant' });
        await _humanDelay(50, 150);

        // Simulate click and focus
        element.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
        element.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
        element.click();
        element.focus();
        element.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));

        await _humanDelay(100, 200);

        // Clear existing value safely
        try {
            let setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
            setter.call(element, '');
        } catch (e) {
            element.value = '';
        }
        element.dispatchEvent(new Event('input', { bubbles: true }));
        await _humanDelay(50, 100);

        // Type character by character
        for (let i = 0; i < value.length; i++) {
            const char = value[i];
            try {
                let setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
                setter.call(element, element.value + char);
            } catch (e) {
                element.value += char;
            }
            element.dispatchEvent(new KeyboardEvent('keydown', { key: char, bubbles: true }));
            element.dispatchEvent(new KeyboardEvent('keypress', { key: char, bubbles: true }));
            element.dispatchEvent(new InputEvent('input', { bubbles: true, composed: true, data: char }));
            element.dispatchEvent(new Event('input', { bubbles: true }));
            element.dispatchEvent(new KeyboardEvent('keyup', { key: char, bubbles: true }));
            await _humanDelay(10, 40); // Fast human typing
        }

        element.dispatchEvent(new Event('change', { bubbles: true }));
        await _humanDelay(100, 200);

        // Blur to trigger final validation
        element.blur();
        element.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));

        console.log('[WoS Session] Typing complete. Current value:', element.value);
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
            return false;
        }

        console.log('[WoS Session] Filling login credentials (Angular-aware)');

        // Fill email
        await setNativeValue(emailInput, CONFIG.email);
        await _humanDelay(200, 400);

        // Fill password
        await setNativeValue(passwordInput, CONFIG.password);
        await _humanDelay(400, 800);

        // Submit — click button + dispatch form submit for Angular
        const form = document.querySelector('form[name="loginForm"], form.steam-login-panel');
        if (submitBtn) {
            console.log('[WoS Session] Clicking Sign In submit button');
            submitBtn.scrollIntoView({ block: 'center', behavior: 'instant' });
            await _humanDelay(200, 400);
            submitBtn.click();
        }
        if (form) {
            console.log('[WoS Session] Dispatching form submit event');
            form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
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

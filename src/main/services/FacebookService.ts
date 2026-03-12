
import { createObjectCsvWriter } from 'csv-writer';
import { BrowserService } from './BrowserService';
import { SessionService } from './SessionService';
import { ImageAnalysisService } from './ImageAnalysisService';
import { Page } from 'playwright';
import fs from 'fs-extra';
import path from 'path';
import { app } from 'electron';

export class FacebookService {
    private browserService: BrowserService;
    private sessionService: SessionService;
    private imageAnalysisService: ImageAnalysisService;
    private page: Page | null = null;
    private isLoggedIn: boolean = false;
    private logCallback: ((msg: string) => void) | null = null;

    constructor() {
        this.browserService = new BrowserService();
        this.sessionService = new SessionService();
        this.imageAnalysisService = new ImageAnalysisService();
    }

    setLogger(callback: (msg: string) => void) {
        this.logCallback = callback;
    }

    private log(msg: string) {
        console.log(msg);
        if (this.logCallback) this.logCallback(msg);
    }

    async start(profileId: string = 'default', headless: boolean = false, skipAutoLogin: boolean = false) {
        await this.browserService.launchBrowser(headless);
        await this.browserService.createContext(profileId);
        this.page = await this.browserService.createPage();

        // Check login status with retry
        for (let i = 0; i < 3; i++) {
            try {
                await this.page.goto('https://facebook.com', { timeout: 60000, waitUntil: 'domcontentloaded' });
                break;
            } catch (e) {
                console.log(`Connection attempt ${i + 1}/3 failed. Retrying...`);
                if (i === 2) throw e;
                await this.page.waitForTimeout(2000);
            }
        }
        try {
            await this.page.waitForSelector('[role="navigation"]', { timeout: 5000 });
            this.isLoggedIn = true;
            this.log('Already logged in!');
        } catch (e) {
            this.isLoggedIn = false;
            if (skipAutoLogin) {
                this.log('Not logged in. Skipping auto-login (will use loginWithCredentials).');
            } else {
                this.log('Not logged in. Session expired. Triggering Auto-Login...');
                await this.loginManual();
            }
        }
    }

    /**
     * Login to Facebook by injecting cookies into the browser context.
     * Accepts cookies as a JSON string (array of {name, value, domain} objects)
     * or as a header-style string (name=value; name2=value2).
     */
    async loginWithCookies(cookieString: string): Promise<boolean> {
        this.log('🍪 [COOKIE LOGIN] Starting cookie-based login...');

        try {
            // Ensure browser is started
            await this.browserService.launchBrowser(false);
            await this.browserService.createContext('default');
            this.page = await this.browserService.createPage();

            if (!this.page) throw new Error('Failed to create page');

            const context = this.browserService.getContext();
            if (!context) throw new Error('No browser context available');

            // Parse cookies
            let cookies: Array<{ name: string; value: string; domain: string; path: string }> = [];

            const trimmed = cookieString.trim();

            if (trimmed.startsWith('[')) {
                // JSON array format: [{"name":"c_user","value":"xxx","domain":".facebook.com"}, ...]
                try {
                    const parsed = JSON.parse(trimmed);
                    cookies = parsed.map((c: any) => ({
                        name: c.name,
                        value: c.value,
                        domain: c.domain || '.facebook.com',
                        path: c.path || '/',
                    }));
                    this.log(`🍪 [COOKIE LOGIN] Parsed ${cookies.length} cookies from JSON array`);
                } catch (e: any) {
                    this.log(`❌ [COOKIE LOGIN] JSON parse error: ${e.message}`);
                    return false;
                }
            } else {
                // Header-style format: c_user=xxx; xs=yyy; fr=zzz
                // or one-per-line: c_user=xxx\nxs=yyy\nfr=zzz
                const pairs = trimmed
                    .split(/[;\n]/)
                    .map(s => s.trim())
                    .filter(s => s.includes('='));

                for (const pair of pairs) {
                    const eqIdx = pair.indexOf('=');
                    const name = pair.substring(0, eqIdx).trim();
                    const value = pair.substring(eqIdx + 1).trim();
                    if (name && value) {
                        cookies.push({ name, value, domain: '.facebook.com', path: '/' });
                    }
                }
                this.log(`🍪 [COOKIE LOGIN] Parsed ${cookies.length} cookies from text format`);
            }

            if (cookies.length === 0) {
                this.log('❌ [COOKIE LOGIN] No valid cookies found. Pastikan format benar.');
                return false;
            }

            // Check for essential Facebook cookies
            const essentialNames = ['c_user', 'xs'];
            const foundEssential = essentialNames.filter(n => cookies.some(c => c.name === n));
            const missingEssential = essentialNames.filter(n => !cookies.some(c => c.name === n));

            if (foundEssential.length > 0) {
                this.log(`✅ [COOKIE LOGIN] Essential cookies found: ${foundEssential.join(', ')}`);
            }
            if (missingEssential.length > 0) {
                this.log(`⚠️ [COOKIE LOGIN] Missing essential cookies: ${missingEssential.join(', ')} — mungkin tidak bisa login`);
            }

            // Inject cookies into browser context
            await context.addCookies(cookies);
            this.log('🍪 [COOKIE LOGIN] Cookies injected. Navigating to Facebook...');

            // Navigate to Facebook and verify
            for (let i = 0; i < 3; i++) {
                try {
                    await this.page.goto('https://www.facebook.com/', { timeout: 60000, waitUntil: 'domcontentloaded' });
                    break;
                } catch (e) {
                    if (i === 2) throw e;
                    await this.page.waitForTimeout(2000);
                }
            }

            await this.page.waitForTimeout(3000);

            // Verify login
            try {
                await this.page.waitForSelector('[role="navigation"]', { timeout: 10000 });
                this.log('✅ [COOKIE LOGIN] Login berhasil! Session aktif.');
                this.isLoggedIn = true;

                // Save session for future use
                const ctx = this.browserService.getContext();
                if (ctx) {
                    await this.sessionService.saveSession('default', ctx);
                    this.log('💾 [COOKIE LOGIN] Session saved.');
                }

                return true;
            } catch {
                this.log('❌ [COOKIE LOGIN] Login gagal — cookies mungkin expired atau tidak valid.');
                this.log(`❌ [COOKIE LOGIN] URL: ${this.page.url()}`);
                return false;
            }

        } catch (e: any) {
            this.log(`❌ [COOKIE LOGIN] Error: ${e.message}`);
            return false;
        }
    }

    /**
     * Login with cookies for multi-account campaigns.
     * Unlike loginWithCookies(), this assumes start() was already called
     * (browser + context + page already exist with isolated profileId).
     */
    async loginWithCookiesForCampaign(cookieString: string): Promise<boolean> {
        this.log('🍪 [COOKIE CAMPAIGN] Injecting cookies...');

        if (!this.page) throw new Error('Browser not started. Call start() first.');

        const context = this.browserService.getContext();
        if (!context) throw new Error('No browser context available');

        try {
            // Parse cookies (same logic as loginWithCookies)
            let cookies: Array<{ name: string; value: string; domain: string; path: string }> = [];
            const trimmed = cookieString.trim();

            if (trimmed.startsWith('[')) {
                const parsed = JSON.parse(trimmed);
                cookies = parsed.map((c: any) => ({
                    name: c.name,
                    value: c.value,
                    domain: c.domain || '.facebook.com',
                    path: c.path || '/',
                }));
            } else {
                const pairs = trimmed
                    .split(/[;\n]/)
                    .map(s => s.trim())
                    .filter(s => s.includes('='));

                for (const pair of pairs) {
                    const eqIdx = pair.indexOf('=');
                    const name = pair.substring(0, eqIdx).trim();
                    const value = pair.substring(eqIdx + 1).trim();
                    if (name && value) {
                        cookies.push({ name, value, domain: '.facebook.com', path: '/' });
                    }
                }
            }

            if (cookies.length === 0) {
                this.log('❌ [COOKIE CAMPAIGN] No valid cookies found.');
                return false;
            }

            // Extract c_user for identification
            const cUser = cookies.find(c => c.name === 'c_user');
            const hasXs = cookies.some(c => c.name === 'xs');
            this.log(`🍪 [COOKIE CAMPAIGN] ${cookies.length} cookies | c_user=${cUser?.value || 'MISSING'} | xs=${hasXs ? 'OK' : 'MISSING'}`);

            if (!cUser || !hasXs) {
                this.log('⚠️ [COOKIE CAMPAIGN] Missing essential cookies (c_user, xs).');
            }

            // Inject cookies
            await context.addCookies(cookies);

            // Navigate & verify
            for (let i = 0; i < 3; i++) {
                try {
                    await this.page.goto('https://www.facebook.com/', { timeout: 60000, waitUntil: 'domcontentloaded' });
                    break;
                } catch (e) {
                    if (i === 2) throw e;
                    await this.page.waitForTimeout(2000);
                }
            }
            await this.page.waitForTimeout(3000);

            try {
                await this.page.waitForSelector('[role="navigation"]', { timeout: 10000 });
                this.log('✅ [COOKIE CAMPAIGN] Login berhasil!');
                this.isLoggedIn = true;
                return true;
            } catch {
                this.log('❌ [COOKIE CAMPAIGN] Login gagal — cookies mungkin expired.');
                return false;
            }

        } catch (e: any) {
            this.log(`❌ [COOKIE CAMPAIGN] Error: ${e.message}`);
            return false;
        }
    }

    async checkLoginStatus(): Promise<boolean> {
        if (!this.page) return false;
        try {
            // Attempt to load page with retries
            for (let i = 0; i < 3; i++) {
                try {
                    await this.page.goto('https://facebook.com', { timeout: 60000, waitUntil: 'domcontentloaded' });
                    break;
                } catch (e) {
                    if (i === 2) throw e;
                    await this.page.waitForTimeout(2000);
                }
            }
            await this.page.waitForSelector('[role="navigation"]', { timeout: 5000 });
            this.isLoggedIn = true;
            console.log('Session is valid. Logged in.');
            return true;
        } catch (e) {
            console.log('Session invalid or expired.');
            this.isLoggedIn = false;
            return false;
        }
    }

    async loginManual(): Promise<boolean> {
        console.log('Launching browser for login...');
        await this.browserService.launchBrowser(false);
        const context = await this.browserService.createContext('default');
        this.page = await this.browserService.createPage();

        if (!this.page) throw new Error('Failed to create page');

        await this.page.goto('https://facebook.com', { timeout: 60000, waitUntil: 'domcontentloaded' });

        try {
            await this.page.waitForSelector('[role="navigation"]', { timeout: 3000 });
            console.log('Already logged in with existing session.');
            this.isLoggedIn = true;
            return true;
        } catch (e) {
            console.log('Not logged in. Waiting for manual login...');
        }

        // Final Verification (allow user to login manually)
        try {
            await this.page.waitForSelector('[role="navigation"]', { timeout: 60000 });
            console.log('Manual login successful! Saving session...');
            if (context) await this.sessionService.saveSession('default', context);
            this.isLoggedIn = true;
            return true;
        } catch (error) {
            console.error('Login verification failed.');
            return false;
        }
    }

    /**
     * Auto-login with given credentials. Used for multi-account CSV campaigns.
     */
    async loginWithCredentials(email: string, password: string, skipOnFail: boolean = true): Promise<boolean> {
        this.log(`🔐 [LOGIN] Attempting login for: ${email}`);

        if (!this.page) throw new Error('Browser not started before loginWithCredentials');

        // Navigate to Facebook login page — wait for full load
        try {
            await this.page.goto('https://www.facebook.com/', { timeout: 60000, waitUntil: 'networkidle' });
        } catch (e: any) {
            this.log(`⚠️ [LOGIN] Navigation timeout, proceeding anyway: ${e.message}`);
        }
        await this.page.waitForTimeout(3000);

        // Dismiss cookie consent dialogs (common on fresh browser profiles)
        await this.dismissCookieConsent();

        // === PRE-LOGIN: Simulate human behavior to reduce CAPTCHA triggers ===
        await this.simulateHumanBehavior();

        // === PRE-LOGIN: Check for full-page CAPTCHA checkpoint ===
        await this.handleCaptcha();
        // After CAPTCHA, page might redirect — wait a bit
        await this.page.waitForTimeout(2000);

        // Already logged in?
        try {
            await this.page.waitForSelector('[role="navigation"]', { timeout: 4000 });
            this.log(`✅ [LOGIN] Already logged in (existing session).`);
            this.isLoggedIn = true;
            return true;
        } catch { }

        // Find the email field using multiple fallback selectors
        this.log('⏳ [LOGIN] Looking for login form...');
        const emailSelectors = [
            '#email',
            'input[name="email"]',
            'input[type="email"]',
            'input[aria-label*="email" i]',
            'input[aria-label*="Email" i]',
            'input[aria-label*="ponsel" i]',
            'input[data-testid="royal_email"]',
        ];

        let emailField: any = null;
        let usedEmailSelector = '';
        for (const sel of emailSelectors) {
            try {
                emailField = await this.page.waitForSelector(sel, { timeout: 3000 });
                if (emailField) {
                    usedEmailSelector = sel;
                    this.log(`✅ [LOGIN] Found email field via: ${sel}`);
                    break;
                }
            } catch { }
        }

        if (!emailField) {
            this.log(`⚠️ [LOGIN] Login form not found. Checking if CAPTCHA is blocking...`);
            this.log(`📄 [LOGIN] URL: ${this.page.url()}`);

            // Dump page content for debugging
            try {
                const bodySnippet = await this.page.$eval('body', (el: any) => el.innerText.substring(0, 300));
                this.log(`📄 [LOGIN] Page content: ${bodySnippet.replace(/\n/g, ' | ')}`);
            } catch { }

            // Check if CAPTCHA is blocking and try to solve it
            const pageText = await this.page.$eval('body', (el: any) => el.innerText).catch(() => '');
            const hasCaptcha = pageText.includes('bukan robot') || 
                               pageText.includes('not a robot') || 
                               pageText.includes('reCAPTCHA') ||
                               pageText.includes('security check') ||
                               await this.page.$('iframe[src*="recaptcha"]') !== null;

            if (hasCaptcha) {
                this.log('🚨 [LOGIN] CAPTCHA detected! Attempting to solve...');
                await this.handleCaptcha();
                
                // After CAPTCHA solved, retry finding login form (up to 3 attempts)
                for (let retry = 0; retry < 3; retry++) {
                    this.log(`🔄 [LOGIN] Retry ${retry + 1}/3 — looking for login form...`);
                    await this.page.waitForTimeout(3000);

                    // Maybe we're already logged in after CAPTCHA
                    try {
                        await this.page.waitForSelector('[role="navigation"]', { timeout: 3000 });
                        this.log(`✅ [LOGIN] Logged in after CAPTCHA!`);
                        this.isLoggedIn = true;
                        return true;
                    } catch { }

                    // Try to find email field again
                    for (const sel of emailSelectors) {
                        try {
                            emailField = await this.page.waitForSelector(sel, { timeout: 3000 });
                            if (emailField) {
                                usedEmailSelector = sel;
                                this.log(`✅ [LOGIN] Found email field on retry: ${sel}`);
                                break;
                            }
                        } catch { }
                    }
                    if (emailField) break;
                }
            }

            // If still no login form after all retries
            if (!emailField) {
                this.log(`❌ [LOGIN] Login form still not found for ${email}. Skipping.`);
                try {
                    await this.page.screenshot({ path: 'login_fail_debug.png' });
                    this.log('📸 [LOGIN] Screenshot saved: login_fail_debug.png');
                } catch { }
                return false;
            }
        }

        // Find password field
        const passSelectors = ['#pass', 'input[name="pass"]', 'input[type="password"]', 'input[data-testid="royal_pass"]'];
        let passField: any = null;
        for (const sel of passSelectors) {
            passField = await this.page.$(sel);
            if (passField) break;
        }

        // Find login button
        const loginBtnSelectors = ['[name="login"]', 'button[data-testid="royal_login_button"]', 'button[type="submit"]'];
        let loginBtn: any = null;
        for (const sel of loginBtnSelectors) {
            loginBtn = await this.page.$(sel);
            if (loginBtn) break;
        }

        // Fill login form
        try {
            this.log(`⌨️ [LOGIN] Filling email: ${email}`);
            await emailField.click();
            await this.page.waitForTimeout(300);
            await emailField.click({ clickCount: 3 });
            await this.page.waitForTimeout(200);
            await this.page.keyboard.type(email, { delay: 50 });
            await this.page.waitForTimeout(500);

            if (passField) {
                this.log('⌨️ [LOGIN] Filling password...');
                await passField.click();
                await this.page.waitForTimeout(300);
                await passField.click({ clickCount: 3 });
                await this.page.waitForTimeout(200);
                await this.page.keyboard.type(password, { delay: 50 });
                await this.page.waitForTimeout(500);
            } else {
                this.log('⚠️ [LOGIN] Password field not found, trying Tab to reach it');
                await this.page.keyboard.press('Tab');
                await this.page.waitForTimeout(300);
                await this.page.keyboard.type(password, { delay: 50 });
                await this.page.waitForTimeout(500);
            }

            // Click login button or press Enter
            if (loginBtn) {
                this.log('🔘 [LOGIN] Clicking login button...');
                await loginBtn.click();
            } else {
                this.log('🔘 [LOGIN] No login button found, pressing Enter...');
                await this.page.keyboard.press('Enter');
            }

            // Wait for response
            this.log('⏳ [LOGIN] Waiting for login response...');
            await this.page.waitForTimeout(6000);

        } catch (e: any) {
            this.log(`⚠️ [LOGIN] Form fill error: ${e.message}`);
        }

        // --- CAPTCHA Detection & Click ---
        await this.handleCaptcha();

        // Verify login success
        try {
            await this.page.waitForSelector('[role="navigation"]', { timeout: 15000 });
            this.log(`✅ [LOGIN] Login successful: ${email}`);
            this.isLoggedIn = true;
            await this.saveCookiesForAccount(email);
            return true;
        } catch {
            const url = this.page.url();
            this.log(`❌ [LOGIN] Login failed for: ${email}`);
            this.log(`❌ [LOGIN] URL after attempt: ${url}`);
            try {
                const errorText = await this.page.$eval('[data-testid="royal_login_form_error"], div[role="alert"]', (el: any) => el.innerText).catch(() => '');
                if (errorText) this.log(`❌ [LOGIN] FB Error: ${errorText}`);
            } catch { }

            // If skipOnFail is disabled, wait for manual intervention
            if (!skipOnFail) {
                this.log('⏳ [LOGIN] Skip disabled — menunggu intervensi manual (max 120 detik)...');
                this.log('💡 [LOGIN] Silakan solve CAPTCHA / login manual di browser, lalu tunggu redirect.');
                try {
                    await this.page.waitForSelector('[role="navigation"]', { timeout: 120000 });
                    this.log(`✅ [LOGIN] Manual intervention berhasil: ${email}`);
                    this.isLoggedIn = true;
                    await this.saveCookiesForAccount(email);
                    return true;
                } catch {
                    this.log(`❌ [LOGIN] Timeout — manual intervention gagal untuk: ${email}`);
                    return false;
                }
            }

            return false;
        }
    }

    /**
     * Save cookies for an account after successful login.
     * Exports cookies as "key=value; key=value" format and appends to saved_cookies.txt
     */
    private async saveCookiesForAccount(email: string): Promise<void> {
        try {
            const context = this.browserService.getContext();
            if (!context) return;

            const cookies = await context.cookies(['https://www.facebook.com']);
            if (!cookies.length) {
                this.log(`⚠️ [COOKIES] No cookies found for ${email}`);
                return;
            }

            // Format as header-style: key=value; key=value
            const cookieStr = cookies.map(c => `${c.name}=${c.value}`).join('; ');

            // Save to centralized file
            const cookieDir = path.join(app.getPath('userData'), 'saved_cookies');
            await fs.ensureDir(cookieDir);

            // Append to master file (one line per account: email|||cookies)
            const masterFile = path.join(cookieDir, 'saved_cookies.txt');
            let existingContent = '';
            if (await fs.pathExists(masterFile)) {
                existingContent = await fs.readFile(masterFile, 'utf-8');
            }
            const lines = existingContent.split('\n').filter(l => l.trim().length > 0);
            const filtered = lines.filter(l => !l.startsWith(`${email}|||`));
            filtered.push(`${email}|||${cookieStr}`);
            await fs.writeFile(masterFile, filtered.join('\n') + '\n', 'utf-8');

            // Also save individual file per account
            const safeEmail = email.replace(/[^a-zA-Z0-9@._-]/g, '_');
            const individualFile = path.join(cookieDir, `${safeEmail}.txt`);
            await fs.writeFile(individualFile, cookieStr, 'utf-8');

            const cUser = cookies.find(c => c.name === 'c_user')?.value || 'N/A';
            this.log(`🍪 [COOKIES] Saved cookies for: ${email} (c_user: ${cUser})`);
            this.log(`🍪 [COOKIES] File: ${individualFile}`);
        } catch (e: any) {
            this.log(`⚠️ [COOKIES] Failed to save cookies for ${email}: ${e.message}`);
        }
    }

    /**
     * Dismiss Facebook cookie consent or data policy popups.
     */
    private async dismissCookieConsent(): Promise<void> {
        if (!this.page) return;
        const consentSelectors = [
            // Cookie consent buttons (various FB versions)
            'button[data-cookiebanner="accept_button"]',
            'button[data-testid="cookie-policy-manage-dialog-accept-button"]',
            'button[title="Izinkan semua cookie"]',
            'button[title="Allow all cookies"]',
            'button[title="Accept All"]',
            'button[title="Terima Semua"]',
            // Generic "Allow" / "Accept" / "OK" buttons in dialogs
            '[aria-label="Allow all cookies"]',
            '[aria-label="Izinkan semua cookie"]',
            '[aria-label="Close"]',
        ];

        for (const sel of consentSelectors) {
            try {
                const btn = await this.page.$(sel);
                if (btn && await btn.isVisible()) {
                    this.log(`🍪 [LOGIN] Dismissing consent dialog: ${sel}`);
                    await btn.click();
                    await this.page.waitForTimeout(1500);
                    return;
                }
            } catch { }
        }

        // Fallback: look for any prominent "Accept" button text
        try {
            const btns = await this.page.getByRole('button').all();
            for (const btn of btns) {
                const text = await btn.innerText().catch(() => '');
                const t = text.toLowerCase();
                if (t.includes('accept') || t.includes('allow') || t.includes('izinkan') || t.includes('terima') || t.includes('setuju')) {
                    this.log(`🍪 [LOGIN] Dismissing consent via text: "${text.trim().substring(0, 30)}"`);
                    await btn.click();
                    await this.page.waitForTimeout(1500);
                    return;
                }
            }
        } catch { }
    }

    /**
     * Detect and attempt to click reCAPTCHA checkbox.
     * Handles both:
     * 1. Full-page CAPTCHA checkpoint (appears before login form)
     * 2. Inline reCAPTCHA iframe (appears during/after login)
     */
    private async handleCaptcha(): Promise<void> {
        if (!this.page) return;
        this.log('🔍 [CAPTCHA] Checking for reCAPTCHA...');

        try {
            // === Strategy 1: Full-page CAPTCHA checkpoint ===
            // Check if the page contains "Saya bukan robot" or reCAPTCHA text
            const pageText = await this.page.$eval('body', (el: any) => el.innerText).catch(() => '');
            const isCheckpointPage = pageText.includes('bukan robot') || 
                                     pageText.includes('not a robot') || 
                                     pageText.includes('reCAPTCHA') ||
                                     pageText.includes('security check');

            if (!isCheckpointPage) {
                // Also check for iframe presence
                const hasIframe = await this.page.$('iframe[src*="recaptcha"], iframe[title*="recaptcha" i]');
                if (!hasIframe) {
                    this.log('ℹ️ [CAPTCHA] No reCAPTCHA detected — continuing.');
                    return;
                }
            }

            this.log('🚨 [CAPTCHA] reCAPTCHA checkpoint detected!');

            // === Strategy 2: Find and click the checkbox in iframe ===
            const captchaIframeSelectors = [
                'iframe[src*="recaptcha"]',
                'iframe[title*="recaptcha" i]',
                'iframe[title*="reCAPTCHA"]',
            ];

            let captchaFrame = null;
            for (const sel of captchaIframeSelectors) {
                try {
                    const iframeEl = await this.page.$(sel);
                    if (iframeEl) {
                        captchaFrame = await iframeEl.contentFrame();
                        if (captchaFrame) {
                            this.log(`✅ [CAPTCHA] Found reCAPTCHA iframe via: ${sel}`);
                            break;
                        }
                    }
                } catch { }
            }

            if (captchaFrame) {
                // Try clicking the checkbox
                try {
                    const checkbox = await captchaFrame.waitForSelector('#recaptcha-anchor, .recaptcha-checkbox', { timeout: 8000 });
                    if (checkbox) {
                        // Simulate mouse movement toward checkbox
                        this.log('🖱️ [CAPTCHA] Moving mouse to checkbox...');
                        await this.page.waitForTimeout(500 + Math.random() * 1000);
                        
                        this.log('🖱️ [CAPTCHA] Clicking "Saya bukan robot"...');
                        await checkbox.click();
                        await this.page.waitForTimeout(3000 + Math.random() * 2000);

                        // Check if solved
                        try {
                            const isChecked = await captchaFrame.$eval('#recaptcha-anchor', (el: any) => {
                                return el.getAttribute('aria-checked') === 'true';
                            });
                            if (isChecked) {
                                this.log('✅ [CAPTCHA] Checkbox solved!');
                                await this.page.waitForTimeout(2000);
                                
                                // Look for a submit/continue button on the page
                                await this.clickCaptchaSubmit();
                                return;
                            }
                        } catch { }
                    }
                } catch (e: any) {
                    this.log(`⚠️ [CAPTCHA] Checkbox click error: ${e.message}`);
                }
            }

            // === Strategy 3: Wait for manual solve ===
            this.log('⚠️ [CAPTCHA] Perlu solve manual — image challenge atau checkbox gagal.');
            this.log('💡 [CAPTCHA] Silakan selesaikan CAPTCHA di browser (max 120 detik)...');

            // Wait for either: page redirect (CAPTCHA solved) or navigation change
            const startUrl = this.page.url();
            for (let i = 0; i < 24; i++) {
                await this.page.waitForTimeout(5000);
                const currentUrl = this.page.url();
                
                // Check if page changed (CAPTCHA solved → redirect)
                if (currentUrl !== startUrl) {
                    this.log('✅ [CAPTCHA] Page redirected — CAPTCHA likely solved!');
                    await this.page.waitForTimeout(2000);
                    return;
                }
                
                // Check if login form appeared (CAPTCHA solved, same page)
                const hasLoginForm = await this.page.$('#email, input[name="email"]');
                if (hasLoginForm) {
                    this.log('✅ [CAPTCHA] Login form appeared — CAPTCHA solved!');
                    return;
                }

                // Check if already logged in
                const hasNav = await this.page.$('[role="navigation"]');
                if (hasNav) {
                    this.log('✅ [CAPTCHA] Already logged in after CAPTCHA!');
                    return;
                }

                // Check if iframe checkbox is now checked
                if (captchaFrame) {
                    try {
                        const isNowChecked = await captchaFrame.$eval('#recaptcha-anchor', (el: any) => {
                            return el.getAttribute('aria-checked') === 'true';
                        });
                        if (isNowChecked) {
                            this.log('✅ [CAPTCHA] Checkbox now solved manually!');
                            await this.clickCaptchaSubmit();
                            await this.page.waitForTimeout(2000);
                            return;
                        }
                    } catch { }
                }
            }
            this.log('⚠️ [CAPTCHA] Timeout 120s — melanjutkan...');

        } catch (e: any) {
            this.log(`⚠️ [CAPTCHA] Detection error: ${e.message}`);
        }
    }

    /**
     * After CAPTCHA is solved, look for and click a submit/continue button.
     */
    private async clickCaptchaSubmit(): Promise<void> {
        if (!this.page) return;
        const submitSelectors = [
            'button[type="submit"]',
            'input[type="submit"]',
            '#login_button_inline',
            'button:has-text("Continue")',
            'button:has-text("Lanjutkan")',
            'button:has-text("Submit")',
            'button:has-text("Kirim")',
        ];
        for (const sel of submitSelectors) {
            try {
                const btn = await this.page.$(sel);
                if (btn && await btn.isVisible()) {
                    this.log(`🔘 [CAPTCHA] Clicking submit: ${sel}`);
                    await btn.click();
                    await this.page.waitForTimeout(3000);
                    return;
                }
            } catch { }
        }
    }

    /**
     * Simulate human-like behavior to reduce CAPTCHA triggers.
     */
    private async simulateHumanBehavior(): Promise<void> {
        if (!this.page) return;
        try {
            // Random mouse movements
            const width = 1280;
            const height = 800;
            for (let i = 0; i < 3; i++) {
                const x = Math.floor(Math.random() * (width - 100) + 50);
                const y = Math.floor(Math.random() * (height - 100) + 50);
                await this.page.mouse.move(x, y, { steps: 5 + Math.floor(Math.random() * 10) });
                await this.page.waitForTimeout(200 + Math.random() * 500);
            }
            // Random scroll
            await this.page.mouse.wheel(0, Math.floor(Math.random() * 100 + 50));
            await this.page.waitForTimeout(500 + Math.random() * 1000);
        } catch { }
    }

    // --- City Coordinate Map (Indonesian Cities) ---
    private cityCoordinates: Record<string, { lat: number; lon: number }> = {
        'tulungagung': { lat: -8.0654, lon: 111.9024 },
        'kediri': { lat: -7.8160, lon: 112.0114 },
        'blitar': { lat: -8.0985, lon: 112.1607 },
        'malang': { lat: -7.9789, lon: 112.6302 },
        'surabaya': { lat: -7.2575, lon: 112.7521 },
        'jakarta': { lat: -6.2088, lon: 106.8456 },
        'bandung': { lat: -6.9175, lon: 107.6191 },
        'semarang': { lat: -6.9932, lon: 110.4203 },
        'yogyakarta': { lat: -7.7956, lon: 110.3695 },
        'solo': { lat: -7.5755, lon: 110.8243 },
        'denpasar': { lat: -8.6500, lon: 115.2167 },
        'makassar': { lat: -5.1350, lon: 119.4124 },
        'medan': { lat: 3.5952, lon: 98.6722 },
        'palembang': { lat: -2.9761, lon: 104.7754 },
        'bekasi': { lat: -6.2383, lon: 106.9756 },
        'tangerang': { lat: -6.1781, lon: 106.6319 },
        'depok': { lat: -6.4025, lon: 106.7942 },
        'bogor': { lat: -6.5971, lon: 106.8060 },
        'trenggalek': { lat: -8.0500, lon: 111.7167 },
        'nganjuk': { lat: -7.6000, lon: 111.9000 },
        'ponorogo': { lat: -7.8683, lon: 111.4624 },
        'madiun': { lat: -7.6298, lon: 111.5230 },
        'jombang': { lat: -7.5455, lon: 112.2325 },
        'mojokerto': { lat: -7.4706, lon: 112.4340 },
        'sidoarjo': { lat: -7.4478, lon: 112.7183 },
        'gresik': { lat: -7.1625, lon: 112.6514 },
        'lamongan': { lat: -7.1167, lon: 112.4167 },
        'tuban': { lat: -6.8986, lon: 112.0500 },
        'pacitan': { lat: -8.1939, lon: 111.1000 },
    };

    private resolveCoordinates(city: string): { lat: number; lon: number } | null {
        const key = city.toLowerCase().trim();
        return this.cityCoordinates[key] || null;
    }

    // Haversine formula to calculate distance between two points in km
    private calculateDistance(lat1: number, lon1: number, lat2: number, lon2: number): number {
        const R = 6371; // Radius of the earth in km
        const dLat = this.deg2rad(lat2 - lat1);
        const dLon = this.deg2rad(lon2 - lon1);
        const a =
            Math.sin(dLat / 2) * Math.sin(dLat / 2) +
            Math.cos(this.deg2rad(lat1)) * Math.cos(this.deg2rad(lat2)) *
            Math.sin(dLon / 2) * Math.sin(dLon / 2);
        const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
        const d = R * c; // Distance in km
        return d;
    }

    private deg2rad(deg: number): number {
        return deg * (Math.PI / 180);
    }

    async setLocation(city: string, radius: number = 1) {
        if (!this.page) throw new Error('Browser not started');
        this.log(`\n========================================`);
        this.log(`📍 [LOCATION] Setting location to: ${city} (radius: ${radius}km)`);
        this.log(`========================================`);

        // Step 1: Update browser geolocation to match the target city
        const coords = this.resolveCoordinates(city);
        if (coords) {
            this.log(`📍 [GEO] Found coordinates for "${city}": lat=${coords.lat}, lon=${coords.lon}`);
            await this.browserService.setGeolocation(coords.lat, coords.lon);
        } else {
            this.log(`⚠️ [GEO] City "${city}" not in coordinate map. Using default (Tulungagung).`);
            this.log(`💡 [TIP] Add "${city.toLowerCase()}" to cityCoordinates in FacebookService.ts`);
            await this.browserService.setGeolocation(-8.0654, 111.9024); // Default Tulungagung
        }

        // Step 2: Use UI Interaction to force location change (More robust than URL)
        this.log(`🌐 [NAV] Navigating to Marketplace root...`);
        try {
            await this.page.waitForTimeout(2000); // Stabilize
            try {
                // use 'commit' to avoid heavy load crash, then wait for selector
                await this.page.goto('https://www.facebook.com/marketplace/', { timeout: 60000, waitUntil: 'commit' });
                await this.page.waitForTimeout(5000); // Allow manual load time
            } catch (navError: any) {
                this.log(`⚠️ [NAV] Navigation warning: ${navError.message}`);
                // Verify we are at least on marketplace
                if (this.page.url().includes('marketplace')) {
                    this.log(`✅ [NAV] recovering: URL contains 'marketplace', proceeding...`);
                } else {
                    throw navError;
                }
            }

            const success = await this.setLocationUI(city, radius);
            if (!success) {
                throw new Error(`Failed to set location to ${city} via UI interaction.`);
            }

        } catch (e: any) {
            this.log(`⚠️ [NAV] Error during location setup: ${e.message}`);
            throw e; // Re-throw to indicate failure
        }

        this.log(`✅ [LOCATION] Location setup complete for: ${city}\n`);
    }

    private async setLocationUI(city: string, radius: number): Promise<boolean> {
        if (!this.page) return false;
        this.log(`🔧 [UI SETUP] specific location settings via UI for ${city}...`);

        try {
            // 0. Wait for Marketplace page to be ready
            await this.page.waitForTimeout(3000);

            // 1. Click the location filter button
            // The button shows current city + radius text like "Tulungagung · Dalam 1 kilometer"
            this.log('🔍 Looking for location button...');

            let clicked = false;

            // Strategy A: Find button with location-related text (km, kilometer, Dalam, Within)
            const allButtons = await this.page.getByRole('button').all();
            for (const btn of allButtons) {
                try {
                    const txt = await btn.innerText();
                    if (txt.includes('kilom') || txt.includes('km') || txt.includes('Dalam') || txt.includes('Within')) {
                        this.log(`📍 Found location button: "${txt.substring(0, 40).replace(/\n/g, ' ')}"`);
                        await btn.click();
                        clicked = true;
                        break;
                    }
                } catch (e) { }
            }

            if (!clicked) {
                this.log('❌ Could not find location button');
                return false;
            }

            // 2. Wait for the dialog to appear
            // KEY FIX: Don't rely on role="dialog" — Facebook may not use it.
            // Instead, wait for the INPUT FIELD that appears inside the dialog.
            this.log('⏳ Waiting for location input to appear...');

            let locationInput = null;
            const inputSelectors = [
                'input[aria-label="Lokasi"]',
                'input[aria-label="Location"]',
                'input[placeholder*="kota"]',
                'input[placeholder*="lingkungan"]',
                'input[placeholder*="kode pos"]',
                'input[placeholder*="city"]',
                'input[placeholder*="Search"]',
            ];

            // Try each selector with a short timeout
            for (const sel of inputSelectors) {
                try {
                    locationInput = await this.page.waitForSelector(sel, { timeout: 5000 });
                    if (locationInput) {
                        this.log(`✅ Dialog detected via: ${sel}`);
                        break;
                    }
                } catch { }
            }

            if (!locationInput) {
                this.log('❌ Location dialog input not found after click');
                // Dump for debug
                try {
                    const fs = require('fs');
                    await fs.promises.writeFile('fail_dump.html', await this.page.content());
                    this.log('⚠️ Dumped page to fail_dump.html');
                } catch (e) { }
                return false;
            }

            // 3. Clear existing text and type new city
            this.log(`⌨️ Typing city: ${city}`);
            await locationInput.click({ clickCount: 3 }); // Triple-click to select all
            await this.page.waitForTimeout(300);
            await this.page.keyboard.type(city, { delay: 80 });
            await this.page.waitForTimeout(2000); // Wait for suggestions

            // 4. Select the first suggestion from dropdown
            this.log('📋 Looking for suggestions...');
            let suggestionClicked = false;

            // Try listbox items first
            try {
                const suggestion = this.page.locator('ul[role="listbox"] li').first();
                if (await suggestion.isVisible({ timeout: 3000 })) {
                    await suggestion.click();
                    suggestionClicked = true;
                    this.log(`✅ Clicked first suggestion from listbox`);
                }
            } catch { }

            // Fallback: role="option"
            if (!suggestionClicked) {
                try {
                    const option = this.page.locator('[role="option"]').first();
                    if (await option.isVisible({ timeout: 2000 })) {
                        await option.click();
                        suggestionClicked = true;
                        this.log(`✅ Clicked first suggestion from option`);
                    }
                } catch { }
            }

            // Fallback: keyboard
            if (!suggestionClicked) {
                this.log('⌨️ Using keyboard to select suggestion...');
                await this.page.keyboard.press('ArrowDown');
                await this.page.waitForTimeout(300);
                await this.page.keyboard.press('Enter');
            }

            await this.page.waitForTimeout(1500);

            // 5. Radius — leave at 1km as user requested

            // 6. Click "Terapkan" (Apply) button
            this.log('🔘 Looking for Terapkan/Apply button...');
            let applyClicked = false;

            // Try by text content using page-level locators (not dialog.$)
            const applyTexts = ['Terapkan', 'Apply'];
            for (const text of applyTexts) {
                try {
                    const btn = this.page.getByRole('button', { name: text }).first();
                    if (await btn.isVisible({ timeout: 2000 })) {
                        this.log(`✅ Clicking: "${text}"`);
                        await btn.click();
                        applyClicked = true;
                        break;
                    }
                } catch { }
            }

            // Fallback: find span with "Terapkan" text and click its parent
            if (!applyClicked) {
                try {
                    const terapkan = this.page.locator('span:has-text("Terapkan")').first();
                    if (await terapkan.isVisible({ timeout: 2000 })) {
                        this.log('✅ Clicking Terapkan via span');
                        await terapkan.click();
                        applyClicked = true;
                    }
                } catch { }
            }

            if (!applyClicked) {
                this.log('⚠️ Could not find Apply/Terapkan button');
            }

            await this.page.waitForTimeout(3000); // Wait for page to reload with new location
            this.log(`✅ Location set to ${city} (radius ${radius}km)`);
            return true;

        } catch (e: any) {
            this.log(`❌ UI Location Set Failed: ${e.message}`);
            return false;
        }
    }

    /**
     * Open Facebook (non-Marketplace) search results for a keyword.
     */
    async searchFacebook(keyword: string): Promise<void> {
        if (!this.page) throw new Error('Browser not started');
        const searchUrl = `https://www.facebook.com/search/posts?q=${encodeURIComponent(keyword)}`;
        this.log(`🔵 [FB SEARCH] Opening Facebook search: "${keyword}"`);
        try {
            await this.page.goto(searchUrl, { timeout: 30000, waitUntil: 'domcontentloaded' });
            await this.page.waitForTimeout(2000);
            this.log(`✅ [FB SEARCH] Results page opened for: "${keyword}"`);
        } catch (e: any) {
            this.log(`⚠️ [FB SEARCH] Error: ${e.message}`);
        }
    }

    async searchAndBoost(keyword: string, captionKeyword: string, boostCount: number = 10, fbKeyword?: string, searchOrder: 'keyword_first' | 'fb_first' = 'keyword_first') {
        if (!this.page) throw new Error('Browser not started');
        this.log(`🔍 [SEARCH] keyword: "${keyword}" | caption: "${captionKeyword}"${fbKeyword ? ` | FB: "${fbKeyword}" (${searchOrder})` : ''}`);

        // --- Facebook Search (if requested, before marketplace) ---
        if (fbKeyword && searchOrder === 'fb_first') {
            await this.searchFacebook(fbKeyword);
        }

        // --- Marketplace Search ---
        const searchUrl = `https://www.facebook.com/marketplace/search?query=${encodeURIComponent(keyword)}`;
        await this.page.goto(searchUrl);

        try {
            await this.page.waitForSelector('div[class*="x1lliihq"]', { timeout: 10000 });
        } catch (e) {
            this.log('⚠️ No results found for this keyword.');
            return;
        }

        this.log(`📊 Scanning results... looking for caption: "${captionKeyword}"`);

        // 1. Collect Links Strictly Ordered
        const uniqueLinks = new Set<string>();
        const orderedLinks: string[] = []; // Keep strict order
        const maxScrolls = 3;

        for (let i = 0; i < maxScrolls; i++) {
            const items = await this.page.$$('a[href*="/marketplace/item/"]');
            for (const item of items) {
                const href = await item.getAttribute('href');
                if (href && !uniqueLinks.has(href)) {
                    uniqueLinks.add(href);
                    orderedLinks.push(href); // Add to ordered list
                }
            }
            await this.page.mouse.wheel(0, 500);
            await this.page.waitForTimeout(1000);
        }

        console.log(`Found ${orderedLinks.length} candidates. Processing strictly sequentially...`);
        let matchesFound = 0;

        // 2. Process Sequentially
        for (let i = 0; i < orderedLinks.length; i++) {
            const link = orderedLinks[i];
            const fullUrl = link.startsWith('http') ? link : `https://www.facebook.com${link}`;
            console.log(`\n--- Processing Item ${i + 1}/${orderedLinks.length} ---`);

            try {
                await this.page.goto(fullUrl, { waitUntil: 'domcontentloaded' });
                await this.page.waitForTimeout(2000);

                // Validation: Check URL
                if (!this.page.url().includes('/marketplace/item/')) {
                    console.log(`⚠️ Navigation failed/redirected. Skipping.`);
                    continue;
                }

                // 3. Robust Data Extraction
                // Strategy: Find h1 that is NOT inside a navigation/dialog
                let title = '';
                try {
                    // Try standard Marketplace H1
                    title = await this.page.$eval('div:not([role="navigation"]) > h1', (el: any) => el.innerText).catch(() => '');

                    // Fallback: Try looking for the main product container
                    if (!title || title.includes('Belum dibaca') || title.includes('Obrolan')) {
                        // Search closer to the price span
                        const priceEl = await this.page.$('span.x193iq5w.xeuugli.x13faqbe.x1vvkbs.x1xmvt09.x1lliihq.x1s928wv.xhkezso.x1gmr53x.x1cpjm7i.x1fgarty.x1943h6x.xudqn12.x3x7a5m.x6prxxf.xvq8zen.xo1l8bm.xzsf02u');
                        if (priceEl) {
                            // Title is usually a sibling or close parent's sibling. 
                            // Let's try to get the document title as a fallback if in-page selectors fail
                            title = await this.page.title();
                        }
                    }
                } catch (e) { title = 'Unknown Title'; }

                // Clean the title: strip Facebook page-title prefix like "(6) Marketplace - "
                let cleanTitle = title.replace(/\n/g, ' ').replace(' | Facebook', '').trim();
                cleanTitle = cleanTitle.replace(/^\(\d+\)\s*/, ''); // Remove leading "(N) " notification count
                cleanTitle = cleanTitle.replace(/^Marketplace\s*-\s*/, ''); // Remove "Marketplace - " prefix
                cleanTitle = cleanTitle.trim();

                // Sanity Check: If title is PURELY UI text (no product info), SKIP
                // Only skip when the entire cleaned title is a UI-only string, not when it contains a real product name
                const uiOnlyTitles = ['Belum dibaca', 'Obrolan', 'Marketplace', 'Facebook', 'Unknown Title'];
                const isUiOnlyTitle = uiOnlyTitles.some(ui => cleanTitle === ui) || cleanTitle.length < 3;
                if (isUiOnlyTitle) {
                    console.log(`⚠️ Invalid Title detected ("${cleanTitle}"). Skipping item (likely UI glitch).`);
                    continue;
                }

                this.log(`Checking: "${cleanTitle.substring(0, 60)}..."`);

                // Normalize caption for matching (remove whitespace for flexible matching)
                const captionNorm = captionKeyword.replace(/\s+/g, '').toLowerCase();

                // 3.5: Quick Check — caption keyword in title?
                if (cleanTitle.replace(/\s+/g, '').toLowerCase().includes(captionNorm)) {
                    this.log(`✅ MATCH (Caption in Title): ${cleanTitle}`);
                    await this.performBoostCycle(fullUrl, boostCount);
                    matchesFound++;
                    continue;
                }

                // 4. Text Check — caption keyword in product detail area ONLY
                // CRITICAL: Do NOT check full body — it includes "Produk serupa" / recommendations
                // which can contain the caption keyword from OTHER listings (false positive)
                let productDetailText = '';

                // Strategy A: Try to extract product description text specifically
                const descriptionSelectors = [
                    'div[data-testid="marketplace_listing_title"]',
                    'div.x1a2a7pz',  // Common FB description container
                    'span.x193iq5w', // Price/detail spans
                ];
                for (const sel of descriptionSelectors) {
                    try {
                        const texts = await this.page.$$eval(sel, (els: any[]) => els.map((e: any) => e.innerText).join(' '));
                        if (texts) productDetailText += ' ' + texts;
                    } catch { }
                }

                // Strategy B: Get full body text but CUT OFF at recommendation section
                // This catches anything not covered by specific selectors
                if (!productDetailText.trim()) {
                    const fullText = await this.page.$eval('body', (el: any) => el.innerText).catch(() => '');
                    // Cut at first occurrence of recommendation markers
                    const cutMarkers = [
                        'Produk serupa', 'Produk rekomendasi', 'Similar items',
                        'Related items', 'Anda mungkin juga suka', 'You may also like',
                        'Listing serupa', 'Produk terkait', 'Lihat lainnya di',
                    ];
                    let cutIndex = fullText.length;
                    for (const marker of cutMarkers) {
                        const idx = fullText.indexOf(marker);
                        if (idx !== -1 && idx < cutIndex) {
                            cutIndex = idx;
                        }
                    }
                    productDetailText = fullText.substring(0, cutIndex);
                    if (cutIndex < fullText.length) {
                        this.log(`✂️ Text truncated at "${fullText.substring(cutIndex, cutIndex + 30)}..." (excluding recommendations)`);
                    }
                }

                const cleanProductText = productDetailText.replace(/\s+/g, '').toLowerCase();

                if (cleanProductText.includes(captionNorm)) {
                    this.log(`✅ MATCH (Caption in Product Detail): ${cleanTitle}`);
                    await this.performBoostCycle(fullUrl, boostCount);
                    matchesFound++;
                    continue;
                }

                // 5. Image Check (OCR)
                // Use element screenshot instead of downloading URL (avoids CDN auth issues)
                const images = await this.page.$$('img[src*="scontent"]');
                let targetImg: any = null;

                if (images) {
                    for (const img of images) {
                        const size = await img.boundingBox();
                        if (size && size.width > 200 && size.height > 200) {
                            console.log(`[Image Filter] Found suitable image: ${Math.floor(size.width)}x${Math.floor(size.height)}`);
                            targetImg = img;
                            break;
                        }
                    }
                }

                if (targetImg) {
                    try {
                        // Screenshot the img element directly — captures authenticated content
                        const screenshotBuffer = await targetImg.screenshot({ type: 'png' });
                        console.log(`[OCR] Captured screenshot: ${(screenshotBuffer.length / 1024).toFixed(0)}KB`);
                        const isMatch = await this.imageAnalysisService.analyzeImage(screenshotBuffer);

                        if (isMatch) {
                            console.log(`✅ MATCH FOUND (OCR): ${cleanTitle}`);
                            await this.performBoostCycle(fullUrl, boostCount);
                            matchesFound++;
                            continue;
                        }
                    } catch (err: any) {
                        console.log(`⚠️ Screenshot/OCR error: ${err.message}`);
                    }
                } else {
                    console.log(`⚠️ No suitable product image found.`);
                }

                console.log(`❌ No match found.`);

            } catch (e: any) {
                console.log(`⚠️ Error processing item: ${e.message}`);
            }
        }
        this.log(`📊 Scan complete. Boosted ${matchesFound} items.`);

        // --- Facebook Search (if requested, after marketplace) ---
        if (fbKeyword && searchOrder === 'keyword_first') {
            await this.searchFacebook(fbKeyword);
        }
    }



    async scrapeProducts(city: string, radius: number) {
        console.log(`Starting Scraping for ${city} within ${radius}km (Filtering for 'Raffa Computer')...`);

        // 2. Scroll and Collect URLs
        const uniqueLinks = new Set<string>();
        const maxScrolls = 5;

        for (let i = 0; i < maxScrolls; i++) {
            const items = await this.page?.$$('a[href*="/marketplace/item/"]');
            if (items) {
                for (const item of items) {
                    const href = await item.getAttribute('href');
                    if (href) uniqueLinks.add(href);
                }
            }
            await this.page?.mouse.wheel(0, 800);
            await this.page?.waitForTimeout(2000);
        }

        console.log(`Found ${uniqueLinks.size} unique items. Analyzing images and details...`);

        // 3. Prepare CSV Writer (Filtered Data)
        const csvWriter = createObjectCsvWriter({
            path: `clean_data_raffa_${city}_${Date.now()}.csv`,
            header: [
                { id: 'title', title: 'TITLE' },
                { id: 'price', title: 'PRICE' },
                { id: 'location', title: 'LOCATION' },
                { id: 'seller', title: 'SELLER' },
                { id: 'description', title: 'DESCRIPTION' },
                { id: 'url', title: 'URL' },
                { id: 'imageUrl', title: 'IMAGE_URL' },
                { id: 'logoDetected', title: 'LOGO_DETECTED' }
            ]
        });

        const records: any[] = [];

        // 4. Visit each Link
        for (const link of uniqueLinks) {
            const fullUrl = link.startsWith('http') ? link : `https://www.facebook.com${link}`;
            try {
                await this.page?.goto(fullUrl);
                await this.page?.waitForTimeout(2000);

                // Extract Image URL first for Analysis
                const imgElement = await this.page?.$('img[src*="scontent"]');
                const imageUrl = await imgElement?.getAttribute('src');

                let isRaffa = false;
                if (imageUrl) {
                    try {
                        console.log(`[Scrape] Downloading image: ${imageUrl.substring(0, 30)}...`);
                        const response = await this.page?.request.get(imageUrl);
                        if (response && response.status() === 200) {
                            const buffer = await response.body();
                            isRaffa = await this.imageAnalysisService.analyzeImage(buffer);
                        } else {
                            console.log(`[Scrape] Failed to download image. Status: ${response?.status()}`);
                        }
                    } catch (err) {
                        console.log(`[Scrape] Error downloading image: ${err}`);
                    }
                }

                if (isRaffa) {
                    // Extract Details only if it's a match
                    const title = await this.page?.$eval('h1', (el: any) => el.innerText).catch(() => 'N/A');
                    const price = await this.page?.$eval('span.x193iq5w.xeuugli.x13faqbe.x1vvkbs.x1xmvt09.x1lliihq.x1s928wv.xhkezso.x1gmr53x.x1cpjm7i.x1fgarty.x1943h6x.xudqn12.x3x7a5m.x6prxxf.xvq8zen.xo1l8bm.xzsf02u', (el: any) => el.innerText).catch(() => 'N/A');
                    const description = await this.page?.$eval('div.x1a2a7pz', (el: any) => el.innerText).catch(() => 'N/A');
                    const seller = await this.page?.$eval('a[href*="/marketplace/profile/"]', (el: any) => el.innerText).catch(() => 'N/A');

                    console.log(`✅ MATCH: ${title} - ${price}`);

                    records.push({
                        title,
                        price,
                        location: city,
                        seller,
                        description: description?.substring(0, 100) + '...',
                        url: fullUrl,
                        imageUrl: imageUrl || 'N/A',
                        logoDetected: 'YES'
                    });
                } else {
                    console.log(`❌ SKIP: No 'Raffa' logo detected.`);
                }

            } catch (e: any) {
                console.log(`Failed to process ${fullUrl}: ${e.message}`);
            }
        }

        // 5. Write to CSV
        if (records.length > 0) {
            await csvWriter.writeRecords(records);
            console.log(`✅ Scraping Complete. ${records.length} clean records saved.`);
        } else {
            console.log('⚠️ No matching records found.');
        }
    }

    async performBoostCycle(url: string, count: number = 5) {
        if (!this.page) return;
        console.log(`🚀 [BOOST START] Target: ${url}`);
        console.log(`🔄 Performing ${count} "Close-Click" cycles to boost views...`);

        // Get the current search URL to return to, or default to marketplace
        const returnUrl = 'https://www.facebook.com/marketplace';

        for (let i = 1; i <= count; i++) {
            console.log(`\n--- 🔄 Cycle ${i}/${count} ---`);
            try {
                // 1. "Click" (Open the item)
                console.log(`👉 Opening Item...`);
                await this.page.goto(url, { waitUntil: 'domcontentloaded' });

                // 2. Simulate "Viewing" (Random wait 3-6s)
                const viewTime = 3000 + Math.random() * 3000;
                console.log(`👀 Viewing for ${(viewTime / 1000).toFixed(1)}s...`);

                // Scrolldown slightly to simulate read
                await this.page.mouse.wheel(0, 300);
                await this.page.waitForTimeout(viewTime);

                // 3. "Close" (Navigate away/back)
                console.log(`🔙 Closing (Returning to feed)...`);
                await this.page.goto(returnUrl, { waitUntil: 'domcontentloaded' });

                // Random pause before next click (2-4s)
                await this.page.waitForTimeout(2000 + Math.random() * 2000);

            } catch (e: any) {
                console.log(`⚠️ Cycle ${i} interrupted: ${e.message}`);
            }
        }
        console.log(`✅ [BOOST COMPLETE] Finished ${count} cycles for this item.\n`);
    }

    async startDebugMode() {
        console.log('🐞 [DEBUG MODE] Force-Stopping any previous instances...');
        await this.stop(); // Ensure clean slate

        console.log('🐞 [DEBUG MODE] Starting Spy Browser...');
        await this.browserService.launchBrowser(false); // Force Headed
        await this.browserService.createContext(); // Missing step!
        this.page = await this.browserService.createPage();

        if (!this.page) return;

        await this.page.goto('https://www.facebook.com', { waitUntil: 'domcontentloaded' });

        // Inject Spy Script
        await this.page.addInitScript(() => {
            document.addEventListener('click', (e: any) => {
                const target = e.target;

                // Helper to generate selector
                const getSelector = (el: any): string => {
                    if (!el || el.tagName === 'BODY') return 'body';

                    // 1. ID
                    if (el.id) return `#${el.id}`;

                    // 2. Aria Label
                    if (el.getAttribute('aria-label')) {
                        return `${el.tagName.toLowerCase()}[aria-label="${el.getAttribute('aria-label')}"]`;
                    }

                    // 3. Role + Text (approximation for logging)
                    if (el.getAttribute('role')) {
                        return `${el.tagName.toLowerCase()}[role="${el.getAttribute('role')}"]`;
                    }

                    // 4. Class (if unique-ish)
                    if (el.className && typeof el.className === 'string' && el.className.trim() !== '') {
                        const classes = el.className.split(' ').filter((c: any) => !c.startsWith('x')).join('.');
                        if (classes.length > 0) return `${el.tagName.toLowerCase()}.${classes}`;
                    }

                    return el.tagName.toLowerCase();
                };

                const selector = getSelector(target);
                const text = target.innerText ? target.innerText.substring(0, 20) : '';

                // Log to console which will be picked up by Playwright's console event
                console.log(`[SPY] Clicked: ${selector} | Text: "${text}"`);

            }, true); // Capture phase
        });

        // Listen to console logs from the page
        this.page.on('console', msg => {
            if (msg.type() === 'log') {
                // Pass through all logs that look like ours
                if (msg.text().startsWith('[SPY]')) {
                    this.log(`🐞 ${msg.text()}`);
                }
            }
        });

        this.log('🐞 [DEBUG MODE] Ready. Interacting with the browser will log selectors here.');
    }

    async stop() {
        await this.browserService.close();
    }
}

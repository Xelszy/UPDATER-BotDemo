
import { app, BrowserWindow, ipcMain } from 'electron';
import * as path from 'path';
import { FacebookService } from './services/FacebookService';
import { UpdateService } from './services/UpdateService';

let mainWindow: BrowserWindow | null = null;
const fbService = new FacebookService();
const updateService = new UpdateService();

// Connect Service Logs to Renderer
fbService.setLogger((msg: string) => {
    logToRenderer(msg);
});
console.log('--- 🚀 LATEST BUILD LOADED (Multi-Akun + FB Search + Multi-Lokasi) ---');

function createWindow() {
    mainWindow = new BrowserWindow({
        width: 960,
        height: 750,
        webPreferences: {
            nodeIntegration: false,
            contextIsolation: true,
            preload: path.join(__dirname, 'preload.js'),
        },
    });

    mainWindow.loadFile(path.join(__dirname, '../../index.html'));
    mainWindow.webContents.openDevTools();
}

app.whenReady().then(() => {
    createWindow();
    app.on('activate', function () {
        if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
});

app.on('window-all-closed', function () {
    if (process.platform !== 'darwin') app.quit();
});

// --- IPC Handlers ---

ipcMain.on('login-manual', async (event) => {
    logToRenderer('Starting manual login process...');
    try {
        const success = await fbService.loginManual();
        if (success) {
            logToRenderer('✅ Manual Login Saved!');
            updateStatus('Ready (Session Saved)');
        } else {
            logToRenderer('❌ Manual Login Failed/Cancelled');
            updateStatus('Idle (Login Failed)');
        }
    } catch (e: any) {
        logToRenderer(`Error: ${e.message}`);
    }
});

ipcMain.on('login-cookies', async (event, data) => {
    const cookieString = data?.cookies || '';
    logToRenderer('🍪 Starting cookie-based login...');
    updateStatus('Cookie Login...');
    try {
        const success = await fbService.loginWithCookies(cookieString);
        if (success) {
            logToRenderer('✅ Cookie Login berhasil!');
            updateStatus('Ready (Cookie Session Active)');
        } else {
            logToRenderer('❌ Cookie Login gagal.');
            updateStatus('Idle (Cookie Login Failed)');
        }
    } catch (e: any) {
        logToRenderer(`❌ Cookie Login Error: ${e.message}`);
        updateStatus('Idle (Error)');
    }
});

ipcMain.on('start-boost', async (event, config) => {
    const { cities: rawCities, radius, keyword, captionKeyword, boostCount: rawBoost, fbKeyword, searchOrder, skipFailedLogin } = config;
    const boostCount = Math.min(Math.max(Number(rawBoost) || 10, 1), 100);
    const cities: string[] = Array.isArray(rawCities) ? rawCities : [rawCities];

    logToRenderer(`🚀 [BOOST] Search: "${keyword}" | Caption: "${captionKeyword}" @ [${cities.join(', ')}] (${boostCount} cycles)`);
    updateStatus('Running Boost Campaign...');

    try {
        await fbService.start('default', false);

        if (!await fbService.checkLoginStatus()) {
            logToRenderer('⚠️ Session invalid. Attempting login...');
            await fbService.loginManual();
        }

        for (const city of cities) {
            logToRenderer(`\n📍 === Switching to city: ${city} ===`);
            await fbService.setLocation(city, radius);
            logToRenderer(`🔍 Searching: "${keyword}" → caption: "${captionKeyword}"`);
            await fbService.searchAndBoost(keyword, captionKeyword, boostCount, fbKeyword, searchOrder);
        }

        logToRenderer('✅ Campaign Cycle Complete.');
        updateStatus('Idle (Last run complete)');
    } catch (e: any) {
        logToRenderer(`❌ Error in campaign: ${e.message}`);
        updateStatus('Error');
    }
});

ipcMain.on('start-debug', async (event) => {
    logToRenderer('🐞 [DEBUG MODE] Starting Spy Browser...');
    updateStatus('Debug Mode Active');
    try {
        await fbService.startDebugMode();
    } catch (e: any) {
        logToRenderer(`❌ Debug Mode Error: ${e.message}`);
    }
});

ipcMain.on('start-scrape', async (event, config) => {
    const { cities: rawCities, radius } = config;
    const cities: string[] = Array.isArray(rawCities) ? rawCities : [rawCities];
    logToRenderer(`📊 [SCRAPE] Starting Scrape: [${cities.join(', ')}] (${radius}km)`);
    updateStatus('Scraping Products...');

    try {
        await fbService.start('default', false);
        if (!await fbService.checkLoginStatus()) {
            await fbService.loginManual();
        }
        for (const city of cities) {
            await fbService.setLocation(city, radius);
            await fbService.scrapeProducts(city, radius);
        }
        logToRenderer('✅ Scraping Complete.');
        updateStatus('Idle (Scraping Done)');
    } catch (e: any) {
        logToRenderer(`❌ Scraping Error: ${e.message}`);
        updateStatus('Error');
    }
});

// -------------------------------------------------------
// Multi-Akun CSV Campaign Handler
// -------------------------------------------------------
ipcMain.on('run-csv-campaign', async (event, config) => {
    const {
        accounts,          // [{ email, password }]
        cities,            // string[]
        radius,
        keyword,
        captionKeyword,
        boostCount: rawBoost,
        fbKeyword,
        searchOrder,
        concurrentLimit: rawLimit,
        skipFailedLogin: rawSkipFailed,
    } = config;

    const boostCount = Math.min(Math.max(Number(rawBoost) || 10, 1), 100);
    const concurrentLimit = Math.min(Math.max(Number(rawLimit) || 2, 1), 10);
    const skipFailedLogin = rawSkipFailed !== false; // default true
    const total = accounts.length;

    logToRenderer(`\n🚀 [CSV CAMPAIGN] ${total} akun | ${concurrentLimit} bersamaan | Search: "${keyword}" | Caption: "${captionKeyword}" | Lokasi: [${cities.join(', ')}]`);
    updateStatus(`Running CSV Campaign (0/${total})...`);

    // Queue-based concurrency
    let idx = 0;
    let doneCount = 0;

    const runAccount = async (acc: { email: string; password: string }) => {
        sendAccountStatus(acc.email, 'running');
        logToRenderer(`\n👤 [${acc.email}] Memulai campaign...`);

        // Each account gets its own FacebookService instance
        const svc = new FacebookService();
        svc.setLogger((msg: string) => logToRenderer(`[${acc.email.split('@')[0]}] ${msg}`));

        try {
            // Launch dedicated browser for this account (skipAutoLogin=true, we'll use loginWithCredentials)
            await svc.start(`account_${acc.email.replace(/[^a-z0-9]/gi, '_')}`, false, true);
            const loggedIn = await svc.loginWithCredentials(acc.email, acc.password, skipFailedLogin);

            if (!loggedIn) {
                logToRenderer(`❌ [${acc.email}] Login gagal. Skip.`);
                sendAccountStatus(acc.email, 'error', 'Login gagal');
                return;
            }

            for (const city of cities) {
                logToRenderer(`📍 [${acc.email}] → Kota: ${city}`);
                await svc.setLocation(city, radius);
                await svc.searchAndBoost(keyword, captionKeyword, boostCount, fbKeyword, searchOrder);
            }

            logToRenderer(`✅ [${acc.email}] Selesai!`);
            sendAccountStatus(acc.email, 'done');
        } catch (e: any) {
            logToRenderer(`❌ [${acc.email}] Error: ${e.message}`);
            sendAccountStatus(acc.email, 'error', e.message);
        } finally {
            await svc.stop();
            doneCount++;
            updateStatus(`CSV Campaign: ${doneCount}/${total} akun selesai`);
        }
    };

    // Worker function: picks next account from queue
    const worker = async () => {
        while (idx < accounts.length) {
            const current = accounts[idx++];
            await runAccount(current);
        }
    };

    // Spawn `concurrentLimit` workers
    const workers: Promise<void>[] = [];
    for (let w = 0; w < concurrentLimit; w++) {
        workers.push(worker());
    }

    await Promise.all(workers);

    logToRenderer(`\n🏁 [CSV CAMPAIGN] Semua ${total} akun selesai diproses.`);
    updateStatus(`CSV Campaign selesai (${total} akun).`);
    if (mainWindow) mainWindow.webContents.send('campaign-done');
});

// -------------------------------------------------------
// Multi-Akun Cookie Campaign Handler
// -------------------------------------------------------
ipcMain.on('run-cookie-campaign', async (event, config) => {
    const {
        cookieAccounts,    // string[] — each element is a cookie string for one account
        cities,            // string[]
        radius,
        keyword,
        captionKeyword,
        boostCount: rawBoost,
        fbKeyword,
        searchOrder,
        concurrentLimit: rawLimit,
    } = config;

    const boostCount = Math.min(Math.max(Number(rawBoost) || 10, 1), 100);
    const concurrentLimit = Math.min(Math.max(Number(rawLimit) || 2, 1), 10);
    const total = cookieAccounts.length;

    logToRenderer(`\n🍪 [COOKIE CAMPAIGN] ${total} akun | ${concurrentLimit} bersamaan | Search: "${keyword}" | Caption: "${captionKeyword}" | Lokasi: [${cities.join(', ')}]`);
    updateStatus(`Running Cookie Campaign (0/${total})...`);

    let idx = 0;
    let doneCount = 0;

    // Extract c_user from cookie string for display purposes
    const extractCUser = (cookieStr: string): string => {
        const match = cookieStr.match(/c_user[=:]?\s*(\d+)/);
        return match ? match[1] : `cookie_${Math.random().toString(36).substring(2, 8)}`;
    };

    const runCookieAccount = async (cookieStr: string) => {
        const cUserId = extractCUser(cookieStr);
        const label = `cookie_${cUserId}`;
        sendAccountStatus(label, 'running');
        logToRenderer(`\n🍪 [${label}] Memulai campaign...`);

        const svc = new FacebookService();
        svc.setLogger((msg: string) => logToRenderer(`[${cUserId}] ${msg}`));

        try {
            // Launch browser with isolated profile
            await svc.start(label, false, true);
            const loggedIn = await svc.loginWithCookiesForCampaign(cookieStr);

            if (!loggedIn) {
                logToRenderer(`❌ [${label}] Cookie login gagal. Skip.`);
                sendAccountStatus(label, 'error', 'Cookie login gagal');
                return;
            }

            for (const city of cities) {
                logToRenderer(`📍 [${label}] → Kota: ${city}`);
                await svc.setLocation(city, radius);
                await svc.searchAndBoost(keyword, captionKeyword, boostCount, fbKeyword, searchOrder);
            }

            logToRenderer(`✅ [${label}] Selesai!`);
            sendAccountStatus(label, 'done');
        } catch (e: any) {
            logToRenderer(`❌ [${label}] Error: ${e.message}`);
            sendAccountStatus(label, 'error', e.message);
        } finally {
            await svc.stop();
            doneCount++;
            updateStatus(`Cookie Campaign: ${doneCount}/${total} akun selesai`);
        }
    };

    const worker = async () => {
        while (idx < cookieAccounts.length) {
            const current = cookieAccounts[idx++];
            await runCookieAccount(current);
        }
    };

    const workers: Promise<void>[] = [];
    for (let w = 0; w < concurrentLimit; w++) {
        workers.push(worker());
    }

    await Promise.all(workers);

    logToRenderer(`\n🏁 [COOKIE CAMPAIGN] Semua ${total} akun selesai diproses.`);
    updateStatus(`Cookie Campaign selesai (${total} akun).`);
    if (mainWindow) mainWindow.webContents.send('campaign-done');
});

// -------------------------------------------------------
// Update / Version Handlers
// -------------------------------------------------------
ipcMain.handle('get-version', () => {
    return updateService.getCurrentVersion();
});

ipcMain.on('check-update', async () => {
    updateService.setLogger((msg: string) => logToRenderer(msg));
    try {
        const info = await updateService.checkForUpdate();
        if (mainWindow) mainWindow.webContents.send('update-status', { type: 'check-result', ...info });
    } catch (e: any) {
        if (mainWindow) mainWindow.webContents.send('update-status', { type: 'error', message: e.message });
    }
});

ipcMain.on('run-update', async (event, data) => {
    updateService.setLogger((msg: string) => logToRenderer(msg));
    const downloadUrl = data?.downloadUrl;
    if (!downloadUrl) {
        logToRenderer('❌ [UPDATE] No download URL.');
        return;
    }
    try {
        if (mainWindow) mainWindow.webContents.send('update-status', { type: 'downloading' });
        const success = await updateService.downloadAndInstall(downloadUrl);
        if (success) {
            if (mainWindow) mainWindow.webContents.send('update-status', { type: 'done' });
            logToRenderer('✅ [UPDATE] Update selesai! Restart aplikasi untuk menerapkan.');
        } else {
            if (mainWindow) mainWindow.webContents.send('update-status', { type: 'error', message: 'Download failed' });
        }
    } catch (e: any) {
        logToRenderer(`❌ [UPDATE] Error: ${e.message}`);
        if (mainWindow) mainWindow.webContents.send('update-status', { type: 'error', message: e.message });
    }
});

ipcMain.on('relaunch-app', () => {
    app.relaunch();
    app.quit();
});

// --- Helpers ---
function logToRenderer(msg: string) {
    console.log(msg);
    if (mainWindow) {
        mainWindow.webContents.send('log-message', `[${new Date().toLocaleTimeString()}] ${msg}`);
    }
}

function updateStatus(status: string) {
    if (mainWindow) {
        mainWindow.webContents.send('status-update', status);
    }
}

function sendAccountStatus(email: string, status: 'pending' | 'running' | 'done' | 'error', text?: string) {
    if (mainWindow) {
        mainWindow.webContents.send('account-status', { email, status, text });
    }
}

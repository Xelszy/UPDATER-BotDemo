import { chromium, Browser, BrowserContext, Page } from 'playwright';
import path from 'path';
import fs from 'fs-extra';
import { app } from 'electron';

// --- Stealth: Random User Agents Pool ---
const USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:133.0) Gecko/20100101 Firefox/133.0',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:132.0) Gecko/20100101 Firefox/132.0',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:133.0) Gecko/20100101 Firefox/133.0',
];

const VIEWPORTS = [
  { width: 1920, height: 1080 },
  { width: 1366, height: 768 },
  { width: 1440, height: 900 },
  { width: 1536, height: 864 },
  { width: 1280, height: 800 },
  { width: 1600, height: 900 },
];

const TIMEZONES = ['Asia/Jakarta', 'Asia/Makassar', 'Asia/Jayapura'];

function randomFrom<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

// --- Comprehensive stealth init script ---
const STEALTH_SCRIPT = `
  // 1. Remove webdriver flag
  Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  delete (navigator as any).__proto__.webdriver;

  // 2. Override navigator.plugins (Chrome normally has plugins)
  Object.defineProperty(navigator, 'plugins', {
    get: () => {
      const plugins = [
        { name: 'Chrome PDF Plugin', filename: 'internal-pdf-viewer', description: 'Portable Document Format' },
        { name: 'Chrome PDF Viewer', filename: 'mhjfbmdgcfjbbpaeojofohoefgiehjai', description: '' },
        { name: 'Native Client', filename: 'internal-nacl-plugin', description: '' },
      ];
      const arr: any = plugins;
      arr.length = plugins.length;
      arr.item = (i: number) => plugins[i];
      arr.namedItem = (name: string) => plugins.find(p => p.name === name) || null;
      arr.refresh = () => {};
      return arr;
    },
  });

  // 3. Override navigator.languages
  Object.defineProperty(navigator, 'languages', { get: () => ['id-ID', 'id', 'en-US', 'en'] });

  // 4. Override navigator.platform
  Object.defineProperty(navigator, 'platform', { get: () => 'Win32' });

  // 5. Override navigator.hardwareConcurrency
  Object.defineProperty(navigator, 'hardwareConcurrency', { get: () => Math.floor(Math.random() * 4 + 4) });

  // 6. Override navigator.deviceMemory
  Object.defineProperty(navigator, 'deviceMemory', { get: () => [4, 8, 16][Math.floor(Math.random() * 3)] });

  // 7. Chrome runtime mock (reCAPTCHA checks for this)
  if (!(window as any).chrome) {
    (window as any).chrome = {
      runtime: {
        onMessage: { addListener: () => {}, removeListener: () => {} },
        sendMessage: () => {},
        connect: () => ({ onMessage: { addListener: () => {} }, postMessage: () => {} }),
      },
      loadTimes: () => ({
        requestTime: Date.now() / 1000 - Math.random() * 10,
        startLoadTime: Date.now() / 1000 - Math.random() * 5,
        commitLoadTime: Date.now() / 1000 - Math.random() * 2,
        finishDocumentLoadTime: Date.now() / 1000,
        finishLoadTime: Date.now() / 1000,
        firstPaintTime: Date.now() / 1000 - Math.random(),
        firstPaintAfterLoadTime: 0,
        navigationType: 'Other',
        wasFetchedViaSpdy: false,
        wasNpnNegotiated: true,
        npnNegotiatedProtocol: 'h2',
        wasAlternateProtocolAvailable: false,
        connectionInfo: 'h2',
      }),
      csi: () => ({
        startE: Date.now(),
        onloadT: Date.now() + Math.random() * 1000,
        pageT: Math.random() * 5000,
        tran: 15,
      }),
    };
  }

  // 8. Notification permission mock
  if (!('Notification' in window)) {
    (window as any).Notification = { permission: 'default' };
  }

  // 9. Override permissions query
  const originalQuery = window.navigator.permissions?.query?.bind(window.navigator.permissions);
  if (originalQuery) {
    (window.navigator.permissions as any).query = (parameters: any) => {
      if (parameters.name === 'notifications') {
        return Promise.resolve({ state: Notification.permission });
      }
      return originalQuery(parameters);
    };
  }

  // 10. Canvas fingerprint noise (subtle random noise)
  const origCanvas = HTMLCanvasElement.prototype.toDataURL;
  HTMLCanvasElement.prototype.toDataURL = function(type?: string, quality?: any) {
    const ctx = this.getContext('2d');
    if (ctx) {
      const imgData = ctx.getImageData(0, 0, Math.min(this.width, 2), Math.min(this.height, 2));
      imgData.data[0] = imgData.data[0] ^ (Math.random() > 0.5 ? 1 : 0);
      ctx.putImageData(imgData, 0, 0);
    }
    return origCanvas.call(this, type, quality);
  };

  // 11. WebGL vendor/renderer spoofing
  const origGetParameter = WebGLRenderingContext.prototype.getParameter;
  WebGLRenderingContext.prototype.getParameter = function(param: number) {
    if (param === 37445) return 'Intel Inc.';
    if (param === 37446) return 'Intel Iris OpenGL Engine';
    return origGetParameter.call(this, param);
  };
`;

export class BrowserService {
  private browser: Browser | null = null;
  private context: BrowserContext | null = null;
  private page: Page | null = null;

  async launchBrowser(headless: boolean = false) {
    if (this.browser) return;

    this.browser = await chromium.launch({
      headless: headless,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-infobars',
        '--window-position=0,0',
        '--ignore-certificate-errors',
        '--ignore-certificate-errors-spki-list',
        '--disable-blink-features=AutomationControlled',
        '--dns-result-order=ipv4first',
        // Extra stealth args
        '--disable-features=IsolateOrigins,site-per-process',
        '--disable-site-isolation-trials',
        '--disable-web-security',
        '--disable-features=CrossSiteDocumentBlockingIfIsolating',
        '--flag-switches-begin',
        '--flag-switches-end',
      ]
    });

    this.browser.on('disconnected', () => {
      console.log('⚠️ [BrowserService] Browser disconnected (closed manually or crashed). Clearing instance.');
      this.browser = null;
      this.context = null;
      this.page = null;
    });
  }

  async createContext(profileId: string = 'default') {
    if (!this.browser) await this.launchBrowser();

    const userDataDir = app.getPath('userData');
    const sessionPath = path.join(userDataDir, 'sessions', `${profileId}.json`);

    let storageState: any = undefined;
    if (await fs.pathExists(sessionPath)) {
      console.log(`Loading session from ${sessionPath}`);
      storageState = sessionPath;
    }

    // Random viewport & user-agent per context (per account)
    const viewport = randomFrom(VIEWPORTS);
    const userAgent = randomFrom(USER_AGENTS);
    const timezone = randomFrom(TIMEZONES);

    console.log(`🥷 [Stealth] UA: ${userAgent.substring(0, 50)}... | VP: ${viewport.width}x${viewport.height} | TZ: ${timezone}`);

    this.context = await this.browser!.newContext({
      viewport,
      userAgent,
      locale: 'id-ID',
      timezoneId: timezone,
      geolocation: { longitude: 111.901, latitude: -8.077 },
      permissions: ['geolocation'],
      storageState: storageState,
      // Extra stealth headers
      extraHTTPHeaders: {
        'Accept-Language': 'id-ID,id;q=0.9,en-US;q=0.8,en;q=0.7',
        'sec-ch-ua': '"Chromium";v="131", "Not_A Brand";v="24"',
        'sec-ch-ua-mobile': '?0',
        'sec-ch-ua-platform': '"Windows"',
      },
    });

    return this.context;
  }

  async createPage(): Promise<Page> {
    if (!this.context) throw new Error('Context not created');
    this.page = await this.context.newPage();

    // Inject comprehensive stealth scripts
    await this.page.addInitScript(STEALTH_SCRIPT);

    return this.page;
  }

  async setGeolocation(latitude: number, longitude: number) {
    if (!this.context) throw new Error('Context not created');
    await this.context.setGeolocation({ latitude, longitude });
    console.log(`📍 [Browser] Geolocation updated: lat=${latitude}, lon=${longitude}`);
  }

  async close() {
    await this.context?.close();
    await this.browser?.close();
    this.browser = null;
    this.context = null;
    this.page = null;
  }

  getPage() {
    return this.page;
  }

  getContext() {
    return this.context;
  }
}

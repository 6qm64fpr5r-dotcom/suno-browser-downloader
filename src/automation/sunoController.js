const path = require('node:path');
const fs = require('node:fs');
const { spawn } = require('node:child_process');
const { chromium } = require('playwright');

const DOWNLOAD_TIMEOUT_MS = 40000;
const MENU_TIMEOUT_MS = 5000;
const BROWSER_CONNECT_TIMEOUT_MS = 15000;

class SunoController {
  constructor({ appDataDir, getSettings, saveSettings, onStatus }) {
    this.appDataDir = appDataDir;
    this.getSettings = getSettings;
    this.saveSettings = saveSettings;
    this.onStatus = onStatus;
    this.browser = null;
    this.context = null;
    this.page = null;
    this.connectedBrowser = false;
    this.queue = [];
    this.currentIndex = -1;
    this.running = false;
    this.paused = false;
    this.stopped = false;
    this.successCount = 0;
    this.lastSuccess = '';
    this.failedTrack = null;
    this.reservedNames = new Set();
    this.downloadHistory = this.loadDownloadHistory();
  }

  async launch() {
    if (this.page && !this.page.isClosed()) {
      await this.page.bringToFront();
      return;
    }

    const settings = this.getSettings();
    const cdpEndpoint = browserCdpEndpoint(settings);
    if (cdpEndpoint) {
      await this.launchConnectedBrowser(cdpEndpoint);
      return;
    }

    if (settings.browserMode === '360chrome') {
      await this.launch360Chrome(settings);
      return;
    }

    await this.launchPersistentBrowser(settings);
  }

  async launch360Chrome(settings = {}) {
    const cdpUrl = settings.browserCdpUrl || 'http://127.0.0.1:9222';
    const cdpEndpoint = new URL(cdpUrl);
    const port = cdpEndpoint.port || '9222';
    const profileDir = settings.browserProfileDir
      || path.join(this.appDataDir, 'suno-360-profile');
    fs.mkdirSync(profileDir, { recursive: true });

    spawn('open', [
      '-n',
      '-a',
      '/Applications/360Chrome.app',
      '--args',
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${profileDir}`,
      '--no-first-run',
    ], {
      detached: true,
      stdio: 'ignore',
    }).unref();

    await waitForCdpEndpoint(cdpUrl);
    await this.launchConnectedBrowser(cdpUrl);
  }

  async launchConnectedBrowser(cdpEndpoint) {
    this.browser = await chromium.connectOverCDP(cdpEndpoint);
    this.connectedBrowser = true;
    this.context = this.browser.contexts()[0] || await this.browser.newContext({
      acceptDownloads: true,
      viewport: null,
    });
    await this.setupPage('已连接到指定浏览器，请在该浏览器中打开 Suno 页面并勾选歌曲。', {
      navigate: true,
      preferExistingSunoPage: true,
    });
  }

  async launchPersistentBrowser(settings = {}) {
    const profileDir = browserProfileDir(settings, this.appDataDir);
    fs.mkdirSync(profileDir, { recursive: true });

    const options = {
      headless: false,
      acceptDownloads: true,
      viewport: null,
      args: ['--start-maximized'],
    };
    const channel = browserChannel(settings);
    if (channel) {
      options.channel = channel;
    }
    const executablePath = browserExecutablePath(settings);
    if (executablePath) {
      options.executablePath = executablePath;
    }

    this.context = await chromium.launchPersistentContext(profileDir, options);
    await this.setupPage('浏览器已启动，请在指定窗口中登录 Suno 并勾选歌曲。', {
      navigate: true,
      preferExistingSunoPage: false,
    });
  }

  async setupPage(message, { navigate, preferExistingSunoPage }) {
    const pages = this.context.pages();
    this.page = preferExistingSunoPage
      ? pages.find((page) => isSunoUrl(page.url())) || pages[0]
      : pages[0];
    this.page = this.page || await this.context.newPage();
    this.attachPageHandlers();

    const { lastUrl } = this.getSettings();
    if (navigate || this.page.url() === 'about:blank') {
      await this.page.goto(lastUrl || 'https://suno.com/', { waitUntil: 'domcontentloaded' });
    }
    await this.safeInjectCheckboxes();
    this.emitIdle(message);
  }

  async close() {
    if (this.context && !this.connectedBrowser) {
      await this.context.close();
    }
    if (this.browser && !this.connectedBrowser) {
      await this.browser.close();
    }
  }

  async injectCheckboxes() {
    await this.ensurePage();
    await this.focusSunoPage();
    await this.syncDownloadHistoryToPage();
    const result = await this.page.evaluate(injectSelectionUi);
    this.emitIdle(`已刷新复选框，识别到 ${result.count} 个候选歌曲卡片。`);
    return result;
  }

  async safeInjectCheckboxes() {
    try {
      await this.page.waitForLoadState('domcontentloaded', { timeout: 8000 });
      await this.syncDownloadHistoryToPage();
      await this.page.evaluate(injectSelectionUi);
    } catch {
      // Navigation can race with injection. The user can manually refresh injection from the GUI.
    }
  }

  async startQueue() {
    await this.ensurePage();
    await this.focusSunoPage();
    await this.syncDownloadHistoryToPage();
    const { downloadDir } = this.getSettings();
    if (!downloadDir) {
      throw new Error('请先选择下载目录。');
    }
    fs.mkdirSync(downloadDir, { recursive: true });

    await this.injectCheckboxes();
    this.queue = await this.page.evaluate(getSelectedTracks);
    if (this.queue.length === 0) {
      throw new Error('当前页面没有已勾选歌曲。');
    }

    this.currentIndex = 0;
    this.running = true;
    this.paused = false;
    this.stopped = false;
    this.successCount = 0;
    this.lastSuccess = '';
    this.failedTrack = null;
    this.reservedNames = new Set();

    this.onStatus({
      type: 'queue-started',
      total: this.queue.length,
      successCount: this.successCount,
    });

    await this.processQueue();
    return this.snapshot();
  }

  async retryCurrent() {
    if (!this.failedTrack) {
      return this.snapshot();
    }
    this.paused = false;
    this.running = true;
    this.failedTrack = null;
    await this.processQueue();
    return this.snapshot();
  }

  async skipCurrent() {
    if (!this.failedTrack) {
      return this.snapshot();
    }
    this.currentIndex += 1;
    this.paused = false;
    this.running = true;
    this.failedTrack = null;
    await this.processQueue();
    return this.snapshot();
  }

  async stopQueue() {
    this.stopped = true;
    this.running = false;
    this.paused = false;
    this.onStatus({ type: 'stopped', ...this.snapshot() });
    return this.snapshot();
  }

  async processQueue() {
    while (this.running && !this.stopped && this.currentIndex < this.queue.length) {
      const track = this.queue[this.currentIndex];
      this.onStatus({
        type: 'processing',
        track,
        current: this.currentIndex + 1,
        total: this.queue.length,
        successCount: this.successCount,
        lastSuccess: this.lastSuccess,
      });

      try {
        const savedAs = await this.downloadTrack(track);
        this.successCount += 1;
        this.lastSuccess = track.title;
        this.onStatus({
          type: 'success',
          track,
          savedAs,
          current: this.currentIndex + 1,
          total: this.queue.length,
          successCount: this.successCount,
          lastSuccess: this.lastSuccess,
        });
        this.currentIndex += 1;
      } catch (error) {
        this.running = false;
        this.paused = true;
        this.failedTrack = { ...track, error: error.message };
        this.onStatus({
          type: 'failed',
          track: this.failedTrack,
          current: this.currentIndex + 1,
          total: this.queue.length,
          successCount: this.successCount,
          lastSuccess: this.lastSuccess,
        });
        return;
      }
    }

    if (!this.stopped && this.currentIndex >= this.queue.length) {
      this.running = false;
      this.paused = false;
      this.onStatus({ type: 'completed', ...this.snapshot() });
    }
  }

  async downloadTrack(track) {
    await this.ensurePage();
    await this.page.evaluate((trackId) => {
      const card = document.querySelector(`[data-suno-dl-id="${CSS.escape(trackId)}"]`);
      if (!card) {
        throw new Error('无法定位目标歌曲卡片');
      }
      card.scrollIntoView({ block: 'center', inline: 'nearest' });
      card.style.outline = '3px solid #31c48d';
      setTimeout(() => {
        card.style.outline = '';
      }, 1500);
    }, track.id);

    const moreButton = this.page.locator(`[data-suno-dl-id="${cssString(track.id)}"]`).locator([
      'button[aria-label*="More" i]',
      'button[aria-label*="更多" i]',
      'button[title*="More" i]',
      'button[title*="更多" i]',
      'button:has-text("...")',
      'button:has-text("⋯")',
      'button:has-text("…")',
    ].join(', ')).last();

    if (await moreButton.count() === 0) {
      await this.page.evaluate((trackId) => {
        const card = document.querySelector(`[data-suno-dl-id="${CSS.escape(trackId)}"]`);
        const buttons = Array.from(card.querySelectorAll('button')).filter((button) => {
          const box = button.getBoundingClientRect();
          return box.width > 0 && box.height > 0;
        });
        const fallback = buttons.at(-1);
        if (!fallback) {
          throw new Error('无法打开更多操作菜单：未找到按钮');
        }
        fallback.click();
      }, track.id);
    } else {
      await moreButton.click({ timeout: MENU_TIMEOUT_MS });
    }

    const downloadPromise = this.page.waitForEvent('download', { timeout: DOWNLOAD_TIMEOUT_MS })
      .catch(() => {
        throw new Error('点击下载后，文件未进入浏览器下载列表');
      });
    await this.clickDownloadMenuItem();

    const download = await downloadPromise;
    const savePath = this.nextAvailablePath(track.title, download.suggestedFilename());
    await download.saveAs(savePath);
    this.recordDownloadedTrack(track, savePath);
    await this.markTrackDownloaded(track);
    return savePath;
  }

  loadDownloadHistory() {
    try {
      return JSON.parse(fs.readFileSync(this.downloadHistoryPath(), 'utf8'));
    } catch {
      return {};
    }
  }

  saveDownloadHistory() {
    fs.mkdirSync(this.appDataDir, { recursive: true });
    fs.writeFileSync(this.downloadHistoryPath(), JSON.stringify(this.downloadHistory, null, 2));
  }

  downloadHistoryPath() {
    return path.join(this.appDataDir, 'download-history.json');
  }

  recordDownloadedTrack(track, savePath) {
    const key = track.key || track.id;
    if (!key) {
      return;
    }
    this.downloadHistory[key] = {
      key,
      title: track.title || '',
      savedAs: savePath,
      downloadedAt: new Date().toISOString(),
    };
    this.saveDownloadHistory();
  }

  async syncDownloadHistoryToPage() {
    if (!this.page || this.page.isClosed()) {
      return;
    }
    await this.page.evaluate((downloadHistory) => {
      window.__sunoDlDownloadedKeys = {
        ...(window.__sunoDlDownloadedKeys || {}),
        ...Object.fromEntries(Object.keys(downloadHistory || {}).map((key) => [key, true])),
      };
    }, this.downloadHistory).catch(() => {});
  }

  async markTrackDownloaded(track) {
    await this.page.evaluate((track) => {
      window.__sunoDlDownloadedKeys = window.__sunoDlDownloadedKeys || {};
      window.__sunoDlDownloadedKeys[track.key || track.id] = true;
      const card = document.querySelector(`[data-suno-dl-id="${CSS.escape(track.id)}"]`);
      if (card) {
        card.setAttribute('data-suno-dl-downloaded', 'true');
        const label = card.querySelector('.suno-dl-badge span');
        if (label) {
          label.textContent = `${label.textContent.replace(/\s*已下载$/, '')} 已下载`;
        }
      }
    }, track).catch(() => {});
  }

  async clickDownloadMenuItem() {
    await this.page.evaluate(() => {
      document.getElementById('suno-dl-floating-status')?.remove();
    }).catch(() => {});

    const downloadMenuItem = this.page.getByRole('menuitem', { name: /download|下载/i }).first();
    await downloadMenuItem.waitFor({ state: 'visible', timeout: 1500 }).catch(() => {});
    if (await downloadMenuItem.count()) {
      await downloadMenuItem.hover({ timeout: MENU_TIMEOUT_MS });
    } else {
      const hovered = await this.page.evaluate(() => {
        const candidates = Array.from(document.querySelectorAll('button, [role="menuitem"], [role="button"], a, div, span'))
          .filter((node) => {
            if (node.closest('.suno-dl-badge, #suno-dl-floating-status')) {
              return false;
            }
            const text = (node.innerText || node.textContent || '').trim();
            if (!/download|下载/i.test(text)) {
              return false;
            }
            const box = node.getBoundingClientRect();
            return box.width > 0 && box.height > 0;
          })
          .sort((a, b) => {
            const score = (node) => {
              const role = node.getAttribute('role') || '';
              const tag = node.tagName.toLowerCase();
              return (role === 'menuitem' ? 0 : 10) + (tag === 'button' ? 0 : 1);
            };
            return score(a) - score(b);
          });
        const target = candidates[0];
        if (target) {
          target.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
          target.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }));
          target.dispatchEvent(new PointerEvent('pointerover', { bubbles: true }));
          target.dispatchEvent(new PointerEvent('pointerenter', { bubbles: true }));
          return true;
        }
        return false;
      });
      if (!hovered) {
        throw new Error('无法点击下载菜单项：未找到下载入口');
      }
    }

    await this.page.waitForTimeout(300);

    const clickedMp3 = await this.clickVisibleTextCenter(/^\s*MP3\s+Audio\s*$/i, {
      excludeSelector: '.suno-dl-badge, #suno-dl-floating-status',
    });
    if (clickedMp3) {
      return;
    }

    const clickedAudio = await this.clickVisibleTextCenter(/mp3|audio|音频/i, {
      excludeSelector: '.suno-dl-badge, #suno-dl-floating-status',
    });
    if (clickedAudio) {
      return;
    }

    throw new Error('无法点击下载格式：未找到 MP3 Audio 子菜单项');
  }

  async clickVisibleTextCenter(pattern, { excludeSelector } = {}) {
    const target = await this.page.evaluateHandle(({ source, flags, excludeSelector }) => {
      const regex = new RegExp(source, flags);
      const nodes = Array.from(document.querySelectorAll('button, [role="menuitem"], [role="button"], a, div, span'));
      const candidates = nodes
        .filter((node) => {
          if (excludeSelector && node.closest(excludeSelector)) {
            return false;
          }
          const text = (node.innerText || node.textContent || '').trim();
          if (!regex.test(text)) {
            return false;
          }
          const box = node.getBoundingClientRect();
          if (box.width <= 0 || box.height <= 0) {
            return false;
          }
          const style = window.getComputedStyle(node);
          return style.visibility !== 'hidden' && style.display !== 'none' && Number(style.opacity || 1) > 0;
        })
        .sort((a, b) => {
          const area = (node) => {
            const box = node.getBoundingClientRect();
            return box.width * box.height;
          };
          return area(a) - area(b);
        });
      return candidates[0] || null;
    }, {
      source: pattern.source,
      flags: pattern.flags,
      excludeSelector,
    });

    const element = target.asElement();
    if (!element) {
      await target.dispose();
      return false;
    }

    const box = await element.boundingBox();
    await target.dispose();
    if (!box) {
      return false;
    }

    await this.page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    return true;
  }

  nextAvailablePath(title, suggestedFilename) {
    const { downloadDir } = this.getSettings();
    const parsed = path.parse(suggestedFilename || '');
    const ext = parsed.ext || '.mp3';
    const base = sanitizeFilename(title || parsed.name || 'suno-song');
    let candidate = `${base}${ext}`;
    let counter = 2;

    while (this.reservedNames.has(candidate.toLowerCase()) || fs.existsSync(path.join(downloadDir, candidate))) {
      candidate = `${base}(${counter})${ext}`;
      counter += 1;
    }

    this.reservedNames.add(candidate.toLowerCase());
    return path.join(downloadDir, candidate);
  }

  async ensurePage() {
    if (!this.page || this.page.isClosed()) {
      await this.launch();
    }
  }

  async focusSunoPage() {
    if (!this.context) {
      return;
    }

    const sunoPage = this.context.pages().find((page) => !page.isClosed() && isSunoUrl(page.url()));
    if (sunoPage && sunoPage !== this.page) {
      this.page = sunoPage;
      this.attachPageHandlers();
    }
  }

  attachPageHandlers() {
    if (!this.page || this.page.__sunoControllerHandlersAttached) {
      return;
    }
    this.page.__sunoControllerHandlersAttached = true;
    this.page.on('framenavigated', async (frame) => {
      if (frame === this.page.mainFrame()) {
        this.saveSettings({ lastUrl: this.page.url() });
        await this.safeInjectCheckboxes();
      }
    });
  }

  emitIdle(message) {
    this.onStatus({ type: 'idle', message, settings: this.getSettings(), ...this.snapshot() });
  }

  snapshot() {
    return {
      running: this.running,
      paused: this.paused,
      stopped: this.stopped,
      current: Math.max(this.currentIndex + 1, 0),
      total: this.queue.length,
      successCount: this.successCount,
      lastSuccess: this.lastSuccess,
      failedTrack: this.failedTrack,
    };
  }
}

function sanitizeFilename(name) {
  return String(name)
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 160) || 'suno-song';
}

function cssString(value) {
  return String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function browserCdpEndpoint(settings = {}) {
  if (settings.browserMode === 'cdp') {
    return settings.browserCdpUrl || 'http://127.0.0.1:9222';
  }
  return process.env.SUNO_BROWSER_CDP_URL || process.env.SUNO_BROWSER_WS_ENDPOINT || '';
}

function browserChannel(settings = {}) {
  if (settings.browserMode === 'chrome') {
    return 'chrome';
  }
  return process.env.SUNO_BROWSER_CHANNEL || '';
}

function browserProfileDir(settings = {}, appDataDir) {
  return settings.browserProfileDir
    || process.env.SUNO_BROWSER_PROFILE_DIR
    || path.join(appDataDir, 'suno-chromium-profile');
}

function browserExecutablePath(settings = {}) {
  const configuredPath = browserExecutablePathSetting(settings);
  if (!configuredPath) {
    return '';
  }
  return resolveMacAppExecutable(configuredPath) || configuredPath;
}

function browserExecutablePathSetting(settings = {}) {
  if (settings.browserMode === 'executable') {
    return settings.browserExecutablePath;
  }
  return process.env.SUNO_BROWSER_EXECUTABLE_PATH;
}

function resolveMacAppExecutable(configuredPath) {
  if (process.platform !== 'darwin' || !configuredPath.endsWith('.app')) {
    return '';
  }

  const macOsDir = path.join(configuredPath, 'Contents', 'MacOS');
  try {
    const appName = path.basename(configuredPath, '.app');
    const appNameExecutable = path.join(macOsDir, appName);
    if (fs.existsSync(appNameExecutable)) {
      return appNameExecutable;
    }

    const [firstExecutable] = fs.readdirSync(macOsDir)
      .map((name) => path.join(macOsDir, name))
      .filter((candidate) => fs.statSync(candidate).isFile());
    return firstExecutable || '';
  } catch {
    return '';
  }
}

function isSunoUrl(value) {
  try {
    const { hostname } = new URL(value);
    return hostname === 'suno.com' || hostname.endsWith('.suno.com');
  } catch {
    return false;
  }
}

async function waitForCdpEndpoint(cdpUrl) {
  const deadline = Date.now() + BROWSER_CONNECT_TIMEOUT_MS;
  const versionUrl = new URL('/json/version', cdpUrl).toString();

  while (Date.now() < deadline) {
    try {
      const response = await fetch(versionUrl);
      if (response.ok) {
        return;
      }
    } catch {
      // Browser is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
  }

  throw new Error(`360 极速浏览器 Pro 已尝试启动，但无法连接调试地址：${cdpUrl}`);
}

function injectSelectionUi() {
  const STYLE_ID = 'suno-dl-style';
  const STATUS_ID = 'suno-dl-floating-status';
  const TOOLBAR_ID = 'suno-dl-floating-toolbar';
  const SELECTOR_CLASS = 'suno-dl-checkbox';
  const CARD_SELECTOR = [
    'article',
    'li',
    '[role="listitem"]',
    '[data-testid*="song" i]',
    '[data-testid*="track" i]',
    '[data-testid*="clip" i]',
    '[class*="song" i]',
    '[class*="track" i]',
    '[class*="clip" i]',
  ].join(',');

  if (!document.getElementById(STYLE_ID)) {
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = `
      .suno-dl-badge {
        position: absolute;
        z-index: 9999;
        top: 8px;
        left: 8px;
        display: inline-flex;
        align-items: center;
        gap: 6px;
        padding: 5px 8px;
        border: 1px solid rgba(34, 197, 94, 0.75);
        border-radius: 999px;
        background: rgba(4, 18, 13, 0.88);
        color: #ecfdf5;
        font: 600 12px/1.2 sans-serif;
        box-shadow: 0 8px 28px rgba(0, 0, 0, 0.24);
        pointer-events: auto;
      }
      .suno-dl-badge.is-downloaded {
        border-color: rgba(96, 165, 250, 0.82);
        background: rgba(18, 31, 54, 0.9);
      }
      .suno-dl-badge.is-downloaded input {
        cursor: not-allowed;
        opacity: 0.75;
      }
      .suno-dl-badge input {
        width: 15px;
        height: 15px;
        accent-color: #22c55e;
        cursor: pointer;
      }
      #suno-dl-floating-status {
        position: fixed;
        z-index: 2147483647;
        right: 18px;
        top: 18px;
        max-width: min(360px, calc(100vw - 36px));
        padding: 10px 12px;
        border: 1px solid rgba(34, 197, 94, 0.58);
        border-radius: 12px;
        background: rgba(5, 18, 14, 0.9);
        color: #ecfdf5;
        font: 700 13px/1.35 sans-serif;
        box-shadow: 0 14px 38px rgba(0, 0, 0, 0.28);
        pointer-events: none;
      }
      #suno-dl-floating-toolbar {
        position: fixed;
        z-index: 2147483647;
        right: 18px;
        top: 70px;
        display: flex;
        gap: 8px;
        padding: 8px;
        border: 1px solid rgba(34, 197, 94, 0.5);
        border-radius: 12px;
        background: rgba(5, 18, 14, 0.92);
        box-shadow: 0 14px 38px rgba(0, 0, 0, 0.28);
      }
      #suno-dl-floating-toolbar button {
        border: 0;
        border-radius: 8px;
        padding: 7px 10px;
        color: #ecfdf5;
        background: rgba(34, 197, 94, 0.22);
        font: 700 12px/1 sans-serif;
        cursor: pointer;
      }
      #suno-dl-floating-toolbar button:hover {
        background: rgba(34, 197, 94, 0.36);
      }
    `;
    document.head.appendChild(style);
  }

  const existingChecked = new Set(Array.from(document.querySelectorAll(`.${SELECTOR_CLASS}:checked`))
    .map((input) => input.closest('[data-suno-dl-key]')?.getAttribute('data-suno-dl-key'))
    .filter(Boolean));
  window.__sunoDlSelectedKeys = window.__sunoDlSelectedKeys || {};
  window.__sunoDlDownloadedKeys = window.__sunoDlDownloadedKeys || {};
  existingChecked.forEach((key) => {
    window.__sunoDlSelectedKeys[key] = true;
  });

  const workspaceRoot = findWorkspaceRoot();
  const candidates = [
    ...Array.from((workspaceRoot || document).querySelectorAll(CARD_SELECTOR)),
    ...findCardsFromControls(),
  ]
    .filter((node) => {
      const box = node.getBoundingClientRect();
      if (box.width < 220 || box.height < 90) {
        return false;
      }
      if (box.height > Math.max(520, window.innerHeight * 0.8)) {
        return false;
      }
      if (isCreateFormPanel(node)) {
        return false;
      }
      const text = (node.innerText || '').trim();
      return text.length > 0 && looksLikeTrackCard(node);
    });

  const cards = dedupeTrackCards(dedupeByNode(candidates));
  cards.forEach((card, index) => {
    const id = card.getAttribute('data-suno-dl-id') || `suno-track-${index + 1}-${Math.random().toString(36).slice(2, 8)}`;
    const key = getTrackKey(card, index);
    card.setAttribute('data-suno-dl-id', id);
    card.setAttribute('data-suno-dl-key', key);
    card.setAttribute('data-suno-dl-order', String(index + 1));
    card.setAttribute('data-suno-dl-downloaded', window.__sunoDlDownloadedKeys[key] ? 'true' : 'false');

    const computedPosition = window.getComputedStyle(card).position;
    if (computedPosition === 'static') {
      card.style.position = 'relative';
    }

    let badge = card.querySelector(':scope > .suno-dl-badge');
    if (!badge) {
      badge = document.createElement('label');
      badge.className = 'suno-dl-badge';
      badge.innerHTML = `<input class="${SELECTOR_CLASS}" type="checkbox" /> <span>第 ${index + 1} 首</span>`;
      card.prepend(badge);
    }

    const input = badge.querySelector('input');
    const label = badge.querySelector('span');
    const downloaded = Boolean(window.__sunoDlDownloadedKeys[key]);
    if (downloaded) {
      window.__sunoDlSelectedKeys[key] = false;
    }
    input.checked = !downloaded && Boolean(window.__sunoDlSelectedKeys[key]);
    input.disabled = false;
    input.title = downloaded ? '已下载，不能重复勾选' : '勾选这首歌';
    input.onchange = () => {
      if (window.__sunoDlDownloadedKeys[key]) {
        input.checked = false;
        window.__sunoDlSelectedKeys[key] = false;
        input.disabled = false;
        return;
      }
      window.__sunoDlSelectedKeys[key] = input.checked;
    };
    badge.classList.toggle('is-downloaded', downloaded);
    label.textContent = downloaded ? `第 ${index + 1} 首 已下载` : `第 ${index + 1} 首`;
  });

  let status = document.getElementById(STATUS_ID);
  if (!status) {
    status = document.createElement('div');
    status.id = STATUS_ID;
    document.body.appendChild(status);
  }
  status.textContent = cards.length
    ? `Suno 批量工具：已识别 ${cards.length} 首，历史已下载 ${Object.keys(window.__sunoDlDownloadedKeys || {}).length} 首。`
    : 'Suno 下载工具：当前页未识别到可下载歌曲，请生成完成后点工具里的刷新复选框。';

  let toolbar = document.getElementById(TOOLBAR_ID);
  if (!toolbar) {
    toolbar = document.createElement('div');
    toolbar.id = TOOLBAR_ID;
    toolbar.innerHTML = `
      <button type="button" data-suno-dl-action="select-all">全选当前</button>
      <button type="button" data-suno-dl-action="clear">清空选择</button>
    `;
    document.body.appendChild(toolbar);
  }
  toolbar.querySelector('[data-suno-dl-action="select-all"]').onclick = () => {
    document.querySelectorAll('[data-suno-dl-key]').forEach((card) => {
      if (!card.querySelector(':scope > .suno-dl-badge')) {
        return;
      }
      const key = card.getAttribute('data-suno-dl-key');
      const input = card.querySelector(`.${SELECTOR_CLASS}`);
      if (!key || !input || window.__sunoDlDownloadedKeys[key]) {
        return;
      }
      input.checked = true;
      window.__sunoDlSelectedKeys[key] = true;
    });
  };
  toolbar.querySelector('[data-suno-dl-action="clear"]').onclick = () => {
    Object.keys(window.__sunoDlSelectedKeys).forEach((key) => {
      window.__sunoDlSelectedKeys[key] = false;
    });
    document.querySelectorAll(`.${SELECTOR_CLASS}`).forEach((input) => {
      input.checked = false;
    });
  };

  return { count: cards.length };

  function dedupeTrackCards(nodes) {
    return nodes
      .sort((a, b) => area(a) - area(b))
      .filter((node, index, sorted) => {
        const overlapsSmallerCard = sorted.slice(0, index).some((other) => node.contains(other));
        return !overlapsSmallerCard;
      })
      .sort((a, b) => {
        const boxA = a.getBoundingClientRect();
        const boxB = b.getBoundingClientRect();
        return boxA.top - boxB.top || boxA.left - boxB.left;
      });
  }

  function area(node) {
    const box = node.getBoundingClientRect();
    return box.width * box.height;
  }

  function dedupeByNode(nodes) {
    return Array.from(new Set(nodes.filter(Boolean)));
  }

  function findCardsFromControls() {
    const controlSelector = [
      'audio',
      'a[href*="/song/"]',
      'a[href*="/track/"]',
      'button[aria-label*="More" i]',
      'button[aria-label*="更多" i]',
      'button[aria-label*="Download" i]',
      'button[aria-label*="下载" i]',
      'button[aria-label*="Play" i]',
      'button[aria-label*="播放" i]',
      '[role="button"][aria-label*="More" i]',
      '[role="button"][aria-label*="更多" i]',
    ].join(', ');

    return Array.from((workspaceRoot || document).querySelectorAll(controlSelector))
      .map((control) => closestTrackCard(control))
      .filter(Boolean);
  }

  function closestTrackCard(node) {
    const preferred = node.closest('article, li, [role="listitem"], [data-testid*="song" i], [data-testid*="track" i], [data-testid*="clip" i]');
    if (preferred) {
      return preferred;
    }

    let current = node.parentElement;
    while (current && current !== document.body) {
      const box = current.getBoundingClientRect();
      const text = (current.innerText || '').trim();
      if (
        box.width >= 220
        && box.height >= 90
        && box.height <= Math.max(520, window.innerHeight * 0.8)
        && text.length > 0
        && looksLikeTrackCard(current)
      ) {
        return current;
      }
      current = current.parentElement;
    }
    return null;
  }

  function looksLikeTrackCard(node) {
    const text = (node.innerText || '').toLowerCase();
    const strongCue = [
      node.querySelector('audio'),
      node.querySelector('a[href*="/song/"], a[href*="/track/"]'),
      node.querySelector('button[aria-label*="More" i], button[aria-label*="更多" i]'),
      node.querySelector('button[aria-label*="Download" i], button[aria-label*="下载" i]'),
      node.querySelector('button[aria-label*="Play" i], button[aria-label*="播放" i]'),
      node.querySelector('img[src*="suno.ai"], img[alt*="artwork" i]'),
    ].some(Boolean);
    const durationCue = /\b\d{1,2}:\d{2}\b/.test(text);
    const actionCue = /download|下载|play|播放|more|更多|remix|share/.test(text);
    return strongCue || (durationCue && actionCue);
  }

  function findWorkspaceRoot() {
    const heading = Array.from(document.querySelectorAll('h1, h2, h3, div, span'))
      .find((node) => /Workspaces|My Workspace/i.test((node.innerText || node.textContent || '').trim()));
    return heading?.closest('main, section, [class*="workspace" i], [class*="content" i]')
      || heading?.parentElement?.parentElement
      || null;
  }

  function isCreateFormPanel(node) {
    const text = (node.innerText || '').trim();
    if (/Song Description|Inspiration|Instrumental|Lyrics|Style of Music|Choose a model|Create$/i.test(text)) {
      const hasArtwork = node.querySelector('img[src*="suno.ai"], img[alt*="artwork" i]');
      const hasSongLink = node.querySelector('a[href*="/song/"], a[href*="/track/"]');
      return !hasArtwork && !hasSongLink;
    }
    return false;
  }

  function getTrackKey(card, index) {
    const title = extractTitleFromCard(card, index);
    const duration = ((card.innerText || '').match(/\b\d{1,2}:\d{2}\b/) || [''])[0];
    const image = card.querySelector('img[src*="suno.ai"], img[alt*="artwork" i]')?.getAttribute('src') || '';
    return normalizeKey([title, duration, image.split('?')[0]].filter(Boolean).join('|'));
  }

  function extractTitleFromCard(card, index) {
    const titleSelectors = [
      '[data-testid*="title" i]',
      '[class*="title" i]',
      'h1',
      'h2',
      'h3',
      'a[href*="/song/"]',
      'a[href*="/track/"]',
    ];
    for (const selector of titleSelectors) {
      const node = card.querySelector(selector);
      const text = normalizeText(node?.innerText || node?.textContent);
      if (text) {
        return text;
      }
    }

    const lines = normalizeText(card.innerText).split('\n').map((line) => line.trim()).filter(Boolean);
    const ignored = /^(download|下载|play|播放|more|更多|第\s*\d+\s*首|已下载|\d{1,2}:\d{2})$/i;
    return lines.find((line) => !ignored.test(line)) || `Suno Song ${index + 1}`;
  }

  function normalizeText(value) {
    return String(value || '').replace(/\s+\n/g, '\n').replace(/\n\s+/g, '\n').trim();
  }

  function normalizeKey(value) {
    return String(value || '').toLowerCase().replace(/\s+/g, ' ').trim();
  }
}

function getSelectedTracks() {
  return Array.from(document.querySelectorAll('[data-suno-dl-id]'))
    .sort((a, b) => Number(a.getAttribute('data-suno-dl-order')) - Number(b.getAttribute('data-suno-dl-order')))
    .filter((card) => card.querySelector('.suno-dl-checkbox')?.checked)
    .filter((card) => card.getAttribute('data-suno-dl-downloaded') !== 'true')
    .map((card, index) => ({
      id: card.getAttribute('data-suno-dl-id'),
      key: card.getAttribute('data-suno-dl-key'),
      order: Number(card.getAttribute('data-suno-dl-order')) || index + 1,
      title: extractTitle(card, index),
    }));

  function extractTitle(card, index) {
    const titleSelectors = [
      '[data-testid*="title" i]',
      '[class*="title" i]',
      'h1',
      'h2',
      'h3',
      'a[href*="/song/"]',
      'a[href*="/track/"]',
    ];
    for (const selector of titleSelectors) {
      const node = card.querySelector(selector);
      const text = normalize(node?.innerText || node?.textContent);
      if (text) {
        return text;
      }
    }

    const lines = normalize(card.innerText).split('\n').map((line) => line.trim()).filter(Boolean);
    const ignored = /^(download|下载|play|播放|more|更多|第\s*\d+\s*首)$/i;
    return lines.find((line) => !ignored.test(line)) || `Suno Song ${index + 1}`;
  }

  function normalize(value) {
    return String(value || '').replace(/\s+\n/g, '\n').replace(/\n\s+/g, '\n').trim();
  }
}

module.exports = { SunoController };

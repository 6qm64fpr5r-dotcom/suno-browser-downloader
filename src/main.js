const { app, BrowserWindow, dialog, ipcMain } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const { SunoController } = require('./automation/sunoController');

app.commandLine.appendSwitch('no-sandbox');
app.commandLine.appendSwitch('disable-gpu');
app.commandLine.appendSwitch('disable-software-rasterizer');

let mainWindow;
let controller;
let settings;

const DEFAULT_SETTINGS = {
  downloadDir: '',
  lastUrl: 'https://suno.com/',
  browserMode: 'default',
  browserExecutablePath: '',
  browserProfileDir: '',
  browserCdpUrl: 'http://127.0.0.1:9222',
};

function settingsPath() {
  return path.join(app.getPath('userData'), 'settings.json');
}

function loadSettings() {
  try {
    return { ...DEFAULT_SETTINGS, ...JSON.parse(fs.readFileSync(settingsPath(), 'utf8')) };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

function saveSettings(nextSettings = settings) {
  fs.mkdirSync(app.getPath('userData'), { recursive: true });
  fs.writeFileSync(settingsPath(), JSON.stringify(nextSettings, null, 2));
}

function sendStatus(payload) {
  if (!mainWindow || mainWindow.isDestroyed()) {
    return;
  }
  mainWindow.webContents.send('status:update', payload);

  if (payload?.type === 'failed') {
    showDownloadFailureDialog(payload).catch((error) => {
      console.error('Failed to show download failure dialog:', error);
    });
  }
}

async function showDownloadFailureDialog(payload) {
  if (!mainWindow || mainWindow.isDestroyed()) {
    return;
  }

  if (mainWindow.isMinimized()) {
    mainWindow.restore();
  }
  mainWindow.show();
  mainWindow.focus();

  const trackLabel = formatTrackLabel(payload.track);
  const reason = payload.track?.error || '自动化步骤异常。';

  await dialog.showMessageBox(mainWindow, {
    type: 'error',
    title: '下载失败',
    message: '下载失败，队列已暂停',
    detail: `${trackLabel}\n失败原因：${reason}\n\n请在工具窗口选择“重试当前项”、“跳过当前项”或“停止全部”。`,
    buttons: ['知道了'],
    defaultId: 0,
    noLink: true,
  });
}

function formatTrackLabel(track) {
  if (!track) {
    return '失败歌曲：未知';
  }

  const order = track.order ? `第 ${track.order} 首` : '当前歌曲';
  const title = track.title || '未命名歌曲';
  return `失败歌曲：${order} · ${title}`;
}

async function createWindow() {
  settings = loadSettings();
  controller = new SunoController({
    appDataDir: app.getPath('userData'),
    getSettings: () => settings,
    saveSettings: (patch) => {
      settings = { ...settings, ...patch };
      saveSettings();
    },
    onStatus: sendStatus,
  });

  mainWindow = new BrowserWindow({
    width: 560,
    height: 820,
    minWidth: 460,
    minHeight: 620,
    title: 'Suno 批量下载工具',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  await mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
}

app.whenReady().then(createWindow);

app.on('window-all-closed', async () => {
  if (controller) {
    await controller.close();
  }
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});

ipcMain.handle('settings:get', () => settings);

ipcMain.handle('settings:update-browser', (_event, browserSettings) => {
  settings = {
    ...settings,
    browserMode: browserSettings.browserMode || 'default',
    browserExecutablePath: browserSettings.browserExecutablePath || '',
    browserProfileDir: browserSettings.browserProfileDir || '',
    browserCdpUrl: browserSettings.browserCdpUrl || 'http://127.0.0.1:9222',
  };
  saveSettings();
  sendStatus({ type: 'settings', settings });
  return settings;
});

ipcMain.handle('browser:choose-executable', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: '选择浏览器程序',
    properties: ['openFile', 'openDirectory'],
  });

  if (!result.canceled && result.filePaths[0]) {
    settings.browserExecutablePath = result.filePaths[0];
    settings.browserMode = 'executable';
    saveSettings();
    sendStatus({ type: 'settings', settings });
  }

  return settings.browserExecutablePath;
});

ipcMain.handle('browser:launch', async () => {
  await controller.launch();
  return settings;
});

ipcMain.handle('browser:inject-checkboxes', async () => {
  return controller.injectCheckboxes();
});

ipcMain.handle('download:choose-dir', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: '选择 Suno 下载目录',
    properties: ['openDirectory', 'createDirectory'],
  });

  if (!result.canceled && result.filePaths[0]) {
    settings.downloadDir = result.filePaths[0];
    saveSettings();
    sendStatus({ type: 'settings', settings });
  }

  return settings.downloadDir;
});

ipcMain.handle('download:start', async () => {
  return controller.startQueue();
});

ipcMain.handle('download:retry', async () => {
  return controller.retryCurrent();
});

ipcMain.handle('download:skip', async () => {
  return controller.skipCurrent();
});

ipcMain.handle('download:stop', async () => {
  return controller.stopQueue();
});

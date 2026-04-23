const state = {
  total: 0,
  current: 0,
  successCount: 0,
  lastSuccess: '',
  running: false,
};

const els = {
  launchBrowser: document.getElementById('launchBrowser'),
  browserMode: document.getElementById('browserMode'),
  browserExecutableRow: document.getElementById('browserExecutableRow'),
  browserExecutablePath: document.getElementById('browserExecutablePath'),
  chooseBrowserExecutable: document.getElementById('chooseBrowserExecutable'),
  browserCdpRow: document.getElementById('browserCdpRow'),
  browserCdpUrl: document.getElementById('browserCdpUrl'),
  chooseDir: document.getElementById('chooseDir'),
  injectCheckboxes: document.getElementById('injectCheckboxes'),
  startDownload: document.getElementById('startDownload'),
  retryCurrent: document.getElementById('retryCurrent'),
  skipCurrent: document.getElementById('skipCurrent'),
  stopAll: document.getElementById('stopAll'),
  downloadDir: document.getElementById('downloadDir'),
  statusText: document.getElementById('statusText'),
  progressText: document.getElementById('progressText'),
  progressBar: document.getElementById('progressBar'),
  currentTrack: document.getElementById('currentTrack'),
  lastSuccess: document.getElementById('lastSuccess'),
  successCount: document.getElementById('successCount'),
  failurePanel: document.getElementById('failurePanel'),
  failedTrack: document.getElementById('failedTrack'),
  failedReason: document.getElementById('failedReason'),
  log: document.getElementById('log'),
};

init();

async function init() {
  const settings = await window.sunoTool.getSettings();
  renderSettings(settings);

  els.launchBrowser.addEventListener('click', runAction(async () => {
    await saveBrowserSettingsFromForm();
    await window.sunoTool.launchBrowser();
    addLog('浏览器已打开。');
  }));

  els.browserMode.addEventListener('change', runAction(async () => {
    renderBrowserModeFields();
    await saveBrowserSettingsFromForm();
  }));

  els.browserExecutablePath.addEventListener('change', runAction(saveBrowserSettingsFromForm));
  els.browserCdpUrl.addEventListener('change', runAction(saveBrowserSettingsFromForm));

  els.chooseBrowserExecutable.addEventListener('click', runAction(async () => {
    const executablePath = await window.sunoTool.chooseBrowserExecutable();
    els.browserExecutablePath.value = executablePath || '';
    els.browserMode.value = 'executable';
    renderBrowserModeFields();
    addLog(executablePath ? `浏览器程序已设置：${executablePath}` : '未选择浏览器程序。');
  }));

  els.chooseDir.addEventListener('click', runAction(async () => {
    const dir = await window.sunoTool.chooseDownloadDir();
    els.downloadDir.textContent = dir || '未选择';
    addLog(dir ? `下载目录已设置：${dir}` : '未选择下载目录。');
  }));

  els.injectCheckboxes.addEventListener('click', runAction(async () => {
    const result = await window.sunoTool.injectCheckboxes();
    addLog(`复选框已刷新，识别到 ${result.count} 个候选歌曲卡片。`);
  }));

  els.startDownload.addEventListener('click', runAction(async () => {
    hideFailure();
    await window.sunoTool.startDownload();
  }));

  els.retryCurrent.addEventListener('click', runAction(async () => {
    hideFailure();
    await window.sunoTool.retryCurrent();
  }));

  els.skipCurrent.addEventListener('click', runAction(async () => {
    hideFailure();
    await window.sunoTool.skipCurrent();
  }));

  els.stopAll.addEventListener('click', runAction(async () => {
    await window.sunoTool.stopAll();
    hideFailure();
  }));

  window.sunoTool.onStatus(handleStatus);
  renderProgress();
}

function handleStatus(payload) {
  if (payload.settings) {
    renderSettings(payload.settings);
  }

  if (typeof payload.total === 'number') {
    state.total = payload.total;
  }
  if (typeof payload.current === 'number') {
    state.current = payload.current;
  }
  if (typeof payload.successCount === 'number') {
    state.successCount = payload.successCount;
  }
  if (typeof payload.lastSuccess === 'string') {
    state.lastSuccess = payload.lastSuccess;
  }
  if (typeof payload.running === 'boolean') {
    state.running = payload.running;
  }

  if (payload.track?.title) {
    els.currentTrack.textContent = labelTrack(payload.track);
  }

  switch (payload.type) {
    case 'idle':
      els.statusText.textContent = '准备就绪';
      addLog(payload.message || '准备就绪。');
      break;
    case 'settings':
      renderSettings(payload.settings);
      break;
    case 'queue-started':
      els.statusText.textContent = '队列已开始';
      state.current = 1;
      addLog(`开始处理 ${payload.total} 首歌曲。`);
      break;
    case 'processing':
      els.statusText.textContent = '正在下载';
      addLog(`正在处理：${labelTrack(payload.track)}。`);
      break;
    case 'success':
      els.statusText.textContent = '下载已触发';
      addLog(`成功：${labelTrack(payload.track)}。`);
      break;
    case 'failed':
      els.statusText.textContent = '失败，已暂停';
      showFailure(payload.track);
      addLog(`失败：${labelTrack(payload.track)}，${payload.track.error}`);
      break;
    case 'completed':
      els.statusText.textContent = '全部完成';
      els.currentTrack.textContent = '-';
      addLog('队列已全部完成。');
      break;
    case 'stopped':
      els.statusText.textContent = '已停止';
      addLog('队列已停止。');
      break;
    default:
      break;
  }

  renderProgress();
}

function renderSettings(settings) {
  els.downloadDir.textContent = settings?.downloadDir || '未选择';
  els.browserMode.value = settings?.browserMode || 'default';
  els.browserExecutablePath.value = settings?.browserExecutablePath || '';
  els.browserCdpUrl.value = settings?.browserCdpUrl || 'http://127.0.0.1:9222';
  renderBrowserModeFields();
}

function renderBrowserModeFields() {
  els.browserExecutableRow.classList.toggle('hidden', els.browserMode.value !== 'executable');
  els.browserCdpRow.classList.toggle('hidden', els.browserMode.value !== 'cdp');
}

async function saveBrowserSettingsFromForm() {
  const settings = await window.sunoTool.updateBrowserSettings({
    browserMode: els.browserMode.value,
    browserExecutablePath: els.browserExecutablePath.value.trim(),
    browserCdpUrl: els.browserCdpUrl.value.trim() || 'http://127.0.0.1:9222',
  });
  renderSettings(settings);
}

function renderProgress() {
  const total = state.total || 0;
  const current = total ? Math.min(state.current || 1, total) : 0;
  const percent = total ? Math.round((state.successCount / total) * 100) : 0;

  els.progressText.textContent = `${current} / ${total}`;
  els.progressBar.style.width = `${percent}%`;
  els.successCount.textContent = String(state.successCount || 0);
  els.lastSuccess.textContent = state.lastSuccess || '-';
  els.startDownload.disabled = state.running;
}

function showFailure(track) {
  els.failurePanel.classList.remove('hidden');
  els.failedTrack.textContent = labelTrack(track);
  els.failedReason.textContent = track?.error || '自动化步骤异常。';
}

function hideFailure() {
  els.failurePanel.classList.add('hidden');
}

function labelTrack(track) {
  if (!track) {
    return '-';
  }
  return `第 ${track.order || '?'} 首 · ${track.title || '未命名歌曲'}`;
}

function addLog(message) {
  const item = document.createElement('li');
  item.textContent = `${new Date().toLocaleTimeString()} ${message}`;
  els.log.prepend(item);

  while (els.log.children.length > 40) {
    els.log.lastElementChild.remove();
  }
}

function runAction(fn) {
  return async () => {
    setBusy(true);
    try {
      await fn();
    } catch (error) {
      els.statusText.textContent = '操作失败';
      addLog(error.message || String(error));
    } finally {
      setBusy(false);
    }
  };
}

function setBusy(isBusy) {
  for (const button of [els.launchBrowser, els.chooseBrowserExecutable, els.chooseDir, els.injectCheckboxes, els.retryCurrent, els.skipCurrent, els.stopAll]) {
    button.disabled = isBusy;
  }
  els.startDownload.disabled = isBusy || state.running;
}

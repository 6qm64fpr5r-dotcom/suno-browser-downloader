# Suno Browser Downloader

本项目是一个本地运行的 Suno 浏览器自动化批量下载工具 v1。它使用 Electron 提供控制窗口，并用 Playwright 启动或连接浏览器来模拟真实用户在 Suno 页面中的下载操作。

## 功能范围

- 启动专用浏览器窗口，并复用该窗口的 Suno 登录态。
- 可通过环境变量指定真实 Chrome/Edge、指定 profile 目录，或连接已开启远程调试的浏览器。
- 默认打开上次使用页面。
- 在 Suno 页面歌曲卡片上注入复选框。
- 从当前页面读取已勾选歌曲，并按页面从上到下串行下载。
- 同名歌曲按对象级页面卡片区分，不只依赖歌名。
- 点击更多菜单和下载项后，等待浏览器 download 事件确认文件已进入下载流程。
- 失败时暂停队列，支持重试当前项、跳过当前项、停止全部。
- 下载目录由用户手动选择。
- 文件名默认使用歌曲名，冲突时追加 `(2)`、`(3)`。

## 安装与运行

```bash
npm install
npm start
```

如果首次运行时 Playwright 没有 Chromium 浏览器，请执行：

```bash
npx playwright install chromium
```

## 指定浏览器

默认会启动 Playwright 自带 Chromium，并使用工具自己的 profile。若这个浏览器无法登录 Suno，可以改用下面几种方式。

### 使用本机 Chrome

```bash
SUNO_BROWSER_CHANNEL=chrome npm start
```

这会用 Google Chrome 引擎启动工具自己的 profile。首次仍需在弹出的窗口里登录一次 Suno。

### 使用指定浏览器程序

```bash
SUNO_BROWSER_EXECUTABLE_PATH="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" npm start
```

也可以把路径换成 Microsoft Edge、Chrome Canary 等 Chromium 系浏览器。

### 使用指定 profile 目录

```bash
SUNO_BROWSER_CHANNEL=chrome \
SUNO_BROWSER_PROFILE_DIR="$HOME/Library/Application Support/Google/Chrome" \
npm start
```

如果要复用你日常 Chrome 的登录态，必须先关闭正在使用同一个 profile 的 Chrome 窗口，否则 Chrome 可能因为 profile 被占用而启动失败。更推荐用下面的远程调试方式连接已打开的浏览器。

### 连接已打开并登录的浏览器

先用远程调试端口启动一个 Chrome，并在这个窗口登录 Suno：

```bash
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
  --remote-debugging-port=9222 \
  --user-data-dir="$HOME/.suno-chrome-profile"
```

保持这个 Chrome 不要关，然后另开一个终端启动工具：

```bash
SUNO_BROWSER_CDP_URL=http://127.0.0.1:9222 npm start
```

工具会优先接管该浏览器里已经打开的 Suno 标签页；退出工具时不会主动关闭这个已连接的浏览器。

## 使用流程

1. 点击 `启动 / 打开浏览器`。
2. 在弹出的专用浏览器窗口中手动登录 Suno。
3. 打开包含歌曲列表的 Suno 页面。
4. 点击工具里的 `刷新复选框`，或等待页面自动注入复选框。
5. 在 Suno 页面中勾选要下载的歌曲。
6. 在工具里选择下载目录。
7. 点击 `开始下载`。
8. 如某首失败，工具会暂停，按需选择 `重试当前项`、`跳过当前项` 或 `停止全部`。

## 说明

Suno 页面结构可能变化。当前版本使用多组启发式规则定位歌曲卡片、更多菜单和下载项，优先保持页面流程真实、轻量和可人工接管。

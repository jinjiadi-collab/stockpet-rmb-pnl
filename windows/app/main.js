"use strict";

const {
  app,
  BrowserWindow,
  globalShortcut,
  ipcMain,
  Menu,
  nativeImage,
  net,
  Notification,
  powerMonitor,
  screen,
  shell,
  Tray,
} = require("electron");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const { createHash } = require("node:crypto");
const {
  changePercent,
  evaluatePriceThreshold,
  evaluateThreshold,
  failureBackoffSeconds,
  isMarketOpen,
  isVersionNewer,
  overlayDragPosition,
  overlayGeometry,
  releaseDigest,
  releaseParts,
  sanitizeState,
  shouldScheduleShow,
} = require("./lib");
const { fetchIntraday, fetchLatestQuotes, searchStocks } = require("./quote-service");

const PORTABLE_DATA_DIRECTORY = "data";

let overlayWindow = null;
let settingsWindow = null;
let tray = null;
let latestRefreshTimer = null;
let intradayRefreshTimer = null;
let latestRefreshFailures = 0;
let latestQuoteTimestamps = {};
let intradayRefreshPromise = null;
let latestRefreshPromise = null;
let refreshGeneration = 0;
let state = sanitizeState();
let quotes = {};
let quoteCache = {};
let thresholdStates = {};
let lastRefresh = null;
let sourceError = null;
let quitting = false;
let overlayDragStart = null;
let availableUpdate = null;
const UPDATES_ENABLED = true;
let registeredShortcut = null;
let shortcutHealthTimer = null;
let visibilityScheduleTimer = null;

// 只检查本项目自己的 GitHub Release，绝不连接原项目的更新源。
const UPDATE_ASSET_PATTERN = /^StockPet-(?:RMB-)?PnL-Windows-x64-v\d+(?:\.\d+){1,2}\.zip$/i;
const GITHUB_RELEASES_API = "https://api.github.com/repos/jinjiadi-collab/stockpet-rmb-pnl/releases/latest";
const UPDATE_MANIFEST_URL = "https://raw.githubusercontent.com/jinjiadi-collab/stockpet-rmb-pnl/main/update.json";
const CUSTOM_PROJECT_URL = "https://github.com/jinjiadi-collab/stockpet-rmb-pnl";
const UPSTREAM_BASE_VERSION = "0.4.4";
const EDITION_NAME = "StockPet P&L 定制版";

const configurationDirectory = () => app.isPackaged
  ? path.join(path.dirname(process.execPath), PORTABLE_DATA_DIRECTORY)
  : path.join(app.getPath("userData"), PORTABLE_DATA_DIRECTORY);
const configurationPath = (name) => path.join(configurationDirectory(), name);
const statePath = () => configurationPath("settings.json");
const quoteCachePath = () => configurationPath("quote-cache.json");
const updateResultPath = () => configurationPath("last-update-result.json");
const assetPath = (name) => path.join(__dirname, "assets", name);

function readJSON(filePath, fallback) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return fallback;
  }
}

function writeJSON(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2), "utf8");
}

function loadData() {
  state = sanitizeState(readJSON(statePath(), {}));
  quoteCache = readJSON(quoteCachePath(), {});
  quotes = { ...quoteCache };
}

function persistState() {
  writeJSON(statePath(), state);
}

function persistQuotes() {
  writeJSON(quoteCachePath(), quoteCache);
}

async function fetchUpdateJSON(url, headers = {}) {
  const response = await net.fetch(url, {
    cache: "no-store",
    headers: {
      Accept: "application/json",
      "User-Agent": `StockPet/${app.getVersion()}`,
      ...headers,
    },
  });
  if (!response.ok) throw new Error("检查更新失败，请稍后重试");
  return response.json();
}

async function githubUpdateCandidate() {
  const release = await fetchUpdateJSON(GITHUB_RELEASES_API, {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  });
  const version = String(release.tag_name || "").replace(/^[vV]/, "").split("-")[0];
  const asset = (release.assets || []).find((item) => UPDATE_ASSET_PATTERN.test(item.name));
  if (!asset?.browser_download_url || !String(asset.digest || "").startsWith("sha256:")) {
    throw new Error("新版本缺少适用于当前系统的安装包");
  }
  return {
    version,
    notes: release.body || "",
    releaseUrl: release.html_url || "https://github.com/jinjiadi-collab/stockpet-rmb-pnl/releases",
    assetName: asset.name,
    assetUrl: asset.browser_download_url,
    digest: String(asset.digest).toLowerCase(),
    size: Number(asset.size) || 0,
  };
}

async function manifestUpdateCandidate() {
  const manifest = await fetchUpdateJSON(`${UPDATE_MANIFEST_URL}?_=${Date.now()}`);
  const version = String(manifest.version || "").replace(/^[vV]/, "").split("-")[0];
  const assetName = String(manifest.assetName || "");
  const assetUrl = String(manifest.assetUrl || "");
  const digest = String(manifest.digest || "").toLowerCase();
  if (!version || !UPDATE_ASSET_PATTERN.test(assetName) || !assetUrl || !digest.startsWith("sha256:")) {
    throw new Error("更新清单无效，请稍后重试。");
  }
  return {
    version,
    notes: String(manifest.notes || ""),
    releaseUrl: String(manifest.releaseUrl || "https://github.com/jinjiadi-collab/stockpet-rmb-pnl/releases"),
    assetName,
    assetUrl,
    digest,
    size: Number(manifest.size) || 0,
  };
}

async function giteeUpdateCandidate() {
  const release = await fetchUpdateJSON(GITEE_RELEASES_API);
  const attachments = await fetchUpdateJSON(
    `https://gitee.com/api/v5/repos/YBigPie/StockPet/releases/${release.id}/attach_files?per_page=100`,
  );
  const parts = releaseParts(attachments, UPDATE_ASSET_NAME);
  const digest = releaseDigest(release.body, UPDATE_ASSET_NAME);
  if (!parts.length || !digest) {
    throw new Error("新版本缺少适用于当前系统的安装包");
  }
  return {
    version: String(release.tag_name || "").replace(/^[vV]/, "").split("-")[0],
    notes: release.body || "",
    download: {
      route: "routeTwo",
      assetName: UPDATE_ASSET_NAME,
      parts,
      digest,
    },
  };
}

async function checkForSoftwareUpdate() {
  if (!UPDATES_ENABLED) {
    return { status: "disabled", message: "StockPet P&L 已关闭上游更新" };
  }
  const results = await Promise.allSettled([manifestUpdateCandidate(), githubUpdateCandidate()]);
  const candidates = results.filter((item) => item.status === "fulfilled").map((item) => item.value);
  if (!candidates.length) throw new Error("检查更新失败，请稍后重试");
  const newer = candidates.filter((item) => isVersionNewer(item.version, app.getVersion()));
  if (!newer.length) {
    availableUpdate = null;
    return { status: "upToDate", currentVersion: app.getVersion() };
  }
  const latest = newer.reduce((selected, item) => (
    isVersionNewer(item.version, selected.version) ? item : selected
  ));
  availableUpdate = {
    version: latest.version,
    notes: latest.notes || "",
    releaseUrl: latest.releaseUrl,
    assetName: latest.assetName,
    assetUrl: latest.assetUrl,
    digest: latest.digest,
    size: latest.size,
  };
  return { status: "available", update: availableUpdate };
}

async function openUpdateRelease() {
  if (!availableUpdate) await checkForSoftwareUpdate();
  if (!availableUpdate) return { status: "upToDate" };
  await shell.openExternal(availableUpdate.releaseUrl);
  return { status: "opened", version: availableUpdate.version };
}

function powerShellLiteral(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

async function launchUpdater(scriptPath) {
  const launcherPath = path.join(path.dirname(scriptPath), "launch-update.vbs");
  const command = `powershell.exe -NoProfile -ExecutionPolicy Bypass -File "${scriptPath}"`;
  const launcherScript = [
    'Set shell = CreateObject("WScript.Shell")',
    `shell.Run "${command.replaceAll('"', '""')}", 0, False`,
    'WScript.Sleep 1000',
    'On Error Resume Next',
    'CreateObject("Scripting.FileSystemObject").DeleteFile WScript.ScriptFullName, True',
  ].join("\r\n");
  await fs.promises.writeFile(
    launcherPath,
    Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(launcherScript, "utf16le")]),
  );
  const launcher = spawn("wscript.exe", [launcherPath], {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
  });
  await new Promise((resolve, reject) => {
    launcher.once("spawn", resolve);
    launcher.once("error", reject);
  });
  launcher.unref();
}

function updateScript({ processId, archivePath, stagingPath, installDirectory, executableName, scriptPath, statusPath, targetVersion }) {
  return `﻿$ErrorActionPreference = 'Stop'
$processIdToWait = ${Number(processId)}
$archivePath = ${powerShellLiteral(archivePath)}
$stagingPath = ${powerShellLiteral(stagingPath)}
$installDirectory = ${powerShellLiteral(installDirectory)}
$executableName = ${powerShellLiteral(executableName)}
$scriptPath = ${powerShellLiteral(scriptPath)}
$statusPath = ${powerShellLiteral(statusPath)}
$targetVersion = ${powerShellLiteral(targetVersion)}

function Write-UpdateStatus($status, $message) {
  @{ status = $status; version = $targetVersion; message = $message } | ConvertTo-Json -Compress | Set-Content -LiteralPath $statusPath -Encoding UTF8
}

function Stop-TargetAppProcesses($expectedExecutablePath) {
  $deadline = (Get-Date).AddSeconds(12)
  do {
    $processes = @(
      Get-CimInstance Win32_Process -Filter "Name = '$targetExecutable'" -ErrorAction SilentlyContinue |
        Where-Object {
          $_.ExecutablePath -and
          [string]::Equals($_.ExecutablePath, $expectedExecutablePath, [System.StringComparison]::OrdinalIgnoreCase)
        }
    )
    if ($processes.Count -eq 0) { return }
    $processes | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
    Start-Sleep -Milliseconds 500
  } while ((Get-Date) -lt $deadline)

  throw "无法关闭正在占用更新文件的 $targetExecutable 进程。"
}

function Copy-PayloadWithRetry($sourcePath, $destinationPath, $expectedExecutablePath) {
  $lastError = $null
  for ($attempt = 1; $attempt -le 12; $attempt++) {
    try {
      Get-ChildItem -LiteralPath $sourcePath -Force | Copy-Item -Destination $destinationPath -Recurse -Force -ErrorAction Stop
      return
    } catch {
      $lastError = $_
      Stop-TargetAppProcesses $expectedExecutablePath
      Start-Sleep -Milliseconds 650
    }
  }
  throw $lastError
}

function Wait-ForOriginalAppExit($processIdToWait, $expectedExecutablePath) {
  $deadline = (Get-Date).AddSeconds(4)
  do {
    $process = Get-CimInstance Win32_Process -Filter "ProcessId = $processIdToWait" -ErrorAction SilentlyContinue
    if (-not $process) { return }
    if (-not $process.ExecutablePath -or -not [string]::Equals($process.ExecutablePath, $expectedExecutablePath, [System.StringComparison]::OrdinalIgnoreCase)) {
      return
    }
    Start-Sleep -Milliseconds 250
  } while ((Get-Date) -lt $deadline)
}

function Remove-ObsoleteLocaleFiles($targetDirectory) {
  $localesDirectory = Join-Path $targetDirectory 'locales'
  if (-not (Test-Path -LiteralPath $localesDirectory -PathType Container)) { return }
  Get-ChildItem -LiteralPath $localesDirectory -File -Filter '*.pak' -ErrorAction SilentlyContinue |
    Where-Object { $_.Name -notin @('zh-CN.pak', 'en-US.pak') } |
    Remove-Item -Force -ErrorAction SilentlyContinue
}

try {
  Wait-ForOriginalAppExit $processIdToWait (Join-Path $installDirectory $executableName)
  New-Item -ItemType Directory -Path $stagingPath -Force | Out-Null
  Expand-Archive -LiteralPath $archivePath -DestinationPath $stagingPath -Force
  $payloadDirectories = @(Get-ChildItem -LiteralPath $stagingPath -Directory)
  if ($payloadDirectories.Count -ne 1) {
    throw '更新包结构不正确，未替换当前版本。'
  }
  $payloadPath = $payloadDirectories[0].FullName
  $targetDirectory = $installDirectory
  $targetExecutable = $executableName
  if ($payloadDirectories[0].Name -eq 'StockPet-PnL') {
    $targetDirectory = Join-Path (Split-Path $installDirectory -Parent) 'StockPet-PnL'
    $targetExecutable = 'StockPet-PnL.exe'
  }
  New-Item -ItemType Directory -Path $targetDirectory -Force | Out-Null
  $targetExecutablePath = Join-Path $targetDirectory $targetExecutable
  Stop-TargetAppProcesses $targetExecutablePath
  Copy-PayloadWithRetry $payloadPath $targetDirectory $targetExecutablePath
  Remove-ObsoleteLocaleFiles $targetDirectory
  Write-UpdateStatus 'success' "已更新到 v$targetVersion"
  Start-Process -FilePath (Join-Path $targetDirectory $targetExecutable) -ArgumentList '--stockpet-updated'
} catch {
  Write-UpdateStatus 'failed' $_.Exception.Message
  Add-Type -AssemblyName PresentationFramework
  [System.Windows.MessageBox]::Show("自动更新没有完成：$($_.Exception.Message)\`n请从本项目的 Releases 页面手动下载。", 'Stock Pet 更新') | Out-Null
} finally {
  Remove-Item -LiteralPath $stagingPath -Recurse -Force -ErrorAction SilentlyContinue
  Remove-Item -LiteralPath $archivePath -Force -ErrorAction SilentlyContinue
  Remove-Item -LiteralPath $scriptPath -Force -ErrorAction SilentlyContinue
}
`;
}

async function downloadUpdateArchive(update, archivePath) {
  const response = await net.fetch(update.assetUrl, {
    cache: "no-store",
    headers: { Accept: "application/octet-stream", "User-Agent": `StockPet/${app.getVersion()}` },
  });
  if (!response.ok) throw new Error("更新包下载失败，请稍后重试。");
  const total = Number(response.headers.get("content-length")) || Number(update.size) || 0;
  const hash = createHash("sha256");
  let received = 0;
  let lastProgressAt = 0;
  const file = await fs.promises.open(archivePath, "w");
  try {
    const reader = response.body?.getReader?.();
    if (!reader) throw new Error("更新包数据流不可用，请稍后重试。");
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = Buffer.from(value);
      hash.update(chunk);
      received += chunk.length;
      await file.write(chunk);
      const now = Date.now();
      if (now - lastProgressAt >= 180 || (total && received >= total)) {
        send("update-download-progress", { received, total });
        lastProgressAt = now;
      }
    }
  } finally {
    await file.close();
  }
  const receivedHash = `sha256:${hash.digest("hex")}`;
  if (receivedHash !== update.digest) throw new Error("更新包校验失败，已停止安装。");
}

async function installAvailableUpdate() {
  if (!availableUpdate) await checkForSoftwareUpdate();
  if (!availableUpdate) return { status: "upToDate" };
  if (process.platform !== "win32" || !app.isPackaged) {
    throw new Error("自动更新仅适用于已解压运行的 Windows 正式版。");
  }
  const installDirectory = path.dirname(process.execPath);
  try {
    await fs.promises.access(installDirectory, fs.constants.W_OK);
  } catch {
    throw new Error("当前安装目录没有写入权限，请将软件解压到桌面或其他可写位置后再更新。");
  }
  const temporaryRoot = path.join(app.getPath("temp"), `stockpet-update-${Date.now()}`);
  const archivePath = path.join(temporaryRoot, availableUpdate.assetName);
  const stagingPath = path.join(temporaryRoot, "unpacked");
  const scriptPath = path.join(temporaryRoot, "finish-update.ps1");
  await fs.promises.mkdir(temporaryRoot, { recursive: true });
  try {
    await downloadUpdateArchive(availableUpdate, archivePath);
    const script = updateScript({
      processId: process.pid,
      archivePath,
      stagingPath,
      installDirectory,
      executableName: path.basename(process.execPath),
      scriptPath,
      statusPath: updateResultPath(),
      targetVersion: availableUpdate.version,
    });
    const scriptWithBom = script.startsWith("\uFEFF") ? script : `\uFEFF${script}`;
    await fs.promises.writeFile(scriptPath, Buffer.from(scriptWithBom, "utf8"));
    await launchUpdater(scriptPath);
  } catch (error) {
    await fs.promises.rm(temporaryRoot, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
  setTimeout(() => app.quit(), 250);
  return { status: "restarting", version: availableUpdate.version };
}

function presentUpdateResult() {
  const result = readJSON(updateResultPath(), null);
  if (!result?.status) return;
  fs.unlinkSync(updateResultPath());
  if (result.status === "success") {
    new Notification({ title: "StockPet P&L 更新完成", body: result.message || `已更新到 v${result.version}` }).show();
    send("update-complete", result);
  } else {
    new Notification({ title: "StockPet P&L 更新未完成", body: result.message || "请从 Releases 页面手动下载。" }).show();
    send("update-complete", result);
  }
}

async function checkForStartupUpdate() {
  try {
    const result = await checkForSoftwareUpdate();
    if (result.status !== "available") return;
    send("update-available", result.update);
    const notification = new Notification({
      title: "Stock Pet 有新版本",
      body: `发现 v${result.update.version}，点击可自动下载并更新。`,
    });
    notification.on("click", openSettings);
    notification.show();
  } catch {
    // 启动检查不打扰使用；用户可在设置中手动检查。
  }
}

function availableDownloadPath(update) {
  const extension = path.extname(update.assetName);
  const baseName = path.basename(update.assetName, extension);
  const directory = app.getPath("downloads");
  let candidate = path.join(directory, `${baseName}-v${update.version}${extension}`);
  let suffix = 2;
  while (fs.existsSync(candidate)) {
    candidate = path.join(directory, `${baseName}-v${update.version}-${suffix}${extension}`);
    suffix += 1;
  }
  return candidate;
}

async function downloadSoftwareUpdate(route) {
  if (!UPDATES_ENABLED) throw new Error("StockPet P&L 已关闭上游更新");
  if (!availableUpdate) await checkForSoftwareUpdate();
  if (!availableUpdate) return { status: "upToDate" };
  const update = availableUpdate;
  const download = update.downloads?.[route];
  if (!download) throw new Error("所选下载路线暂时不可用，请尝试另一条路线");
  const destination = availableDownloadPath({ ...update, assetName: download.assetName });
  const temporary = `${destination}.download-${process.pid}-${Date.now()}`;
  const total = download.parts.reduce((sum, part) => sum + (Number(part.size) || 0), 0);
  let received = 0;
  let lastProgressAt = 0;
  const hash = createHash("sha256");
  try {
    await fs.promises.writeFile(temporary, Buffer.alloc(0));
    for (const part of download.parts) {
      const response = await net.fetch(part.url, {
        cache: "no-store",
        headers: {
          Accept: "application/octet-stream",
          "User-Agent": `StockPet/${app.getVersion()}`,
        },
      });
      if (!response.ok) throw new Error("更新包下载失败，请稍后重试");
      const chunk = Buffer.from(await response.arrayBuffer());
      hash.update(chunk);
      received += chunk.length;
      await fs.promises.appendFile(temporary, chunk);
      const now = Date.now();
      if (now - lastProgressAt >= 200 || received >= total) {
        send("update-download-progress", { received, total });
        lastProgressAt = now;
      }
    }
    const actualDigest = `sha256:${hash.digest("hex")}`;
    if (actualDigest !== download.digest) throw new Error("更新包校验失败，已停止下载");
    await fs.promises.rename(temporary, destination);
  } catch (error) {
    await fs.promises.unlink(temporary).catch(() => {});
    throw error;
  }
  shell.showItemInFolder(destination);
  return { status: "downloaded", filePath: destination };
}

function snapshot() {
  return {
    state,
    quotes,
    update: availableUpdate,
    appInfo: {
      editionName: EDITION_NAME,
      customVersion: app.getVersion(),
      upstreamBaseVersion: UPSTREAM_BASE_VERSION,
    },
    status: {
      lastRefresh,
      sourceError,
      source: "腾讯秒级报价 · 腾讯分时 · 东方财富备用",
    },
  };
}

function send(channel, payload) {
  for (const window of [overlayWindow, settingsWindow]) {
    if (window && !window.isDestroyed() && window.webContents) {
      window.webContents.send(channel, payload);
    }
  }
}

function updateOverlayGeometry() {
  if (!overlayWindow || overlayWindow.isDestroyed()) return;
  const display = screen.getDisplayMatching(overlayWindow.getBounds());
  const maximumHeight = Math.floor(display.workAreaSize.height * 0.84);
  const geometry = overlayGeometry(
    state.symbols.length,
    state.displayScale,
    maximumHeight,
    state.chartWidth,
    Object.values(state.positions || {}).some((position) => (
      Number(position.costPrice) > 0
      && Number(position.quantity) > 0
      && Number(position.exchangeRate) > 0
    )),
  );
  overlayWindow.webContents.setZoomFactor(1);
  // Keep the native window and the rendered board on the same deterministic size.
  // Animated resizing can briefly expose the old viewport to the renderer and make
  // the board appear to stay fixed while its contents scale.
  overlayWindow.setSize(geometry.width, geometry.height, false);
  overlayWindow.setAlwaysOnTop(state.alwaysOnTop, "floating");
  overlayWindow.setIgnoreMouseEvents(state.clickThrough);
}

function notifyStateChanged() {
  updateOverlayGeometry();
  send("state-changed", state);
  rebuildTrayMenu();
}

function toggleOverlay() {
  if (!overlayWindow) return;
  overlayWindow.isVisible() ? overlayWindow.hide() : overlayWindow.showInactive();
  rebuildTrayMenu();
}

function setOverlayVisible(visible) {
  if (!overlayWindow) return;
  visible ? overlayWindow.showInactive() : overlayWindow.hide();
  rebuildTrayMenu();
}

function resetVisibilitySchedule(reconcileNow = true) {
  if (visibilityScheduleTimer) clearTimeout(visibilityScheduleTimer);
  visibilityScheduleTimer = null;
  if (!state.visibilityScheduleEnabled || state.scheduledShowTime === state.scheduledHideTime) return;

  const now = new Date();
  const nowMinutes = now.getHours() * 60 + now.getMinutes();
  if (reconcileNow) {
    const visible = shouldScheduleShow(nowMinutes, state.scheduledShowTime, state.scheduledHideTime);
    if (visible !== null) setOverlayVisible(visible);
  }
  const nextDate = (clock) => {
    const [hour, minute] = clock.split(":").map(Number);
    const result = new Date(now);
    result.setHours(hour, minute, 0, 0);
    if (result <= now) result.setDate(result.getDate() + 1);
    return result;
  };
  const next = [nextDate(state.scheduledShowTime), nextDate(state.scheduledHideTime)]
    .sort((left, right) => left - right)[0];
  visibilityScheduleTimer = setTimeout(() => resetVisibilitySchedule(true), next - now);
}

function configuredShortcut() {
  return `${state.shortcutModifier}+${state.shortcutKey}`;
}

function registerGlobalShortcut() {
  globalShortcut.unregisterAll();
  registeredShortcut = null;
  if (!state.shortcutEnabled) return true;
  const accelerator = configuredShortcut();
  const succeeded = globalShortcut.register(accelerator, () => {
    setImmediate(toggleOverlay);
  });
  if (succeeded && globalShortcut.isRegistered(accelerator)) {
    registeredShortcut = accelerator;
    return true;
  }
  return false;
}

function ensureGlobalShortcutRegistered() {
  if (!state.shortcutEnabled || quitting || !app.isReady()) return;
  const accelerator = configuredShortcut();
  if (registeredShortcut === accelerator && globalShortcut.isRegistered(accelerator)) return;
  registerGlobalShortcut();
}

function createOverlayWindow() {
  overlayWindow = new BrowserWindow({
    width: 860,
    height: 272,
    minWidth: 400,
    minHeight: 72,
    frame: false,
    transparent: true,
    backgroundColor: "#00000000",
    resizable: false,
    movable: false,
    alwaysOnTop: state.alwaysOnTop,
    skipTaskbar: true,
    show: false,
    hasShadow: false,
    icon: assetPath("app-icon.ico"),
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  overlayWindow.setMenuBarVisibility(false);
  overlayWindow.loadFile(path.join(__dirname, "overlay.html"));
  overlayWindow.once("ready-to-show", () => {
    updateOverlayGeometry();
    if (state.visibilityScheduleEnabled) resetVisibilitySchedule(true);
    else overlayWindow.showInactive();
  });
  overlayWindow.on("closed", () => {
    overlayDragStart = null;
    overlayWindow = null;
  });
}

function openSettings() {
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    settingsWindow.show();
    settingsWindow.focus();
    return;
  }
  settingsWindow = new BrowserWindow({
    width: 1040,
    height: 780,
    minWidth: 900,
    minHeight: 680,
    title: "Stock Pet 设置",
    backgroundColor: "#f6f7fb",
    icon: assetPath("app-icon.ico"),
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  settingsWindow.setMenuBarVisibility(false);
  settingsWindow.loadFile(path.join(__dirname, "settings.html"));
  settingsWindow.on("closed", () => {
    settingsWindow = null;
  });
}

function rebuildTrayMenu() {
  if (!tray) return;
  tray.setContextMenu(Menu.buildFromTemplate([
    {
      label: overlayWindow?.isVisible() ? "隐藏桌宠" : "显示桌宠",
      click: toggleOverlay,
    },
    { label: "立即刷新", click: () => refreshAll() },
    { label: "检查软件更新", click: () => checkForSoftwareUpdate().then(openSettings).catch(openSettings) },
    {
      label: "锁定并穿透鼠标",
      type: "checkbox",
      checked: state.clickThrough,
      click: (item) => applyStatePatch({ clickThrough: item.checked }),
    },
    {
      label: "始终置顶",
      type: "checkbox",
      checked: state.alwaysOnTop,
      click: (item) => applyStatePatch({ alwaysOnTop: item.checked }),
    },
    { type: "separator" },
    { label: "设置…", click: openSettings },
    { type: "separator" },
    {
      label: "退出 Stock Pet",
      click: () => {
        quitting = true;
        app.quit();
      },
    },
  ]));
}

function createTray() {
  const trayImage = nativeImage.createFromPath(assetPath("icon-32.png"));
  tray = new Tray(trayImage);
  tray.setToolTip("Stock Pet");
  tray.on("double-click", openSettings);
  rebuildTrayMenu();
}

function resetRefreshTimer() {
  if (latestRefreshTimer) clearTimeout(latestRefreshTimer);
  if (intradayRefreshTimer) clearTimeout(intradayRefreshTimer);
  latestRefreshFailures = 0;
  const generation = ++refreshGeneration;
  latestRefreshTimer = setTimeout(
    () => runLatestRefreshLoop(generation),
    state.refreshInterval * 1000,
  );
  intradayRefreshTimer = setTimeout(
    () => runIntradayRefreshLoop(generation),
    intradayDelaySeconds() * 1000,
  );
}

function hasOpenMarket() {
  const now = new Date();
  return state.symbols.some((symbol) => isMarketOpen(symbol.market, now));
}

function intradayDelaySeconds() {
  return hasOpenMarket() ? Math.max(15, state.refreshInterval) : 60;
}

async function runLatestRefreshLoop(generation) {
  if (generation !== refreshGeneration) return;
  latestRefreshTimer = null;
  const now = new Date();
  const activeSymbols = state.symbols.filter((symbol) => isMarketOpen(symbol.market, now));
  let delay = 30;
  if (activeSymbols.length) {
    const succeeded = await refreshLatest(activeSymbols);
    latestRefreshFailures = succeeded ? 0 : Math.min(latestRefreshFailures + 1, 5);
    delay = latestRefreshFailures
      ? failureBackoffSeconds(state.refreshInterval, latestRefreshFailures)
      : state.refreshInterval;
  }
  if (!quitting && generation === refreshGeneration) {
    latestRefreshTimer = setTimeout(
      () => runLatestRefreshLoop(generation),
      delay * 1000,
    );
  }
}

async function runIntradayRefreshLoop(generation) {
  if (generation !== refreshGeneration) return;
  intradayRefreshTimer = null;
  await refreshAll();
  if (!quitting && generation === refreshGeneration) {
    intradayRefreshTimer = setTimeout(
      () => runIntradayRefreshLoop(generation),
      intradayDelaySeconds() * 1000,
    );
  }
}

function applyStatePatch(patch) {
  const previousRefreshInterval = state.refreshInterval;
  const shortcutChanged = (
    patch.shortcutEnabled !== undefined ||
    patch.shortcutModifier !== undefined ||
    patch.shortcutKey !== undefined
  );
  const scheduleChanged = (
    patch.visibilityScheduleEnabled !== undefined ||
    patch.scheduledShowTime !== undefined ||
    patch.scheduledHideTime !== undefined
  );
  state = sanitizeState({ ...state, ...patch });
  thresholdStates = {};
  persistState();
  notifyStateChanged();
  if (!state.alertsEnabled) send("alert-dismiss", null);
  if (shortcutChanged) registerGlobalShortcut();
  if (scheduleChanged) resetVisibilitySchedule(true);
  if (state.refreshInterval !== previousRefreshInterval) resetRefreshTimer();
  return state;
}

function presentAlert(direction, quote, preview = false) {
  const fallbackSymbol = state.symbols[0] || {
    code: "DEMO",
    name: "预览",
    market: "aShare",
    quoteID: "preview",
  };
  const symbol = quote?.symbol || fallbackSymbol;
  const targets = state.priceAlertTargets[symbol.quoteID] || {};
  const targetPrice = direction === "rising" ? targets.risingPrice : targets.fallingPrice;
  const percent = quote?.changePercent
    ?? (direction === "rising" ? state.risingThreshold : -state.fallingThreshold);
  send("stock-alert", {
    direction,
    symbol,
    percent,
    basis: state.alertBasis,
    lastPrice: quote?.lastPrice ?? targetPrice ?? 0,
    targetPrice: state.alertBasis === "targetPrice" ? targetPrice : null,
    preview,
    soundEnabled: direction === "rising" ? state.bullSoundEnabled : state.bearSoundEnabled,
  });
}

function evaluateQuoteAlert(quote) {
  if (!state.alertsEnabled) return;
  const previous = thresholdStates[quote.symbol.quoteID] || "armed";
  const targets = state.priceAlertTargets[quote.symbol.quoteID];
  const result = state.alertBasis === "targetPrice"
    ? targets
      ? evaluatePriceThreshold(
          previous,
          quote.lastPrice,
          targets.risingPrice,
          targets.fallingPrice,
        )
      : { state: "armed", direction: null }
    : evaluateThreshold(
        previous,
        quote.changePercent,
        state.risingThreshold,
        state.fallingThreshold,
      );
  thresholdStates[quote.symbol.quoteID] = result.state;
  if (result.direction) presentAlert(result.direction, quote);
}

async function refreshAll() {
  if (intradayRefreshPromise) return intradayRefreshPromise;
  intradayRefreshPromise = performIntradayRefresh().finally(() => {
    intradayRefreshPromise = null;
  });
  return intradayRefreshPromise;
}

async function performIntradayRefresh() {
  const symbols = [...state.symbols];
  if (!symbols.length) {
    lastRefresh = new Date().toISOString();
    sourceError = null;
    send("refresh-status", snapshot().status);
    return snapshot();
  }
  const results = await Promise.allSettled(symbols.map(fetchIntraday));
  let failures = 0;
  results.forEach((result, index) => {
    const symbol = symbols[index];
    if (result.status === "fulfilled") {
      const existing = quotes[symbol.quoteID];
      const sourceTimestamp = latestQuoteTimestamps[symbol.quoteID];
      const merged = existing && sourceTimestamp
        ? {
            ...result.value,
            lastPrice: existing.lastPrice,
            changePercent: changePercent(existing.lastPrice, result.value.previousClose),
            updatedAt: existing.updatedAt,
            sourceTimestamp,
          }
        : result.value;
      quotes[symbol.quoteID] = merged;
      quoteCache[symbol.quoteID] = merged;
      evaluateQuoteAlert(merged);
    } else {
      failures += 1;
      const cached = quotes[symbol.quoteID];
      if (cached) {
        quotes[symbol.quoteID] = {
          ...cached,
          isStale: true,
          statusMessage: result.reason?.message || "行情连接失败",
        };
      }
    }
  });
  persistQuotes();
  lastRefresh = new Date().toISOString();
  sourceError = failures === symbols.length ? "行情连接暂不可用，已保留上次成功数据" : null;
  send("quotes-updated", quotes);
  send("refresh-status", snapshot().status);
  return snapshot();
}

async function refreshLatest(symbols) {
  if (latestRefreshPromise) return latestRefreshPromise;
  latestRefreshPromise = performLatestRefresh(symbols).finally(() => {
    latestRefreshPromise = null;
  });
  return latestRefreshPromise;
}

async function performLatestRefresh(symbols) {
  try {
    const updates = await fetchLatestQuotes(symbols);
    let applied = 0;
    for (const update of updates) {
      const id = update.symbol.quoteID;
      if (latestQuoteTimestamps[id]
          && update.sourceTimestamp <= latestQuoteTimestamps[id]) continue;
      latestQuoteTimestamps[id] = update.sourceTimestamp;
      const existing = quotes[id];
      const quote = {
        symbol: update.symbol,
        points: existing?.points || [],
        dayOpen: existing?.dayOpen || update.lastPrice,
        previousClose: update.previousClose,
        lastPrice: update.lastPrice,
        changePercent: changePercent(update.lastPrice, update.previousClose),
        updatedAt: update.sourceTimestamp,
        sourceTimestamp: update.sourceTimestamp,
        isStale: false,
        source: update.source === "eastmoney" ? "东方财富指数报价" : "腾讯秒级报价",
      };
      quotes[id] = quote;
      quoteCache[id] = quote;
      evaluateQuoteAlert(quote);
      applied += 1;
    }
    if (applied) {
      lastRefresh = new Date().toISOString();
      sourceError = null;
      send("quotes-updated", quotes);
      send("refresh-status", snapshot().status);
    }
    return updates.length > 0;
  } catch {
    if (!Object.keys(quotes).length) {
      sourceError = "实时价格暂时不可用，分时曲线仍会继续刷新";
      send("refresh-status", snapshot().status);
    }
    return false;
  }
}

function registerIPC() {
  ipcMain.handle("bootstrap", () => snapshot());
  ipcMain.handle("state:update", (_event, patch) => applyStatePatch(patch || {}));
  ipcMain.handle("stocks:search", (_event, query) => searchStocks(query));
  ipcMain.handle("stocks:add", async (_event, symbol) => {
    if (state.symbols.some((item) => item.quoteID === symbol.quoteID)) {
      return { ok: false, message: "这只股票已经在桌面上了" };
    }
    applyStatePatch({ symbols: [...state.symbols, symbol] });
    await refreshAll();
    return { ok: true };
  });
  ipcMain.handle("stocks:remove", (_event, quoteID) => {
    applyStatePatch({ symbols: state.symbols.filter((item) => item.quoteID !== quoteID) });
    delete quotes[quoteID];
    delete quoteCache[quoteID];
    delete thresholdStates[quoteID];
    delete latestQuoteTimestamps[quoteID];
    persistQuotes();
    send("quotes-updated", quotes);
    return { ok: true };
  });
  ipcMain.handle("stocks:move", (_event, quoteID, direction) => {
    const symbols = [...state.symbols];
    const from = symbols.findIndex((item) => item.quoteID === quoteID);
    const to = from + Number(direction);
    if (from >= 0 && to >= 0 && to < symbols.length) {
      [symbols[from], symbols[to]] = [symbols[to], symbols[from]];
      applyStatePatch({ symbols });
    }
    return { ok: true };
  });
  ipcMain.handle("quotes:refresh", () => refreshAll());
  ipcMain.handle("alert:preview", (_event, direction) => {
    presentAlert(direction === "falling" ? "falling" : "rising", null, true);
    return { ok: true };
  });
  ipcMain.handle("settings:open", () => {
    openSettings();
    return { ok: true };
  });
  ipcMain.handle("external:open-author", async () => {
    await shell.openExternal("https://github.com/YellowPancake");
    return { ok: true };
  });
  ipcMain.handle("external:open-custom-project", async () => {
    await shell.openExternal(CUSTOM_PROJECT_URL);
    return { ok: true };
  });
  ipcMain.handle("update:check", () => checkForSoftwareUpdate());
  ipcMain.handle("update:open-release", () => openUpdateRelease());
  ipcMain.handle("update:install", () => installAvailableUpdate());
  ipcMain.handle("overlay:show", () => {
    overlayWindow?.showInactive();
    return { ok: true };
  });
  ipcMain.on("overlay:drag-start", (_event, point) => {
    if (!overlayWindow || state.clickThrough) return;
    const pointer = { x: Number(point?.x), y: Number(point?.y) };
    if (!Number.isFinite(pointer.x) || !Number.isFinite(pointer.y)) return;
    const [x, y] = overlayWindow.getPosition();
    overlayDragStart = {
      window: { x, y },
      pointer,
    };
  });
  ipcMain.on("overlay:drag-move", (_event, point) => {
    if (!overlayWindow || state.clickThrough || !overlayDragStart) return;
    const pointer = { x: Number(point?.x), y: Number(point?.y) };
    if (!Number.isFinite(pointer.x) || !Number.isFinite(pointer.y)) return;
    const target = overlayDragPosition(
      overlayDragStart.window,
      overlayDragStart.pointer,
      pointer,
    );
    overlayWindow.setPosition(target.x, target.y, false);
  });
  ipcMain.on("overlay:drag-end", () => {
    overlayDragStart = null;
  });
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    overlayWindow?.showInactive();
  });

  app.whenReady().then(() => {
    app.setAppUserModelId("com.bingge.StockPet");
    loadData();
    registerIPC();
    createOverlayWindow();
    createTray();
    registerGlobalShortcut();
    resetVisibilitySchedule(true);
    shortcutHealthTimer = setInterval(ensureGlobalShortcutRegistered, 3000);
    app.on("browser-window-blur", () => setImmediate(ensureGlobalShortcutRegistered));
    powerMonitor.on("resume", () => {
      ensureGlobalShortcutRegistered();
      resetVisibilitySchedule(true);
    });
    powerMonitor.on("unlock-screen", () => {
      ensureGlobalShortcutRegistered();
      resetVisibilitySchedule(true);
    });
    refreshAll().finally(resetRefreshTimer);
    setTimeout(presentUpdateResult, 1200);
    setTimeout(checkForStartupUpdate, 5000);
  });

  app.on("before-quit", () => {
    quitting = true;
    if (latestRefreshTimer) clearTimeout(latestRefreshTimer);
    if (intradayRefreshTimer) clearTimeout(intradayRefreshTimer);
    if (shortcutHealthTimer) clearInterval(shortcutHealthTimer);
    if (visibilityScheduleTimer) clearTimeout(visibilityScheduleTimer);
    refreshGeneration += 1;
    persistQuotes();
    globalShortcut.unregisterAll();
    registeredShortcut = null;
  });

  app.on("window-all-closed", () => {
    if (quitting) app.quit();
  });

  app.on("activate", () => {
    if (!overlayWindow) createOverlayWindow();
    overlayWindow?.showInactive();
  });
}

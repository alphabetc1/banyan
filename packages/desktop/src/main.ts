// Banyan desktop client: a window onto the room server's web UI plus the runners for the
// rooms this machine hosts. Closing the window keeps runners going in the tray; quitting
// stops them gracefully.
import { hostname } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { readSavedRunner, registerRunner } from "@banyan/runner/registration";
import type { LocalRunnerStatus } from "@banyan/shared";
import { app, BrowserWindow, ipcMain, Menu, nativeImage, Notification, shell, Tray, type IpcMainEvent, type IpcMainInvokeEvent } from "electron";
import { RunnerManager } from "./runner-manager.ts";
import { normalizeServerUrl, SettingsFile } from "./settings.ts";
import { loginShellPath } from "./shell-env.ts";

const here = import.meta.dirname;
const SETUP_URL = pathToFileURL(join(here, "setup.html")).href;
const zh = () => app.getLocale().startsWith("zh");

// Lets a test or a second profile keep its client settings apart.
if (process.env.BANYAN_DESKTOP_DATA) app.setPath("userData", process.env.BANYAN_DESKTOP_DATA);

let window: BrowserWindow | null = null;
let tray: Tray | null = null;
let quitting = false;
let settings: SettingsFile;
let runners: RunnerManager;

function runnerEnv(): NodeJS.ProcessEnv {
  const path = process.platform === "win32" ? null : loginShellPath(process.env.SHELL ?? "/bin/zsh");
  return path ? { ...process.env, PATH: path } : { ...process.env };
}

function showWindow(): BrowserWindow {
  if (window) {
    window.show();
    window.focus();
    return window;
  }
  const win = new BrowserWindow({
    width: 1280,
    height: 840,
    minWidth: 720,
    minHeight: 480,
    title: "Banyan",
    webPreferences: { preload: join(here, "preload.cjs"), contextIsolation: true, sandbox: true },
  });
  win.on("close", (e) => {
    if (quitting) return;
    e.preventDefault();
    win.hide();
  });
  win.on("closed", () => (window = null));
  // Links leaving the room server open in the system browser.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) void shell.openExternal(url);
    return { action: "deny" };
  });
  win.webContents.on("will-navigate", (e, url) => {
    if (url === SETUP_URL || new URL(url).origin === settings.get().serverUrl) return;
    e.preventDefault();
    if (/^https?:/.test(url)) void shell.openExternal(url);
  });
  window = win;
  void win.loadURL(settings.get().serverUrl ?? SETUP_URL);
  return win;
}

// Only the configured room server's pages and the setup page may use the bridge.
function trusted(e: IpcMainEvent | IpcMainInvokeEvent): boolean {
  const url = e.senderFrame?.url;
  if (!url) return false;
  return url === SETUP_URL || new URL(url).origin === settings.get().serverUrl;
}

function guard<A extends unknown[], R>(handler: (...args: A) => R) {
  return (e: IpcMainInvokeEvent, ...args: A): R => {
    if (!trusted(e)) throw new Error("not allowed from this page");
    return handler(...args);
  };
}

async function setServerUrl(input: string): Promise<void> {
  const serverUrl = normalizeServerUrl(input);
  const res = await fetch(`${serverUrl}/api/health`).catch((e: Error) => {
    throw new Error(`${zh() ? "无法连接" : "cannot reach"} ${serverUrl}: ${e.message}`);
  });
  if (!res.ok) throw new Error(`${serverUrl}/api/health → ${res.status}`);
  settings.update({ serverUrl });
  void showWindow().loadURL(serverUrl);
}

async function enableRunner(roomId: string, memberToken: string): Promise<void> {
  const serverUrl = settings.get().serverUrl;
  if (!serverUrl) throw new Error("no room server configured");
  if (!readSavedRunner(roomId)) await registerRunner({ serverUrl, roomId, memberToken, hostname: hostname() });
  const enabled = settings.get().enabledRooms;
  if (!enabled.includes(roomId)) settings.update({ enabledRooms: [...enabled, roomId] });
  runners.start(roomId);
}

async function disableRunner(roomId: string): Promise<void> {
  settings.update({ enabledRooms: settings.get().enabledRooms.filter((r) => r !== roomId) });
  await runners.stop(roomId);
}

function notify(title: string, body: string, path: string): void {
  const n = new Notification({ title, body });
  n.on("click", () => {
    const serverUrl = settings.get().serverUrl;
    const win = showWindow();
    if (serverUrl) void win.loadURL(new URL(path, serverUrl).href);
  });
  n.show();
}

const STATE_LABELS: Record<LocalRunnerStatus["state"], [string, string]> = {
  starting: ["starting", "启动中"],
  running: ["running", "运行中"],
  error: ["stopped with an error", "出错已停止"],
};

function updateTray(list: LocalRunnerStatus[]): void {
  if (!tray) return;
  const t = (en: string, cn: string) => (zh() ? cn : en);
  const runnerItems: Electron.MenuItemConstructorOptions[] = list.length
    ? list.map((r) => ({ label: `${r.roomId.slice(-6)} · ${t(...STATE_LABELS[r.state])}`, enabled: false }))
    : [{ label: t("No local runners", "本机没有 runner"), enabled: false }];
  tray.setToolTip(`Banyan · ${list.filter((r) => r.state === "running").length}/${list.length}`);
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: t("Open Banyan", "打开 Banyan"), click: () => showWindow() },
      { type: "separator" },
      ...runnerItems,
      { type: "separator" },
      { label: t("Change room server…", "更换 room server…"), click: () => void showWindow().loadURL(SETUP_URL) },
      { label: t("Quit (stops local agents)", "退出（停止本机 agent）"), click: () => app.quit() },
    ]),
  );
}

// A filled circle drawn at runtime, so the tray needs no image asset.
function trayIcon(): Electron.NativeImage {
  const size = 32;
  const buf = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const d = Math.hypot(x - size / 2 + 0.5, y - size / 2 + 0.5);
      // BGRA: black with antialiased alpha.
      buf[(y * size + x) * 4 + 3] = Math.round(255 * Math.max(0, Math.min(1, 11 - d)));
    }
  }
  const image = nativeImage.createFromBitmap(buf, { width: size, height: size, scaleFactor: 2 });
  image.setTemplateImage(true);
  return image;
}

function broadcast(list: LocalRunnerStatus[]): void {
  updateTray(list);
  for (const win of BrowserWindow.getAllWindows()) win.webContents.send("runners:changed", list);
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => showWindow());

  app.whenReady().then(() => {
    settings = new SettingsFile(join(app.getPath("userData"), "settings.json"));
    // Set by the room server's install script, which knows the server it was downloaded from.
    const presetServer = app.commandLine.getSwitchValue("server-url");
    if (presetServer) settings.update({ serverUrl: normalizeServerUrl(presetServer) });
    runners = new RunnerManager({ hostScript: join(here, "runner-host.mjs"), logDir: join(app.getPath("userData"), "logs"), env: runnerEnv(), onChange: broadcast });

    ipcMain.handle("runners:list", guard(() => runners.list()));
    ipcMain.handle("runners:enable", guard((roomId: string, memberToken: string) => enableRunner(roomId, memberToken)));
    ipcMain.handle("runners:disable", guard((roomId: string) => disableRunner(roomId)));
    ipcMain.handle("settings:server-url", guard((url: string) => setServerUrl(url)));
    ipcMain.on("notify", (e, title: string, body: string, path: string) => {
      if (trusted(e)) notify(title, body, path);
    });

    tray = new Tray(trayIcon());
    tray.on("click", () => process.platform !== "darwin" && showWindow());
    updateTray([]);
    for (const roomId of settings.get().enabledRooms) runners.start(roomId);
    showWindow();
  });

  app.on("activate", () => showWindow());
  // Service managers and the install script ask the client to quit this way.
  process.on("SIGTERM", () => app.quit());

  app.on("before-quit", (e) => {
    if (quitting || !runners) return;
    quitting = true;
    e.preventDefault();
    void runners.stopAll().finally(() => app.quit());
  });
}

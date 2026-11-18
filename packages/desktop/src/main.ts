// Banyan desktop client: its own local workspace (a room server inside the client), a window
// onto that or a team room server, and the runners for the rooms this machine hosts.
// Closing the window keeps runners going in the tray; quitting stops them gracefully.
import { execFile } from "node:child_process";
import { homedir, hostname, userInfo } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { readSavedRunner, registerRunner } from "@banyan/runner/registration";
import type { LocalRunnerStatus } from "@banyan/shared";
import { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, nativeImage, Notification, screen, shell, Tray, type IpcMainEvent, type IpcMainInvokeEvent } from "electron";
import { contextMenuTemplate } from "./context-menu.ts";
import { ensureLocalWorkspace, startLocalServer, type LocalServer } from "./local-workspace.ts";
import { removeOldPastedImages, savePastedImage } from "./pasted-images.ts";
import { RunnerManager } from "./runner-manager.ts";
import { splitArgs } from "@banyan/runner/args";
import type { TerminalArgsLines } from "@banyan/shared";
import type { TerminalArgs } from "./host-protocol.ts";
import { DEFAULT_TERMINAL_ARGS, normalizeServerUrl, SettingsFile } from "./settings.ts";
import { loginShellPath } from "./shell-env.ts";
import { restorableBounds } from "./window-state.ts";

const here = import.meta.dirname;
const SETUP_URL = pathToFileURL(join(here, "setup.html")).href;
const zh = () => app.getLocale().startsWith("zh");
const DEFAULT_LOCAL_PORT = 7710;

// Lets a test or a second profile keep its client settings apart.
if (process.env.BANYAN_DESKTOP_DATA) app.setPath("userData", process.env.BANYAN_DESKTOP_DATA);

let window: BrowserWindow | null = null;
let tray: Tray | null = null;
let quitting = false;
let settings: SettingsFile;
let runners: RunnerManager;
let localServer: LocalServer;

function localUrl(): string {
  return `${localServer.url}/rooms/${settings.get().localWorkspace!.roomId}`;
}

// What the window shows on launch: whichever of the local workspace and the team server was
// open last.
function startUrl(): string {
  const { serverUrl, lastOpened } = settings.get();
  return lastOpened === "team" && serverUrl ? serverUrl : localUrl();
}

function originOf(url: string): string | null {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

function runnerEnv(): NodeJS.ProcessEnv {
  const path = process.platform === "win32" ? null : loginShellPath(process.env.SHELL ?? "/bin/zsh");
  return path ? { ...process.env, PATH: path } : { ...process.env };
}

function rememberWindowBounds(win: BrowserWindow): void {
  settings.update({ windowBounds: win.getNormalBounds() });
}

function showWindow(): BrowserWindow {
  if (window) {
    window.show();
    window.focus();
    return window;
  }
  const saved = restorableBounds(settings.get().windowBounds, screen.getAllDisplays().map((d) => d.workArea));
  const win = new BrowserWindow({
    ...(saved ?? { width: 1280, height: 840 }),
    minWidth: 720,
    minHeight: 480,
    title: "Banyan",
    webPreferences: { preload: join(here, "preload.cjs"), contextIsolation: true, sandbox: true },
  });
  // macOS reports moved and resized once a move or resize ends, so the file is not written
  // while dragging; hiding the window and quitting record the place too.
  const rememberBounds = () => rememberWindowBounds(win);
  win.on("close", (e) => {
    rememberBounds();
    if (quitting) return;
    e.preventDefault();
    win.hide();
  });
  win.on("closed", () => (window = null));
  win.on("moved", rememberBounds);
  win.on("resized", rememberBounds);
  win.webContents.on("context-menu", (_e, params) => {
    const template = contextMenuTemplate(params, zh(), { openExternal: (url) => void shell.openExternal(url), copyText: (text) => clipboard.writeText(text) });
    if (template.length > 0) Menu.buildFromTemplate(template).popup({ window: win });
  });
  // Links leaving the room server open in the system browser.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) void shell.openExternal(url);
    return { action: "deny" };
  });
  win.webContents.on("will-navigate", (e, url) => {
    if (url === SETUP_URL || originOf(url) === settings.get().serverUrl || originOf(url) === localServer.url) return;
    e.preventDefault();
    if (/^https?:/.test(url)) void shell.openExternal(url);
  });
  win.webContents.on("did-navigate", (_e, url) => {
    if (originOf(url) === localServer.url) settings.update({ lastOpened: "local" });
    else if (originOf(url) === settings.get().serverUrl) settings.update({ lastOpened: "team" });
  });
  window = win;
  void win.loadURL(startUrl());
  return win;
}

// Only pages of the local workspace, the configured team server and the setup page may use
// the bridge.
function trusted(e: IpcMainEvent | IpcMainInvokeEvent): boolean {
  const url = e.senderFrame?.url;
  if (!url) return false;
  return url === SETUP_URL || originOf(url) === settings.get().serverUrl || originOf(url) === localServer.url;
}

const fromLocalWorkspace = (e: IpcMainEvent | IpcMainInvokeEvent) => originOf(e.senderFrame?.url ?? "") === localServer.url;

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
  settings.update({ serverUrl, lastOpened: "team" });
  void showWindow().loadURL(serverUrl);
}

// serverUrl is the server of the page that asked, the local workspace's or the team's.
async function enableRunner(serverUrl: string, roomId: string, memberToken: string): Promise<void> {
  if (!readSavedRunner(roomId)) await registerRunner({ serverUrl, roomId, memberToken, hostname: hostname() });
  const enabled = settings.get().enabledRooms;
  if (!enabled.includes(roomId)) settings.update({ enabledRooms: [...enabled, roomId] });
  runners.start(roomId);
}

// The folder the person picks: the top level of its git repository when it is in one, so each
// agent gets a worktree; any other folder as it is. The dialog opens where they picked last,
// or at startIn.
async function pickRepository(startIn: string | null): Promise<string | null> {
  const defaultPath = startIn ? startIn.replace(/^~(?=$|\/)/, homedir()) : settings.get().lastRepoDir ?? undefined;
  const picked = await dialog.showOpenDialog(showWindow(), { properties: ["openDirectory"], title: zh() ? "选择目录" : "Choose a folder", ...(defaultPath ? { defaultPath } : {}) });
  const folder = picked.filePaths[0];
  if (picked.canceled || !folder) return null;
  const chosen = await promisify(execFile)("git", ["rev-parse", "--show-toplevel"], { cwd: folder, env: runnerEnv() }).then(
    ({ stdout }) => stdout.trim(),
    () => folder,
  );
  settings.update({ lastRepoDir: chosen });
  return chosen;
}

async function disableRunner(roomId: string): Promise<void> {
  settings.update({ enabledRooms: settings.get().enabledRooms.filter((r) => r !== roomId) });
  await runners.stop(roomId);
}

function notify(title: string, body: string, path: string): void {
  const n = new Notification({ title, body });
  n.on("click", () => {
    // Notifications come from the page on show, which is the one the path belongs to.
    const win = showWindow();
    const origin = originOf(win.webContents.getURL());
    if (origin) void win.loadURL(new URL(path, origin).href);
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
  // Both can arrive before the local workspace is up; the window opens once it is.
  app.on("second-instance", () => localServer && showWindow());

  app.whenReady().then(async () => {
    settings = new SettingsFile(join(app.getPath("userData"), "settings.json"));
    // Set by the room server's install script, which knows the server it was downloaded from.
    const presetServer = app.commandLine.getSwitchValue("server-url");
    if (presetServer) settings.update({ serverUrl: normalizeServerUrl(presetServer), lastOpened: "team" });
    runners = new RunnerManager({
      hostScript: join(here, "runner-host.mjs"),
      logDir: join(app.getPath("userData"), "logs"),
      env: runnerEnv(),
      terminalArgs: () => parseTerminalArgs(settings.get().terminalArgs),
      onChange: broadcast,
    });
    removeOldPastedImages(pastedImagesDir());
    try {
      await openLocalWorkspace();
    } catch (e) {
      dialog.showErrorBox("Banyan", `${zh() ? "无法启动本地工作区" : "Cannot start the local workspace"}: ${(e as Error).message}`);
      app.exit(1);
      return;
    }

    ipcMain.handle("runners:list", guard(() => runners.list()));
    ipcMain.handle("runners:enable", (e, roomId: string, memberToken: string) => {
      if (!trusted(e)) throw new Error("not allowed from this page");
      return enableRunner(originOf(e.senderFrame!.url)!, roomId, memberToken);
    });
    ipcMain.handle("runners:disable", guard((roomId: string) => disableRunner(roomId)));
    ipcMain.handle("settings:server-url", guard((url: string) => setServerUrl(url)));
    ipcMain.handle("local:workspace", (e) => (fromLocalWorkspace(e) ? settings.get().localWorkspace : null));
    ipcMain.handle("repo:pick", guard((startIn: string | null) => pickRepository(startIn)));
    ipcMain.handle("image:save", guard((data: ArrayBuffer, type: string) => savePastedImage(pastedImagesDir(), data, type)));
    ipcMain.handle("terminal-args:get", guard(() => ({ current: settings.get().terminalArgs, defaults: DEFAULT_TERMINAL_ARGS })));
    ipcMain.handle(
      "terminal-args:set",
      guard((lines: TerminalArgsLines) => {
        // Rejected before saving if a line does not parse.
        const args = parseTerminalArgs(lines);
        settings.update({ terminalArgs: { claude: lines.claude.trim(), codex: lines.codex.trim() } });
        runners.updateTerminalArgs(args);
      }),
    );
    ipcMain.on("terminal:open", (e, req: { roomId: string; agentId: string }) => {
      const port = e.ports[0];
      if (!port) return;
      if (!trusted(e)) {
        port.close();
        return;
      }
      runners.openTerminal(req.roomId, req.agentId, port);
    });
    ipcMain.on("open:local", (e) => {
      if (trusted(e)) void showWindow().loadURL(localUrl());
    });
    ipcMain.on("open:team", (e) => {
      if (trusted(e)) void showWindow().loadURL(settings.get().serverUrl ?? SETUP_URL);
    });
    ipcMain.on("notify", (e, title: string, body: string, path: string) => {
      if (trusted(e)) notify(title, body, path);
    });

    tray = new Tray(trayIcon());
    tray.on("click", () => process.platform !== "darwin" && showWindow());
    updateTray([]);
    for (const roomId of settings.get().enabledRooms) runners.start(roomId);
    showWindow();
  });

  app.on("activate", () => localServer && showWindow());
  // Service managers and the install script ask the client to quit this way.
  process.on("SIGTERM", () => app.quit());

  app.on("before-quit", (e) => {
    if (quitting || !runners) return;
    quitting = true;
    e.preventDefault();
    // Quitting destroys the window without a close event.
    if (window) rememberWindowBounds(window);
    void runners
      .stopAll()
      .then(() => {
        // The window goes before the server it shows, so the page never sees the server drop.
        for (const win of BrowserWindow.getAllWindows()) win.destroy();
        return localServer?.close();
      })
      .finally(() => app.quit());
  });
}

// Starts the local room server, creates the local workspace on first launch and runs its runner.
async function openLocalWorkspace(): Promise<void> {
  const port = process.env.BANYAN_LOCAL_PORT ? Number(process.env.BANYAN_LOCAL_PORT) : DEFAULT_LOCAL_PORT;
  localServer = await startLocalServer({ dataDir: app.getPath("userData"), webDir: join(here, "web"), port });
  const names = zh() ? { room: "本地", goal: "本地工作", owner: userInfo().username } : { room: "Local", goal: "Local work", owner: userInfo().username };
  const previous = settings.get().localWorkspace;
  const workspace = await ensureLocalWorkspace(localServer.url, previous, names);
  // A replaced workspace's runner is no longer started.
  if (previous && previous.roomId !== workspace.roomId) settings.update({ enabledRooms: settings.get().enabledRooms.filter((r) => r !== previous.roomId) });
  settings.update({ localWorkspace: workspace });
  await enableRunner(localServer.url, workspace.roomId, workspace.memberToken);
}

function parseTerminalArgs(lines: TerminalArgsLines): TerminalArgs {
  return { claude: splitArgs(lines.claude), codex: splitArgs(lines.codex) };
}

function pastedImagesDir(): string {
  return join(app.getPath("userData"), "pasted-images");
}


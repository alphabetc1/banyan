// Desktop client end to end: the built Electron app with its own local workspace, a real team
// room server serving the built UI, and the real runners the app hosts, driving real Claude
// Code and Codex agents (costs a little real API usage).
// Run with `pnpm --filter @banyan/desktop test:e2e`.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { hostname } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron, expect, test, type ElectronApplication, type Page } from "@playwright/test";
import { newId } from "@banyan/shared";
import { appendAsMember, createFork, draft, tempDir, TestServer, waitFor } from "../../runner/test/helpers.ts";

const APP_DIR = fileURLToPath(new URL(`../build/app-${process.arch}`, import.meta.url));
const WEB_DIR = fileURLToPath(new URL("../../web/dist", import.meta.url));

let server: TestServer;
let banyanHome: string;
let clientData: string;
let localPort: number;

// A port free right now, for the app's local workspace server.
function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const probe = createServer().listen(0, "127.0.0.1", () => {
      const { port } = probe.address() as { port: number };
      probe.close(() => resolve(port));
    });
  });
}

test.beforeAll(async () => {
  server = new TestServer(undefined, WEB_DIR);
  await server.start();
});

test.afterAll(async () => {
  await server.stop();
});

test.beforeEach(async () => {
  banyanHome = tempDir("desktop-home");
  clientData = tempDir("desktop-data");
  localPort = await freePort();
});

// Page output must stay clean: any console warning, error or uncaught exception fails the test.
const pageProblems: string[] = [];
// Apps a failed test left open are closed so they do not outlive the run.
const launched: ElectronApplication[] = [];
test.afterEach(async () => {
  await Promise.all(launched.splice(0).map((app) => app.close().catch(() => {})));
  expect(pageProblems).toEqual([]);
  pageProblems.length = 0;
});

async function launch(env: NodeJS.ProcessEnv = {}): Promise<{ app: ElectronApplication; page: Page }> {
  const app = await electron.launch({
    // English UI regardless of the machine's language, so the assertions can match text.
    args: [APP_DIR, "--lang=en-US"],
    env: { ...process.env, BANYAN_HOME: banyanHome, BANYAN_DESKTOP_DATA: clientData, BANYAN_LOCAL_PORT: String(localPort), ...env },
  });
  launched.push(app);
  const page = await app.firstWindow();
  page.on("console", (msg) => {
    if (msg.type() === "error" || msg.type() === "warning") pageProblems.push(`${msg.type()}: ${msg.text()}`);
  });
  page.on("pageerror", (err) => pageProblems.push(`uncaught: ${err.message}`));
  return { app, page };
}

const settingsFile = () => JSON.parse(readFileSync(join(clientData, "settings.json"), "utf8")) as { serverUrl: string | null; enabledRooms: string[]; localWorkspace: { roomId: string }; terminalArgs: { claude: string; codex: string }; windowBounds: { x: number; y: number; width: number; height: number } | null };

// The app opens on its local workspace; team rooms are reached through the room switcher.
async function connectAndCreateRoom(page: Page, fork = createFork()): Promise<string> {
  await expect(page.getByRole("heading", { name: "Agents" })).toBeVisible();
  await page.getByLabel("Room").selectOption({ label: "Team room server…" });
  await page.getByPlaceholder("http://banyan-host:7700").fill(server.base.replace("http://", ""));
  await page.getByRole("button", { name: /Connect/ }).click();
  await expect(page.getByRole("heading", { name: "Banyan" })).toBeVisible();
  await page.getByLabel("Room name").fill("desktop room");
  await page.getByLabel("Fork repository URL").fill(fork);
  await page.getByLabel("Room goal").fill("Make prefill faster");
  await page.getByLabel("Your name").fill("Rhett");
  await page.getByRole("button", { name: "Create a room" }).click();
  await page.waitForURL(/\/rooms\/[^/]+$/);
  return new URL(page.url()).pathname.split("/")[2]!;
}

// The transcript of an agent in the app's local workspace, oldest first.
async function localTranscript(localBase: string, roomId: string, agentId: string, token: string): Promise<{ kind: string; text: string }[]> {
  const res = await fetch(`${localBase}/api/rooms/${roomId}/agents/${agentId}/transcript?limit=200`, { headers: { authorization: `Bearer ${token}` } });
  const { events } = (await res.json()) as { events: { payload: { entries: { kind: string; text: string }[] } }[] };
  return [...events].reverse().flatMap((e) => e.payload.entries);
}

const lockPath = (roomId: string) => join(banyanHome, "rooms", roomId, "runner.lock");

const memberToken = (page: Page) => page.evaluate(() => (JSON.parse(localStorage.getItem("banyan.rooms")!) as { memberToken: string }[])[0]!.memberToken);

const savedRunner = (roomId: string) => JSON.parse(readFileSync(join(banyanHome, "rooms", roomId, "runner.json"), "utf8")) as { runnerId: string; serverUrl: string };

test("connects to a room server, hosts a runner, keeps it in the tray and restores it on launch", async () => {
  let { app, page } = await launch();
  const roomId = await connectAndCreateRoom(page);

  // Inside the client, the agent dialog points at the top-bar switch until a runner exists.
  await page.getByRole("button", { name: "New agent" }).click();
  await expect(page.getByText("No machine runs your agents in this room yet: click “Run agents on this machine” in the top bar first.")).toBeVisible();
  await page.getByRole("button", { name: "Cancel" }).click();
  await page.getByRole("button", { name: "Run agents on this machine" }).click();
  await expect(page.getByTestId("local-runner")).toHaveText("Local runner running");
  await page.getByRole("button", { name: "New agent" }).click();
  await expect(page.getByText(/No machine runs your agents/)).toHaveCount(0);
  // With one runner, there is nothing to choose: the field stays hidden and that runner is used.
  await expect(page.getByLabel("Your runner")).toHaveCount(0);
  await page.getByRole("button", { name: "Cancel" }).click();
  const saved = savedRunner(roomId);
  expect(saved.serverUrl).toBe(server.base);
  const state = await server.state(roomId, await memberToken(page));
  expect(state.runners[saved.runnerId]).toMatchObject({ hostname: hostname() });
  const runnerPid = Number(readFileSync(lockPath(roomId), "utf8"));
  expect(runnerPid).toBeGreaterThan(0);

  // Closing the window only hides it; the runner keeps going.
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.close());
  expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().map((w) => w.isVisible()))).toEqual([false]);
  expect(readFileSync(lockPath(roomId), "utf8")).toBe(String(runnerPid));

  // Quitting stops the runner gracefully, which releases its lock.
  await app.close();
  expect(existsSync(lockPath(roomId))).toBe(false);
  expect(readFileSync(join(clientData, "logs", `runner-${roomId}.log`), "utf8")).toContain(`runner ${saved.runnerId} connected to room ${roomId}`);

  // The next launch goes straight to the server and starts the room's runner again.
  ({ app, page } = await launch());
  await page.goto(`${server.base}/rooms/${roomId}`);
  await expect(page.getByTestId("local-runner")).toHaveText("Local runner running");
  await waitFor(() => existsSync(lockPath(roomId)), "runner lock after relaunch");

  await page.getByRole("button", { name: "Stop local runner" }).click();
  await expect(page.getByRole("button", { name: "Run agents on this machine" })).toBeVisible();
  expect(existsSync(lockPath(roomId))).toBe(false);
  // Only the local workspace's runner stays enabled.
  expect(settingsFile()).toMatchObject({ serverUrl: server.base, enabledRooms: [settingsFile().localWorkspace.roomId] });
  await app.close();
});

test("reports a room whose runner is already running elsewhere instead of starting a second one", async () => {
  const { app, page } = await launch();
  const roomId = await connectAndCreateRoom(page);
  // This test process stands in for a runner started from the CLI.
  mkdirSync(join(banyanHome, "rooms", roomId), { recursive: true });
  writeFileSync(lockPath(roomId), String(process.pid));
  await page.getByRole("button", { name: "Run agents on this machine" }).click();
  await expect(page.getByTestId("local-runner")).toHaveText("Local runner stopped with an error");
  await expect(page.getByText(`another runner (pid ${process.pid}) is already running for this room`)).toBeVisible();
  expect(readFileSync(lockPath(roomId), "utf8")).toBe(String(process.pid));
  await app.close();
});

test("rejects a room server address it cannot reach", async () => {
  const { app, page } = await launch();
  await page.getByLabel("Room").selectOption({ label: "Team room server…" });
  await page.getByPlaceholder("http://banyan-host:7700").fill("127.0.0.1:9");
  await page.getByRole("button", { name: /Connect/ }).click();
  await expect(page.getByRole("alert")).toContainText("cannot reach http://127.0.0.1:9");
  expect(settingsFile().serverUrl).toBeNull();
  await app.close();
});

test("copies text out of a terminal, including from programs that take the mouse", async () => {
  const { app, page } = await launch();
  const clipboard = () => app.evaluate(({ clipboard }) => clipboard.readText());
  const setClipboard = (text: string) => app.evaluate(({ clipboard }, t) => clipboard.writeText(t), text);
  const saved = await clipboard();
  try {
    await page.getByRole("button", { name: "New agent" }).click();
    await page.getByRole("radio", { name: "Terminal" }).click();
    await page.getByLabel(/^Folder on the runner's machine/).fill(tempDir("copy-folder"));
    await page.getByLabel("Agent name").fill("copy-shell");
    await page.getByRole("button", { name: "Create" }).click();
    await page.getByTestId("agent-row-copy-shell").click();
    const terminal = page.getByTestId("terminal");
    await expect(terminal.locator(".xterm-rows")).toContainText("$", { timeout: 30_000 });
    await terminal.click();

    // Claude Code and Codex copy what the person selects in them with an OSC 52 sequence.
    await setClipboard("<nothing>");
    const encoded = Buffer.from("copied 复制").toString("base64");
    await page.keyboard.type(`printf '\\033]52;c;${encoded}\\a'\n`);
    await expect.poll(clipboard).toBe("copied 复制");
    // A program asking to read the clipboard gets nothing and changes nothing.
    await page.keyboard.type(`printf '\\033]52;c;?\\a'; echo READ-ASKED\n`);
    await expect(terminal.locator(".xterm-rows")).toContainText("READ-ASKED");
    expect(await clipboard()).toBe("copied 复制");

    // With the mouse taken, as Codex and Claude Code do, a plain drag goes to the program and an
    // Option-drag still selects.
    await page.keyboard.type(`printf '\\033[?1000h\\033[?1002h\\033[?1006h'; echo SELECT-ME\n`);
    await expect(terminal.locator(".xterm-rows")).toContainText("SELECT-ME");
    const box = (await terminal.boundingBox())!;
    const dragAndCopy = async (option: boolean) => {
      await setClipboard("<nothing>");
      if (option) await page.keyboard.down("Alt");
      await page.mouse.move(box.x + 12, box.y + 12);
      await page.mouse.down();
      await page.mouse.move(box.x + box.width - 12, box.y + box.height - 12, { steps: 10 });
      await page.mouse.up();
      if (option) await page.keyboard.up("Alt");
      // What Edit > Copy (Cmd+C) does.
      await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.webContents.copy());
      await page.waitForTimeout(300);
      return clipboard();
    };
    expect(await dragAndCopy(false)).toBe("<nothing>");
    expect(await dragAndCopy(true)).toContain("SELECT-ME");
  } finally {
    await setClipboard(saved);
    await app.close();
  }
});

test("opens a terminal's links in the browser, keeps Shift+Enter plain outside Claude Code, and offers a right-click menu", async () => {
  const { app, page } = await launch();
  // Links go to the system browser; recorded here instead.
  await app.evaluate(({ shell }) => {
    (globalThis as { opened?: string[] }).opened = [];
    shell.openExternal = async (url: string) => void (globalThis as { opened?: string[] }).opened!.push(url);
  });
  const opened = () => app.evaluate(() => (globalThis as { opened?: string[] }).opened);
  // A native menu would block the app until dismissed, and cannot be clicked from a test: menus
  // are still built (the tray needs real ones) but not shown, and their items are recorded.
  await app.evaluate(({ Menu }) => {
    (globalThis as { menus?: string[][] }).menus = [];
    const build = Menu.buildFromTemplate.bind(Menu);
    Menu.buildFromTemplate = (template) => {
      (globalThis as { menus?: string[][] }).menus!.push(template.map((i) => (i.type === "separator" ? "-" : `${i.label}${i.enabled === false ? " (disabled)" : ""}`)));
      const menu = build(template);
      menu.popup = () => {};
      return menu;
    };
  });
  const menus = () => app.evaluate(() => (globalThis as { menus?: string[][] }).menus);

  const contextMenus = async () => (await menus())!.filter((m) => m.includes("Paste") || m.includes("Copy"));
  await page.getByRole("button", { name: "New agent" }).click();
  await page.getByLabel("Agent name").click({ button: "right" });
  await expect.poll(contextMenus).toEqual([["Cut (disabled)", "Copy (disabled)", "Paste", "-", "Select All (disabled)"]]);
  await page.getByRole("radio", { name: "Terminal" }).click();
  await page.getByLabel(/^Folder on the runner's machine/).fill(tempDir("links-folder"));
  await page.getByLabel("Agent name").fill("links-shell");
  await page.getByRole("button", { name: "Create" }).click();
  await page.getByTestId("agent-row-links-shell").click();
  const terminal = page.getByTestId("terminal");
  await expect(terminal.locator(".xterm-rows")).toContainText("$", { timeout: 30_000 });
  await terminal.click();

  // In a plain shell Shift+Enter is an ordinary Enter; the bytes the shell receives are recorded.
  const keys = join(tempDir("keys"), "bytes");
  await page.keyboard.type(`stty raw -echo; dd bs=1 count=4 of=${keys} 2>/dev/null; stty sane\n`);
  await page.waitForTimeout(800);
  await page.keyboard.press("Shift+Enter");
  await page.keyboard.type("|x|");
  await expect.poll(() => (existsSync(keys) ? readFileSync(keys, "latin1") : "")).toBe("\r|x|");

  // A plain URL and a link a program marks (OSC 8), with the mouse free and then taken by the
  // program, as Claude Code and Codex take it.
  const clickLine = async (text: string) => {
    const line = (await terminal.locator(".xterm-rows > div", { hasText: text }).first().boundingBox())!;
    await page.mouse.move(line.x + 25, line.y + line.height / 2);
    await page.waitForTimeout(300);
    await page.mouse.down();
    await page.mouse.up();
  };
  await page.keyboard.type(`clear; printf 'https://example.com/plain\\n\\033]8;;https://example.com/marked\\aMARKED-LINK\\033]8;;\\a\\n'\n`);
  await expect(terminal.locator(".xterm-rows")).toContainText("MARKED-LINK");
  await clickLine("example.com/plain");
  await clickLine("MARKED-LINK");
  await expect.poll(opened).toEqual(["https://example.com/plain", "https://example.com/marked"]);
  await page.keyboard.type(`clear; printf '\\033[?1000h\\033[?1006h'; printf 'https://example.com/taken\\n'\n`);
  await expect(terminal.locator(".xterm-rows")).toContainText("example.com/taken");
  await clickLine("example.com/taken");
  await expect.poll(opened).toEqual(["https://example.com/plain", "https://example.com/marked", "https://example.com/taken"]);
  // Other schemes are not opened.
  await page.keyboard.type(`printf '\\033[?1000l'; clear; printf '\\033]8;;file:///etc/hosts\\aFILE-LINK\\033]8;;\\a\\n'\n`);
  await expect(terminal.locator(".xterm-rows")).toContainText("FILE-LINK");
  await clickLine("FILE-LINK");
  await page.waitForTimeout(500);
  expect(await opened()).toHaveLength(3);

  // Right-clicking selected terminal text offers to copy it.
  const first = (await terminal.locator(".xterm-rows > div", { hasText: "FILE-LINK" }).first().boundingBox())!;
  await page.mouse.move(first.x + 2, first.y + first.height / 2);
  await page.mouse.down();
  await page.mouse.move(first.x + 60, first.y + first.height / 2, { steps: 5 });
  await page.mouse.up();
  await page.mouse.click(first.x + 30, first.y + first.height / 2, { button: "right" });
  await expect.poll(async () => (await contextMenus()).at(-1)).toEqual(["Cut", "Copy", "Paste", "-", "Select All"]);
  // Typing goes on as usual afterwards.
  await terminal.click();
  await page.keyboard.type("echo AFTER-$((1+2))\n");
  await expect(terminal.locator(".xterm-rows")).toContainText("AFTER-3");

  await app.close();
});

test("opens the window where the person left it", async () => {
  let { app } = await launch();
  const bounds = { x: 140, y: 160, width: 1000, height: 700 };
  await app.evaluate(({ BrowserWindow }, b) => BrowserWindow.getAllWindows()[0]!.setBounds(b), bounds);
  await app.close();
  expect(settingsFile().windowBounds).toEqual(bounds);
  ({ app } = await launch());
  expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.getBounds())).toEqual(bounds);
  await app.close();
});

test("opens a local workspace on first launch and runs agents in a repository on this machine", async () => {
  test.setTimeout(10 * 60_000);
  // A repository of the person's own, on a feature branch, with a remote of its own.
  const remote = createFork();
  const repo = join(tempDir("own-repo"), "repo");
  execFileSync("git", ["clone", "-q", remote, repo]);
  execFileSync("git", ["checkout", "-q", "-b", "feature"], { cwd: repo });

  let { app, page } = await launch();
  const localBase = `http://127.0.0.1:${localPort}`;
  await expect(page.getByRole("heading", { name: "Agents" })).toBeVisible();
  const roomId = settingsFile().localWorkspace.roomId;
  await expect(page).toHaveURL(`${localBase}/rooms/${roomId}`);
  await expect(page.getByLabel("Room").locator("option:checked")).toHaveText("Local");
  // Coordination pages are left out of a personal workspace.
  await expect(page.getByRole("link", { name: "Worktrees" })).toBeVisible();
  for (const name of ["Goals", "Findings", "Coordination"]) await expect(page.getByRole("link", { name })).toHaveCount(0);
  await expect(page.getByTestId("local-runner")).toHaveText("Local runner running");

  await page.getByRole("button", { name: "New agent" }).click();
  const repoField = page.getByLabel(/^Folder on the runner's machine/);
  await expect(repoField).toHaveAttribute("required", "");
  await repoField.fill(repo);
  await page.getByLabel("Agent name").fill("local-worker");
  // A managed session here (the terminal has its own test), which starts on its instructions.
  await page.getByText("Coordination (goal · group · role)").click();
  await page.getByLabel(/Managed, without a terminal/).check();
  await expect(page.getByLabel("Instructions")).toHaveAttribute("required", "");
  await page.getByLabel("Instructions").fill("Reply with exactly the word LOCAL-OK and nothing else.");
  await page.getByRole("button", { name: "Create" }).click();
  await expect(page.getByTestId("agent-row-local-worker")).toBeVisible();

  const token = await memberToken(page);
  const state = async () => {
    const res = await fetch(`${localBase}/api/rooms/${roomId}/state`, { headers: { authorization: `Bearer ${token}` } });
    return ((await res.json()) as { state: import("@banyan/shared").RoomState }).state;
  };
  const agent = await waitFor(async () => Object.values((await state()).agents).find((x) => x.name === "local-worker"), "the local agent");
  // A plain session: it answers its first message, with no Banyan coordination around it.
  const texts = await waitFor(async () => {
    const t = await localTranscript(localBase, roomId, agent.id, token);
    return t.some((e) => e.kind === "assistant" && e.text.includes("LOCAL-OK")) ? t : null;
  }, "the local agent's reply", 5 * 60_000, 1000);
  expect(texts.some((e) => e.text.includes("room_"))).toBe(false);
  expect((await state()).agents[agent.id]).toMatchObject({ repoPath: repo, groupId: null });
  const worktreePath = join(banyanHome, "rooms", roomId, "worktrees", agent.id);
  expect(execFileSync("git", ["worktree", "list"], { cwd: repo, encoding: "utf8" })).toContain(worktreePath);
  expect(execFileSync("git", ["ls-remote", "--heads", remote], { encoding: "utf8" })).not.toContain("banyan/");

  // The workspace and its agent are still there after a restart.
  await app.close();
  ({ app, page } = await launch());
  await expect(page).toHaveURL(`${localBase}/rooms/${roomId}`);
  await expect(page.getByTestId("agent-row-local-worker")).toBeVisible();
  expect(settingsFile().localWorkspace.roomId).toBe(roomId);
  await app.close();
});

// Proves the runner inside the app finds the Claude SDK's bundled executable and the user's
// codex on the login shell PATH, and drives both through the Room MCP.
test("runs real standalone Claude and Codex agents from the app's runner", async () => {
  test.setTimeout(10 * 60_000);
  // The minimal PATH an app launched from the Dock gets, without where codex is installed.
  const { app, page } = await launch({ PATH: "/usr/bin:/bin:/usr/sbin:/sbin" });
  const roomId = await connectAndCreateRoom(page);
  await page.getByRole("button", { name: "Run agents on this machine" }).click();
  await expect(page.getByTestId("local-runner")).toHaveText("Local runner running");
  const token = await memberToken(page);
  const { runnerId } = savedRunner(roomId);
  const rootGoalId = (await server.state(roomId, token)).room!.rootGoalId;
  const agents = { claude: newId(), codex: newId() };
  await appendAsMember(server, roomId, token, [
    ...(["claude", "codex"] as const).map((provider) =>
      draft("agent.created", {
        agentId: agents[provider],
        groupId: null,
        runnerId,
        name: `${provider} worker`,
        role: "worker",
        provider,
        model: "default",
        goalId: rootGoalId,
        instructions: 'This is an automated test of Banyan. Call room_set_status with phase "done", then reply DONE. Do nothing else.',
      }),
    ),
  ]);
  for (const provider of ["claude", "codex"] as const) {
    const agent = await waitFor(async () => {
      const a = (await server.state(roomId, token)).agents[agents[provider]];
      return a?.phase?.value === "done" ? a : null;
    }, `${provider} agent reporting done`, 5 * 60_000, 1000);
    expect(agent.providerSessionId).toBeTruthy();
  }
  await app.close();
  expect(existsSync(lockPath(roomId))).toBe(false);
});

// Every process descended from pid, from `ps`.
function descendants(pid: number): number[] {
  const rows = execFileSync("ps", ["-A", "-o", "pid=,ppid="], { encoding: "utf8" })
    .trim()
    .split("\n")
    .map((line) => line.trim().split(/\s+/).map(Number) as [number, number]);
  const found: number[] = [];
  const queue = [pid];
  while (queue.length > 0) {
    const parent = queue.shift()!;
    for (const [child, ppid] of rows) {
      if (ppid === parent) {
        found.push(child);
        queue.push(child);
      }
    }
  }
  return found;
}

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

// Newest first, as the server pages them.
async function transcriptTexts(roomId: string, agentId: string, token: string): Promise<string[]> {
  const res = await fetch(`${server.base}/api/rooms/${roomId}/agents/${agentId}/transcript?limit=200`, { headers: { authorization: `Bearer ${token}` } });
  const { events } = (await res.json()) as { events: { payload: { entries: { text: string }[] } }[] };
  return events.flatMap((e) => e.payload.entries.map((x) => x.text));
}

test("keeps every agent's history through a runner crash and a relaunch, and resumes the sessions", async () => {
  test.setTimeout(15 * 60_000);
  let { app, page } = await launch();
  const roomId = await connectAndCreateRoom(page);
  await page.getByRole("button", { name: "Run agents on this machine" }).click();
  await expect(page.getByTestId("local-runner")).toHaveText("Local runner running");
  const token = await memberToken(page);
  const { runnerId } = savedRunner(roomId);
  const rootGoalId = (await server.state(roomId, token)).room!.rootGoalId;
  const groupId = newId();
  const agents = { claude: newId(), codex: newId() };
  const instructions = `This is an automated test of Banyan. Do exactly these steps:
1. Call room_set_status with phase "before-crash".
2. Run the shell command: sleep 60
3. Call room_set_status with phase "after-crash".
Then reply DONE.`;
  await appendAsMember(server, roomId, token, [
    draft("group.created", { groupId, goalId: rootGoalId, name: "crash e2e" }),
    ...(["claude", "codex"] as const).map((provider) =>
      draft("agent.created", { agentId: agents[provider], groupId, runnerId, name: `${provider} worker`, role: "worker", provider, model: "default", goalId: rootGoalId, instructions }),
    ),
  ]);
  const phase = async (provider: "claude" | "codex") => (await server.state(roomId, token)).agents[agents[provider]]?.phase?.value;
  for (const provider of ["claude", "codex"] as const) {
    await waitFor(async () => (await phase(provider)) === "before-crash", `${provider} reaching before-crash`, 5 * 60_000, 500);
  }
  const before = {
    claude: await transcriptTexts(roomId, agents.claude, token),
    codex: await transcriptTexts(roomId, agents.codex, token),
  };
  const sessions = Object.fromEntries(
    await Promise.all((["claude", "codex"] as const).map(async (p) => [p, (await server.state(roomId, token)).agents[agents[p]]!.providerSessionId] as const)),
  );

  // Hard-kill the runner while both agents are mid-turn.
  const runnerPid = Number(readFileSync(lockPath(roomId), "utf8"));
  const children = descendants(runnerPid);
  expect(children.length).toBeGreaterThan(0);
  process.kill(runnerPid, "SIGKILL");
  await expect(page.getByTestId("local-runner")).toHaveText("Local runner stopped with an error");
  await expect(page.getByText(/runner exited unexpectedly/)).toBeVisible();
  // Agents must not keep running unsupervised.
  await waitFor(() => children.every((pid) => !alive(pid)), "agent processes to end with the runner", 30_000);
  // No automatic restart.
  await page.waitForTimeout(8000);
  await expect(page.getByTestId("local-runner")).toHaveText("Local runner stopped with an error");
  for (const provider of ["claude", "codex"] as const) {
    expect(await transcriptTexts(roomId, agents[provider], token)).toEqual(expect.arrayContaining(before[provider]));
  }

  // Quit and open the app again: the runner starts, the history is all there, and both agents
  // continue their original sessions.
  await app.close();
  ({ app, page } = await launch());
  await page.goto(`${server.base}/rooms/${roomId}/agents/${agents.claude}`);
  await expect(page.getByTestId("local-runner")).toHaveText("Local runner running");
  // Reaching step 3 is read from the transcript rather than the current phase, which an agent
  // may move past on its own (Codex sometimes reports "done" right after).
  const reportedAfterCrash = async (provider: "claude" | "codex") => (await transcriptTexts(roomId, agents[provider], token)).some((t) => /room_set_status .*"phase":"after-crash"/.test(t));
  for (const provider of ["claude", "codex"] as const) {
    await waitFor(() => reportedAfterCrash(provider), `${provider} reaching after-crash`, 5 * 60_000, 1000).catch(async (e: Error) => {
      // What the agent was doing, so a timeout explains itself.
      const a = (await server.state(roomId, token)).agents[agents[provider]]!;
      const recent = (await transcriptTexts(roomId, agents[provider], token)).slice(0, 8);
      throw new Error(`${e.message}: ${JSON.stringify({ process: a.process, detail: a.processDetail, activity: a.activity, phase: a.phase?.value, recent })}`);
    });
    const agent = (await server.state(roomId, token)).agents[agents[provider]]!;
    expect(agent.providerSessionId).toBe(sessions[provider]);
    const after = await transcriptTexts(roomId, agents[provider], token);
    expect(after.slice(-before[provider].length)).toEqual(before[provider]);
    expect(after).toContain("resuming session");
  }
  for (const text of before.claude.filter((t) => t.trim().length > 0).slice(0, 3)) {
    await expect(page.getByText(text, { exact: false }).first()).toBeVisible();
  }
  await app.close();
});

// A project skill as Claude Code reads it from .claude/skills/<name>/SKILL.md.
const skill = (name: string, phase: string) => `---
name: ${name}
description: Banyan end-to-end test skill. Use it only when asked to.
---
Call the room_set_status tool with phase "${phase}". Then reply DONE and do nothing else.
`;

test("gives Claude agents the user's Claude Code setup, including skills started from the composer", async () => {
  test.setTimeout(10 * 60_000);
  const fork = createFork({
    ".claude/skills/banyan-probe/SKILL.md": skill("banyan-probe", "tangerine-42"),
    ".claude/skills/banyan-slash/SKILL.md": skill("banyan-slash", "papaya-7"),
  });
  const { page } = await launch();
  const roomId = await connectAndCreateRoom(page, fork);
  await page.getByRole("button", { name: "Run agents on this machine" }).click();
  await expect(page.getByTestId("local-runner")).toHaveText("Local runner running");
  const token = await memberToken(page);
  const { runnerId } = savedRunner(roomId);
  const rootGoalId = (await server.state(roomId, token)).room!.rootGoalId;
  const agentId = newId();
  await appendAsMember(server, roomId, token, [
    draft("agent.created", {
      agentId,
      groupId: null,
      runnerId,
      name: "skilled",
      role: "worker",
      provider: "claude",
      model: "default",
      goalId: rootGoalId,
      instructions: "This is an automated test of Banyan. Use the banyan-probe skill and do exactly what it says. Then wait for further messages.",
    }),
  ]);
  const phase = async () => (await server.state(roomId, token)).agents[agentId]?.phase?.value;
  await waitFor(async () => (await phase()) === "tangerine-42", "the agent using the banyan-probe skill", 5 * 60_000, 1000);

  // A slash command typed into the composer starts the skill, as it would in claude itself.
  await page.getByTestId("agent-row-skilled").click();
  await page.getByPlaceholder("Message this agent…").fill("/banyan-slash");
  await page.getByRole("button", { name: "Send" }).click();
  await waitFor(async () => (await phase()) === "papaya-7", "the agent running /banyan-slash", 5 * 60_000, 1000);
  // The person's own message is part of the conversation.
  await expect(page.locator(".entry.user", { hasText: "/banyan-slash" })).toContainText("Rhett");
  await expect(page.getByTestId("pending-message")).toHaveCount(0);
});

test("runs a Claude agent in its own terminal inside the window, typed into like Claude Code itself", async () => {
  test.setTimeout(10 * 60_000);
  const repo = join(tempDir("term-repo"), "repo");
  execFileSync("git", ["clone", "-q", createFork(), repo]);
  const { page } = await launch();
  const localBase = `http://127.0.0.1:${localPort}`;
  const roomId = settingsFile().localWorkspace.roomId;
  await expect(page.getByTestId("local-runner")).toHaveText("Local runner running");

  // Launch arguments sit behind the small settings button: by default they skip permission
  // prompts; a changed line applies to terminals started afterwards.
  await page.getByRole("button", { name: "Terminal launch arguments" }).click();
  const claudeArgs = page.getByRole("dialog").getByLabel("Claude Code");
  await expect(claudeArgs).toHaveValue("--dangerously-skip-permissions");
  await expect(page.getByRole("dialog").getByLabel("Codex")).toHaveValue("--yolo --sandbox danger-full-access");
  await claudeArgs.fill("--dangerously-skip-permissions --name 'e2e session");
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.getByRole("dialog")).toContainText("unclosed ' in");
  await claudeArgs.fill("--dangerously-skip-permissions --name 'banyan e2e'");
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  expect(settingsFile().terminalArgs).toEqual({ claude: "--dangerously-skip-permissions --name 'banyan e2e'", codex: "--yolo --sandbox danger-full-access" });

  await page.getByRole("button", { name: "New agent" }).click();
  // By default: Claude Code in its own terminal, nothing to fill but a name and a repository.
  await expect(page.getByRole("radio", { name: "Claude Code" })).toHaveAttribute("aria-checked", "true");
  await page.getByLabel(/^Folder on the runner's machine/).fill(repo);
  await page.getByLabel("Agent name").fill("term-agent");
  await page.getByRole("button", { name: "Create" }).click();
  await page.getByTestId("agent-row-term-agent").click();
  const terminal = page.getByTestId("terminal");
  await expect(terminal).toBeVisible();
  await expect(page.getByTestId("transcript")).toHaveCount(0);
  // The terminal takes the full width; details open on request.
  await expect(page.locator(".facts")).toHaveCount(0);
  await page.getByRole("button", { name: "Details" }).click();
  await expect(page.locator(".facts")).toContainText("Standalone");
  await page.getByRole("button", { name: "Details" }).click();
  await expect(page.locator(".facts")).toHaveCount(0);

  const token = await memberToken(page);
  const agentState = async () => {
    const res = await fetch(`${localBase}/api/rooms/${roomId}/state`, { headers: { authorization: `Bearer ${token}` } });
    const state = ((await res.json()) as { state: import("@banyan/shared").RoomState }).state;
    return Object.values(state.agents).find((a) => a.name === "term-agent");
  };
  // The repository is in a folder Claude Code has never trusted; the person answers in the
  // terminal, and the list shows a raised hand meanwhile.
  const icon = page.getByTestId("agent-row-term-agent").locator("[data-icon]");
  await expect(terminal).toContainText(/trust this folder/i, { timeout: 60_000 });
  await expect(icon).toHaveAttribute("data-icon", "needs_you");
  await terminal.click();
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  // Then Claude Code waits at its prompt, with nothing sent to it by Banyan.
  await expect(icon).toHaveAttribute("data-icon", "done", { timeout: 60_000 });
  const agentId = (await agentState())!.id;
  const transcript = () => localTranscript(localBase, roomId, agentId, token);
  // Claude Code runs with the saved arguments, as the operating system shows them.
  const processLines = readFileSync(join(banyanHome, "rooms", roomId, "agent-processes"), "utf8").split("\n").filter(Boolean);
  const commandLines = processLines.map((l) => execFileSync("ps", ["-o", "args=", "-p", String((JSON.parse(l) as { pid: number }).pid)], { encoding: "utf8" }));
  expect(commandLines.some((c) => c.includes("--dangerously-skip-permissions --name banyan e2e --session-id"))).toBe(true);
  expect((await transcript()).filter((e) => e.kind === "user")).toEqual([]);

  // Typing into the terminal talks to Claude Code directly; the list follows its turn.
  await terminal.click();
  // Shift+Enter starts a new line in Claude Code's prompt instead of sending it.
  await page.keyboard.type("Reply with exactly the word TYPED-OK");
  await page.keyboard.press("Shift+Enter");
  await page.keyboard.type("and nothing else.");
  await page.keyboard.press("Enter");
  await waitFor(async () => (await transcript()).some((e) => e.kind === "assistant" && e.text.includes("TYPED-OK")), "the agent acting on typed input", 5 * 60_000, 1000);
  await expect(terminal).toContainText("TYPED-OK");
  await expect(icon).toHaveAttribute("data-icon", "done");
  // A plain session: Claude Code got just what the person typed, without Banyan's coordination.
  expect((await transcript()).filter((e) => e.kind === "user").map((e) => e.text)).toEqual(["Reply with exactly the word TYPED-OK\nand nothing else."]);

  // An image pasted with the usual shortcut goes in as a saved file, which Claude Code attaches.
  await terminal.click();
  await page.evaluate(() => {
    // An 8x8 PNG, as a screenshot would arrive on the clipboard.
    const png = Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAAEklEQVR4nGP4z8CAFWEXHbQSACj/P8Fu7N9hAAAAAElFTkSuQmCC"), (c) => c.charCodeAt(0));
    const data = new DataTransfer();
    data.items.add(new File([png], "screenshot.png", { type: "image/png" }));
    document.querySelector("[data-testid=terminal] textarea")!.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }));
  });
  await expect(terminal).toContainText(/\[Image ?#1\]/, { timeout: 15_000 });
  const saved = readdirSync(join(clientData, "pasted-images"));
  expect(saved).toHaveLength(1);
  expect(saved[0]).toMatch(/\.png$/);

  // A fork from the list carries the conversation on, in a session and worktree of its own.
  const sourceSession = (await agentState())!.providerSessionId;
  await page.getByTestId("agent-row-term-agent").click({ button: "right" });
  await page.getByRole("menuitem", { name: "Fork" }).click();
  await expect(page.locator(".agent-main h2")).toHaveText("term-agent-fork");
  const forkIcon = page.getByTestId("agent-row-term-agent-fork").locator("[data-icon]");
  const forkTerminal = page.getByTestId("terminal");
  // It opens on the conversation so far, on its own branch; its worktree belongs to a
  // repository Claude Code already trusts, so it asks nothing.
  await expect(forkTerminal).toContainText("TYPED-OK", { timeout: 60_000 });
  await expect(forkTerminal).toContainText("term-agent-fork");
  await expect(forkTerminal).not.toContainText(/trust this folder/i);
  await expect(forkIcon).toHaveAttribute("data-icon", "done", { timeout: 60_000 });
  await forkTerminal.click();
  await page.keyboard.type("Which word did you reply with before? Reply with that word followed by -FORK and nothing else.");
  await page.keyboard.press("Enter");
  const fork = Object.values((await (await fetch(`${localBase}/api/rooms/${roomId}/state`, { headers: { authorization: `Bearer ${token}` } })).json() as { state: import("@banyan/shared").RoomState }).state.agents).find((a) => a.name === "term-agent-fork")!;
  await waitFor(async () => (await localTranscript(localBase, roomId, fork.id, token)).some((e) => e.kind === "assistant" && e.text.includes("TYPED-OK-FORK")), "the fork remembering the conversation", 5 * 60_000, 1000);
  expect((await agentState())!.providerSessionId).toBe(sourceSession);
  expect(fork.providerSessionId).toMatch(/^[0-9a-f-]{36}$/);
  expect(fork.providerSessionId).not.toBe(sourceSession);
  expect(fork.forkOf).toBe(agentId);
  await page.getByTestId("agent-row-term-agent").click();

  // The next agent starts in the same repository, and a plain terminal runs the person's shell.
  await page.getByRole("button", { name: "New agent" }).click();
  await expect(page.getByLabel(/^Folder on the runner's machine/)).toHaveValue(repo);
  await page.getByRole("radio", { name: "Terminal" }).click();
  await expect(page.getByText("Coordination (goal · group · role)")).toHaveCount(0);
  await page.getByLabel("Agent name").fill("shell");
  await page.getByRole("button", { name: "Create" }).click();
  await page.getByTestId("agent-row-shell").click();
  await expect(page.getByTestId("agent-row-shell").locator("[data-icon]")).toHaveAttribute("data-icon", "terminal", { timeout: 60_000 });
  const shellTerminal = page.getByTestId("terminal");
  await shellTerminal.click();
  await page.keyboard.type("echo BANYAN-$((40+2))");
  await page.keyboard.press("Enter");
  await expect(shellTerminal).toContainText("BANYAN-42");

  // Exiting the shell leaves a closed terminal that can be started again, or removed.
  await page.keyboard.type("exit");
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("terminal-restart")).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId("agent-row-shell").locator("[data-icon]")).toHaveAttribute("data-icon", "stopped");
  await page.getByTestId("terminal-restart").click();
  await expect(page.getByTestId("agent-row-shell").locator("[data-icon]")).toHaveAttribute("data-icon", "terminal", { timeout: 30_000 });
  await expect(page.getByTestId("terminal-restart")).toHaveCount(0);
  await page.getByTestId("terminal").click();
  await page.keyboard.type("echo AGAIN-$((1+1))");
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("terminal")).toContainText("AGAIN-2");
  await page.getByRole("button", { name: "Remove" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Remove" }).click();
  await expect(page.getByTestId("agent-row-shell")).toHaveCount(0);

  // A folder that is not a git repository (one holding several, say) is used as it is.
  const folder = tempDir("plain-folder");
  await page.getByRole("button", { name: "New agent" }).click();
  await page.getByRole("radio", { name: "Terminal" }).click();
  await page.getByLabel(/^Folder on the runner's machine/).fill(folder);
  await page.getByLabel("Agent name").fill("in-folder");
  await page.getByRole("button", { name: "Create" }).click();
  await page.getByTestId("agent-row-in-folder").click();
  await expect(page.getByTestId("agent-row-in-folder").locator("[data-icon]")).toHaveAttribute("data-icon", "terminal", { timeout: 30_000 });
  await page.getByTestId("terminal").click();
  await page.keyboard.type("pwd -P");
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("terminal")).toContainText(realpathSync(folder));
  await expect(page.getByTestId("agent-row-term-agent")).toBeVisible();
});

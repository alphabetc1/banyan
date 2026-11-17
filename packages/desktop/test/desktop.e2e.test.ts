// Desktop client end to end: the built Electron app with its own local workspace, a real team
// room server serving the built UI, and the real runners the app hosts, driving real Claude
// Code and Codex agents (costs a little real API usage).
// Run with `pnpm --filter @banyan/desktop test:e2e`.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
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

const settingsFile = () => JSON.parse(readFileSync(join(clientData, "settings.json"), "utf8")) as { serverUrl: string | null; enabledRooms: string[]; localWorkspace: { roomId: string } };

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
  const repoField = page.getByLabel("Repository on the runner's machine");
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
  for (const provider of ["claude", "codex"] as const) {
    await waitFor(async () => (await phase(provider)) === "after-crash", `${provider} reaching after-crash`, 5 * 60_000, 1000);
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

  await page.getByRole("button", { name: "New agent" }).click();
  // By default: Claude Code in its own terminal, nothing to fill but a name and a repository.
  await expect(page.getByRole("radio", { name: "Claude Code" })).toHaveAttribute("aria-checked", "true");
  await page.getByLabel("Repository on the runner's machine").fill(repo);
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
  expect((await transcript()).filter((e) => e.kind === "user")).toEqual([]);

  // Typing into the terminal talks to Claude Code directly; the list follows its turn.
  await terminal.click();
  await page.keyboard.type("Reply with exactly the word TYPED-OK and nothing else.");
  await page.keyboard.press("Enter");
  await waitFor(async () => (await transcript()).some((e) => e.kind === "assistant" && e.text.includes("TYPED-OK")), "the agent acting on typed input", 5 * 60_000, 1000);
  await expect(terminal).toContainText("TYPED-OK");
  await expect(icon).toHaveAttribute("data-icon", "done");
  // A plain session: Claude Code got just what the person typed, without Banyan's coordination.
  expect((await transcript()).filter((e) => e.kind === "user").map((e) => e.text)).toEqual(["Reply with exactly the word TYPED-OK and nothing else."]);

  // The next agent starts in the same repository, and a plain terminal runs the person's shell.
  await page.getByRole("button", { name: "New agent" }).click();
  await expect(page.getByLabel("Repository on the runner's machine")).toHaveValue(repo);
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
  await expect(page.getByTestId("agent-row-term-agent")).toBeVisible();
});

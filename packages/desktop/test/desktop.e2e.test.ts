// Desktop client end to end: a real room server serving the built UI, the built Electron app,
// and the real runner it hosts, driving real Claude Code and Codex agents (costs a little real
// API usage). Run with `pnpm --filter @banyan/desktop test:e2e`.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
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

test.beforeAll(async () => {
  server = new TestServer(undefined, WEB_DIR);
  await server.start();
});

test.afterAll(async () => {
  await server.stop();
});

test.beforeEach(() => {
  banyanHome = tempDir("desktop-home");
  clientData = tempDir("desktop-data");
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
    env: { ...process.env, BANYAN_HOME: banyanHome, BANYAN_DESKTOP_DATA: clientData, ...env },
  });
  launched.push(app);
  const page = await app.firstWindow();
  page.on("console", (msg) => {
    if (msg.type() === "error" || msg.type() === "warning") pageProblems.push(`${msg.type()}: ${msg.text()}`);
  });
  page.on("pageerror", (err) => pageProblems.push(`uncaught: ${err.message}`));
  return { app, page };
}

async function connectAndCreateRoom(page: Page): Promise<string> {
  await page.getByPlaceholder("http://banyan-host:7700").fill(server.base.replace("http://", ""));
  await page.getByRole("button", { name: /Connect/ }).click();
  await expect(page.getByRole("heading", { name: "Banyan" })).toBeVisible();
  await page.getByLabel("Room name").fill("desktop room");
  await page.getByLabel("Fork repository URL").fill(createFork());
  await page.getByLabel("Room goal").fill("Make prefill faster");
  await page.getByLabel("Your name").fill("Rhett");
  await page.getByRole("button", { name: "Create a room" }).click();
  await page.waitForURL(/\/rooms\/[^/]+$/);
  return new URL(page.url()).pathname.split("/")[2]!;
}

const lockPath = (roomId: string) => join(banyanHome, "rooms", roomId, "runner.lock");

const memberToken = (page: Page) => page.evaluate(() => (JSON.parse(localStorage.getItem("banyan.rooms")!) as { memberToken: string }[])[0]!.memberToken);

const savedRunner = (roomId: string) => JSON.parse(readFileSync(join(banyanHome, "rooms", roomId, "runner.json"), "utf8")) as { runnerId: string; serverUrl: string };

test("connects to a room server, hosts a runner, keeps it in the tray and restores it on launch", async () => {
  let { app, page } = await launch();
  const roomId = await connectAndCreateRoom(page);

  await page.getByRole("button", { name: "Run agents on this machine" }).click();
  await expect(page.getByTestId("local-runner")).toHaveText("Local runner running");
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
  expect(JSON.parse(readFileSync(join(clientData, "settings.json"), "utf8"))).toEqual({ serverUrl: server.base, enabledRooms: [] });
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
  await page.getByPlaceholder("http://banyan-host:7700").fill("127.0.0.1:9");
  await page.getByRole("button", { name: /Connect/ }).click();
  await expect(page.getByRole("alert")).toContainText("cannot reach http://127.0.0.1:9");
  expect(existsSync(join(clientData, "settings.json"))).toBe(false);
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

// UI end to end: a real room server serving the built UI, real browsers, and a real runner
// connection that pushes live events. Run with `pnpm --filter @banyan/web test:e2e`.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test, type Page } from "@playwright/test";
import { draft, newId, type AppendResult, type EventDraft, type RoomState, type ServerMessage } from "@banyan/shared";
import { buildApp } from "@banyan/server/app";

let app: Awaited<ReturnType<typeof buildApp>>;
let base: string;

test.beforeAll(async () => {
  app = await buildApp({ dbPath: join(mkdtempSync(join(tmpdir(), "banyan-ui-e2e-")), "e2e.sqlite"), webDir: fileURLToPath(new URL("../dist", import.meta.url)) });
  base = await app.listen({ host: "127.0.0.1", port: 0 });
});

test.afterAll(async () => {
  await app.close();
});

// Browser output must stay clean: any console warning, error or uncaught exception fails the test.
const browserProblems: string[] = [];
test.beforeEach(({ context }) => {
  browserProblems.length = 0;
  context.on("console", (msg) => {
    if (msg.type() === "error" || msg.type() === "warning") browserProblems.push(`${msg.type()}: ${msg.text()}`);
  });
  context.on("weberror", (err) => browserProblems.push(`uncaught: ${err.error().message}`));
});
test.afterEach(() => {
  expect(browserProblems).toEqual([]);
});

async function api(path: string, body?: unknown, token?: string): Promise<any> {
  const res = await fetch(`${base}${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (!res.ok) throw new Error(`${path}: ${res.status} ${await res.text()}`);
  return res.json();
}

// A WebSocket client acting as a member or a runner, exactly as the real clients do.
async function socket(roomId: string, token: string) {
  const ws = new WebSocket(`${base.replace("http", "ws")}/api/rooms/${roomId}/ws?token=${encodeURIComponent(token)}`);
  await new Promise((resolve) => ws.addEventListener("open", resolve, { once: true }));
  const append = (drafts: EventDraft[], asAgent?: string) =>
    new Promise<AppendResult[]>((resolve) => {
      const requestId = newId();
      const onMessage = (e: MessageEvent) => {
        const msg = JSON.parse(String(e.data)) as ServerMessage;
        if (msg.type === "append_result" && msg.requestId === requestId) {
          ws.removeEventListener("message", onMessage);
          resolve(msg.results);
        }
      };
      ws.addEventListener("message", onMessage);
      ws.send(JSON.stringify({ type: "append", requestId, drafts, ...(asAgent ? { asAgent } : {}) }));
    });
  return { ws, append };
}

// Creates a room through the UI's home page and returns its ids and the owner's token.
async function createRoomInUi(page: Page) {
  await page.goto(`${base}/`);
  await page.evaluate(() => localStorage.setItem("banyan.lang", "en"));
  await page.reload();
  await page.getByLabel("Room name").fill("UI e2e room");
  await page.getByLabel("Fork repository URL").fill("git@github.com:example/sglang.git");
  await page.getByLabel("Room goal").fill("Make sglang faster");
  await page.getByLabel("Your name").fill("Rhett");
  await page.getByRole("button", { name: "Create a room" }).click();
  await page.waitForURL(/\/rooms\/[0-9A-Z]+$/);
  const roomId = page.url().split("/").pop()!;
  const creds = await page.evaluate(() => JSON.parse(localStorage.getItem("banyan.rooms")!)[0] as { memberToken: string; memberId: string });
  const state = (await api(`/api/rooms/${roomId}/state`, undefined, creds.memberToken)).state as RoomState;
  return { roomId, token: creds.memberToken, memberId: creds.memberId, rootGoalId: state.room!.rootGoalId };
}

async function serverState(roomId: string, token: string): Promise<RoomState> {
  return (await api(`/api/rooms/${roomId}/state`, undefined, token)).state as RoomState;
}

test("creates a room, invites a second person who joins through the link", async ({ page, browser }) => {
  const { roomId } = await createRoomInUi(page);
  await expect(page.getByRole("heading", { name: "Agents" })).toBeVisible();
  await expect(page.getByText("No agents yet. Create one to start.")).toBeVisible();

  // The brand keeps you in the room; leaving it goes through the room switcher.
  await page.getByRole("link", { name: "Banyan" }).click();
  await expect(page).toHaveURL(`${base}/rooms/${roomId}`);
  await expect(page.getByLabel("Room")).toHaveValue(roomId);
  await expect(page.getByLabel("Room").locator("option:checked")).toHaveText("UI e2e room");

  await page.getByRole("button", { name: "Invite" }).click();
  const link = await page.getByTestId("invite-link").inputValue();
  expect(link).toContain(`/join/${roomId}#invite=`);
  await expect(page.getByTestId("install-command")).toHaveValue(`curl -fsSL ${base}/install.sh | bash -s ${base}`);
  await expect(page.getByTestId("runner-command")).toHaveValue(new RegExp(`banyan-runner register --server ${base} --room ${roomId} --member-token `));

  const other = await browser.newContext();
  other.on("console", (msg) => {
    if (msg.type() === "error" || msg.type() === "warning") browserProblems.push(`guest ${msg.type()}: ${msg.text()}`);
  });
  const guest = await other.newPage();
  await guest.goto(link);
  await guest.evaluate(() => localStorage.setItem("banyan.lang", "en"));
  await guest.reload();
  // A browser guest is offered the desktop client right on the join page.
  await expect(guest.getByTestId("install-command")).toHaveValue(`curl -fsSL ${base}/install.sh | bash -s ${base}`);
  await guest.getByLabel("Your name").fill("Bob");
  await guest.getByRole("button", { name: "Join" }).click();
  await guest.waitForURL(new RegExp(`/rooms/${roomId}$`));
  await expect(guest.getByRole("heading", { name: "Agents" })).toBeVisible();
  await other.close();

  await page.keyboard.press("Escape");
  await page.getByLabel("Room").selectOption({ label: "Create or join a room…" });
  await expect(page).toHaveURL(`${base}/`);
  await expect(page.getByRole("link", { name: "UI e2e room" })).toBeVisible();
});

test("builds the goal tree and group from the UI, then shows live agent state and runner presence", async ({ page }) => {
  const room = await createRoomInUi(page);
  const runner = await api(`/api/rooms/${room.roomId}/runners`, { hostname: "gpu-box" }, room.token);

  await page.getByRole("link", { name: "Goals" }).click();
  await expect(page.getByRole("heading", { name: "Make sglang faster" })).toBeVisible();
  await page.getByRole("button", { name: "New sub-goal" }).click();
  await page.getByLabel("Title").fill("Faster prefill");
  await page.getByRole("button", { name: "Create" }).click();
  await page.getByText("Faster prefill").click();
  await page.getByRole("button", { name: "New group" }).click();
  await page.getByLabel("Group name").fill("prefill team");
  await page.getByRole("button", { name: "Create" }).click();
  await expect(page.getByTestId("group-prefill team")).toBeVisible();

  await page.getByRole("button", { name: "New agent" }).click();
  // Simple by default: kind, name, repository. Group, role, goal and instructions are in the
  // coordination section.
  await expect(page.getByLabel("Model")).toHaveCount(0);
  await expect(page.getByLabel("Group")).not.toBeVisible();
  await page.getByRole("radio", { name: "Codex" }).click();
  await expect(page.getByRole("radio", { name: "Codex" })).toHaveAttribute("aria-checked", "true");
  await page.getByLabel("Agent name").fill("tok-worker");
  await page.getByText("Coordination (goal · group · role)").click();
  await page.getByLabel("Group").selectOption({ label: "prefill team" });
  await page.getByLabel("Instructions").fill("Profile the tokenizer.");
  await page.getByRole("button", { name: "Create" }).click();
  const card = page.getByTestId("agent-card-tok-worker");
  await expect(card).toBeVisible();

  const state = await serverState(room.roomId, room.token);
  const agent = Object.values(state.agents).find((a) => a.name === "tok-worker")!;
  expect(agent).toMatchObject({ provider: "codex", runnerId: runner.runnerId, model: "default", instructions: "Profile the tokenizer.", role: "worker", terminal: true });

  // The runner is not connected yet, so the agent shows as offline.
  await expect(card.locator("[data-icon]")).toHaveAttribute("data-icon", "offline");
  const r = await socket(room.roomId, runner.runnerToken);
  await r.append([draft("agent.process_changed", { agentId: agent.id, process: "running" }), draft("agent.activity_changed", { agentId: agent.id, activity: "working" })]);
  await r.append([draft("agent.phase_reported", { agentId: agent.id, phase: "waiting_gpu", note: "queue 2" })], agent.id);
  await expect(card.locator("[data-icon]")).toHaveAttribute("data-icon", "working");
  await expect(card).toContainText("waiting_gpu");
  await expect(card).toContainText("working");

  // The overview lists the agent under its group with the same live status.
  await page.getByRole("link", { name: "Overview" }).click();
  const row = page.getByTestId("group-prefill team").getByTestId("agent-row-tok-worker");
  await expect(row.locator("[data-icon]")).toHaveAttribute("data-icon", "working");
  await expect(row).toContainText("Working · waiting_gpu");
  await expect(page.locator(".facts")).toContainText("prefill team");

  // Dropping the runner connection turns it offline again without a reload.
  r.ws.close();
  await expect(row.locator("[data-icon]")).toHaveAttribute("data-icon", "offline");
  await page.getByRole("link", { name: "Goals" }).click();
  await page.locator(".tree-item", { hasText: "Faster prefill" }).click();
  await expect(card.locator("[data-icon]")).toHaveAttribute("data-icon", "offline");
});

test("creates standalone agents without any group and shows them on their goals", async ({ page }) => {
  const room = await createRoomInUi(page);
  // Without a runner, a browser user is pointed at the desktop client or the runner CLI.
  await page.getByRole("button", { name: "New agent" }).click();
  await expect(page.getByText("No machine runs your agents in this room yet: install the desktop client")).toBeVisible();
  await page.getByRole("button", { name: "Cancel" }).click();
  const runner = await api(`/api/rooms/${room.roomId}/runners`, { hostname: "gpu-box" }, room.token);

  await page.getByRole("button", { name: "New agent" }).click();
  await expect(page.getByText(/No machine runs your agents/)).toHaveCount(0);
  await page.getByText("Coordination (goal · group · role)").click();
  await expect(page.getByLabel("Group")).toHaveValue("");
  await expect(page.getByLabel("Role").locator("option[value=leader]")).toBeDisabled();
  await expect(page.getByLabel("Role").locator("option[value=monitor]")).toBeDisabled();
  await page.getByLabel("Agent name").fill("solo");
  await page.getByRole("button", { name: "Create" }).click();
  await expect(page.getByTestId("standalone-agents").getByTestId("agent-row-solo")).toBeVisible();
  // With no selection, the overview shows the first agent's conversation.
  await expect(page.locator(".agent-main h2")).toHaveText("solo");
  await expect(page.locator(".facts")).toContainText("Standalone");

  const state = await serverState(room.roomId, room.token);
  const agent = Object.values(state.agents).find((a) => a.name === "solo")!;
  expect(agent).toMatchObject({ groupId: null, role: "worker", goalId: room.rootGoalId, runnerId: runner.runnerId });

  // On the goals page, a standalone agent on a sub-goal also shows under the parent goal,
  // marked with its own goal.
  await page.getByRole("link", { name: "Goals" }).click();
  await expect(page.getByTestId("standalone-agents").getByTestId("agent-card-solo")).toBeVisible();
  await expect(page.getByText("No group or agent works on this goal yet.")).toHaveCount(0);
  await page.getByRole("button", { name: "New sub-goal" }).click();
  await page.getByLabel("Title").fill("Faster decode");
  await page.getByRole("button", { name: "Create" }).click();
  await page.getByRole("button", { name: "New agent" }).click();
  await page.getByLabel("Agent name").fill("decode-solo");
  await page.getByText("Coordination (goal · group · role)").click();
  await page.getByLabel("Agent goal").selectOption({ label: "Faster decode" });
  await page.getByRole("button", { name: "Create" }).click();
  await expect(page.getByTestId("agent-card-decode-solo")).toContainText("→ Faster decode");
  await page.getByText("Faster decode").first().click();
  await expect(page.getByTestId("standalone-agents").getByTestId("agent-card-decode-solo")).toBeVisible();
  await expect(page.getByTestId("agent-card-solo")).toHaveCount(0);

  await page.getByTestId("agent-card-decode-solo").click();
  await expect(page.getByTestId("agent-row-decode-solo")).toHaveClass(/selected/);
  await expect(page.locator(".agent-main h2")).toHaveText("decode-solo");
});

test("approves an agent's request, sends it a message and reads its live transcript", async ({ page }) => {
  const room = await createRoomInUi(page);
  const runner = await api(`/api/rooms/${room.roomId}/runners`, { hostname: "gpu-box" }, room.token);
  const member = await socket(room.roomId, room.token);
  const groupId = newId();
  const agentId = newId();
  await member.append([
    draft("group.created", { groupId, goalId: room.rootGoalId, name: "team" }),
    draft("agent.created", { agentId, groupId, runnerId: runner.runnerId, name: "bench", role: "worker", provider: "claude", model: "default", goalId: room.rootGoalId, instructions: "" }),
  ]);
  const r = await socket(room.roomId, runner.runnerToken);
  const approvalId = newId();
  await r.append([
    draft("agent.process_changed", { agentId, process: "running" }),
    draft("approval.requested", { approvalId, agentId, tool: "Bash", input: "python -m sglang.bench_serving" }),
    draft("transcript.appended", { agentId, entries: [{ kind: "assistant", text: "history before opening the page", ts: Date.now() }] }),
  ]);

  await expect(page.getByTestId("attention")).toContainText("bench");
  await expect(page.getByTestId("agent-row-bench").locator(".pill.yellow")).toHaveText("1");
  await page.getByTestId("agent-row-bench").click();
  await expect(page.getByTestId("transcript")).toContainText("history before opening the page");
  await expect(page.getByTestId("approval")).toContainText("python -m sglang.bench_serving");

  await page.getByRole("button", { name: "Allow" }).click();
  await expect(page.getByTestId("approval")).toHaveCount(0);
  await expect.poll(async () => (await serverState(room.roomId, room.token)).approvals[approvalId]).toMatchObject({ state: "allowed", decidedBy: { kind: "member", id: room.memberId } });

  await r.append([draft("transcript.appended", { agentId, entries: [{ kind: "assistant", text: "live entry after approval", ts: Date.now() }] })]);
  await expect(page.getByTestId("transcript")).toContainText("live entry after approval");

  await page.getByPlaceholder("Message this agent…").fill("Use 500 prompts.");
  await page.getByLabel("delivery").selectOption("steer");
  await page.getByRole("button", { name: "Send" }).click();
  await expect
    .poll(async () => Object.values((await serverState(room.roomId, room.token)).messages).map((m) => [m.toAgentId, m.text, m.delivery]))
    .toEqual([[agentId, "Use 500 prompts.", "steer"]]);
  // Until the runner hands it to the agent, the message shows as pending.
  await expect(page.getByTestId("pending-message")).toContainText("Rhett · waiting for its runner");
  await expect(page.getByTestId("pending-message")).toContainText("Use 500 prompts.");

  // The runner records the delivery in the transcript, as it does when the agent receives it.
  const messageId = Object.keys((await serverState(room.roomId, room.token)).messages)[0]!;
  await r.append([draft("transcript.appended", { agentId, entries: [{ kind: "user", text: "Use 500 prompts.", ts: Date.now(), messageId }] })]);
  await expect(page.getByTestId("pending-message")).toHaveCount(0);
  await expect(page.locator(".entry.user")).toContainText("Rhett · interrupt");
  await expect(page.locator(".entry.user")).toContainText("Use 500 prompts.");
  expect((await serverState(room.roomId, room.token)).messages[messageId]!.deliveredAt).toEqual(expect.any(Number));
});

test("restarts a stopped agent and removes one after asking, only for its owner", async ({ page, browser }) => {
  const room = await createRoomInUi(page);
  const runner = await api(`/api/rooms/${room.roomId}/runners`, { hostname: "gpu-box" }, room.token);
  const member = await socket(room.roomId, room.token);
  const [kept, gone] = [newId(), newId()];
  const common = { groupId: null, runnerId: runner.runnerId, role: "worker" as const, provider: "claude" as const, model: "default", goalId: room.rootGoalId, instructions: "", terminal: true };
  await member.append([draft("agent.created", { ...common, agentId: kept, name: "kept" }), draft("agent.created", { ...common, agentId: gone, name: "gone" })]);
  const r = await socket(room.roomId, runner.runnerToken);
  await r.append([draft("agent.process_changed", { agentId: kept, process: "exited", detail: "claude exited (code 0)" })]);

  await page.getByTestId("agent-row-kept").click();
  await expect(page.getByTestId("agent-row-kept").locator("[data-icon]")).toHaveAttribute("data-icon", "stopped");
  const before = (await serverState(room.roomId, room.token)).agents[kept]!.lastEventAt;
  await page.getByRole("button", { name: "Start again" }).click();
  await expect.poll(async () => (await serverState(room.roomId, room.token)).agents[kept]!.lastEventAt).toBeGreaterThan(before);

  await page.getByTestId("agent-row-gone").click();
  await page.getByRole("button", { name: "Remove" }).click();
  await expect(page.getByRole("dialog", { name: "Remove this agent?" })).toContainText("Its worktree and branch stay");
  await page.getByRole("dialog").getByRole("button", { name: "Remove" }).click();
  await expect(page).toHaveURL(`${base}/rooms/${room.roomId}`);
  await expect(page.getByTestId("agent-row-gone")).toHaveCount(0);
  await expect(page.getByTestId("agent-row-kept")).toBeVisible();
  expect((await serverState(room.roomId, room.token)).agents[gone]).toMatchObject({ archived: true });

  // Someone else in the room sees the agent but cannot restart or remove it.
  const invite = await api(`/api/rooms/${room.roomId}/invites`, {}, room.token);
  const bob = await api(`/api/rooms/${room.roomId}/join`, { inviteToken: invite.inviteToken, displayName: "Bob" });
  const other = await browser.newContext();
  const guest = await other.newPage();
  await guest.goto(`${base}/`);
  await guest.evaluate((creds) => {
    localStorage.setItem("banyan.lang", "en");
    localStorage.setItem("banyan.rooms", JSON.stringify([creds]));
  }, { roomId: room.roomId, roomName: "UI e2e room", memberId: bob.memberId, memberToken: bob.memberToken });
  await guest.goto(`${base}/rooms/${room.roomId}/agents/${kept}`);
  await expect(guest.locator(".agent-main h2")).toHaveText("kept");
  await expect(guest.getByRole("button", { name: "Remove" })).toHaveCount(0);
  await expect(guest.getByRole("button", { name: "Start again" })).toHaveCount(0);
  await other.close();
});

test("shows an error instead of loading forever when saved credentials are rejected", async ({ page }) => {
  const { roomId } = await createRoomInUi(page);
  await page.evaluate(() => {
    const rooms = JSON.parse(localStorage.getItem("banyan.rooms")!);
    rooms[0].memberToken = "revoked";
    localStorage.setItem("banyan.rooms", JSON.stringify(rooms));
  });
  await page.reload();
  const message = `room server refused access to room ${roomId} (401)`;
  await expect(page.getByTestId("room-error")).toContainText(message);
  // The rejected request and the connection's own error log are expected; nothing else.
  const expected = browserProblems.splice(0);
  expect(expected.some((p) => p.includes("401"))).toBe(true);
  expect(expected.filter((p) => !p.includes("401") && !p.includes(message))).toEqual([]);
});

test("keeps transcripts apart when switching agents before a page finishes loading", async ({ page }) => {
  const room = await createRoomInUi(page);
  const runner = await api(`/api/rooms/${room.roomId}/runners`, { hostname: "gpu-box" }, room.token);
  const member = await socket(room.roomId, room.token);
  const groupId = newId();
  const [a, b] = [newId(), newId()];
  const common = { groupId, runnerId: runner.runnerId, role: "worker" as const, provider: "claude" as const, model: "default", goalId: room.rootGoalId, instructions: "" };
  // Hold alpha's first transcript page until after we have moved on to beta. The overview
  // opens alpha as soon as it exists, so the hold is in place before the agents are created.
  let releaseAlpha!: () => void;
  const alphaHeld = new Promise<void>((resolve) => (releaseAlpha = resolve));
  await page.route(`**/agents/${a}/transcript*`, async (route) => {
    await alphaHeld;
    await route.continue();
  });
  await member.append([draft("group.created", { groupId, goalId: room.rootGoalId, name: "team" }), draft("agent.created", { ...common, agentId: a, name: "alpha" }), draft("agent.created", { ...common, agentId: b, name: "beta" })]);
  const r = await socket(room.roomId, runner.runnerToken);
  await r.append([
    draft("transcript.appended", { agentId: a, entries: [{ kind: "assistant", text: "alpha says hi", ts: Date.now() }] }),
    draft("transcript.appended", { agentId: b, entries: [{ kind: "assistant", text: "beta says hi", ts: Date.now() }] }),
  ]);
  await page.getByTestId("agent-row-alpha").click();
  await page.waitForURL(new RegExp(`/agents/${a}$`));
  // Navigate in-app straight from alpha's page to beta's, so the agent page stays mounted.
  await page.evaluate((path) => {
    window.history.pushState(null, "", path);
    window.dispatchEvent(new PopStateEvent("popstate"));
  }, `/rooms/${room.roomId}/agents/${b}`);
  await expect(page.getByTestId("transcript")).toContainText("beta says hi");
  releaseAlpha();
  await page.waitForTimeout(500);
  await expect(page.getByTestId("transcript")).not.toContainText("alpha says hi");
});

test("reviews findings as a human, shows worktrees and coordination, and switches language and theme", async ({ page }) => {
  const room = await createRoomInUi(page);
  const runner = await api(`/api/rooms/${room.roomId}/runners`, { hostname: "gpu-box" }, room.token);
  const member = await socket(room.roomId, room.token);
  const groupId = newId();
  const lead = newId();
  const worker = newId();
  const base = { groupId, runnerId: runner.runnerId, provider: "claude" as const, model: "default", goalId: room.rootGoalId, instructions: "" };
  await member.append([
    draft("group.created", { groupId, goalId: room.rootGoalId, name: "team" }),
    draft("agent.created", { ...base, agentId: lead, name: "lead", role: "leader" }),
    draft("agent.created", { ...base, agentId: worker, name: "digger", role: "worker" }),
  ]);
  const r = await socket(room.roomId, runner.runnerToken);
  const worktreeId = newId();
  await r.append([
    draft("worktree.created", { worktreeId, agentId: worker, branch: "banyan/x/digger", baseSha: "abc1234" }),
    draft("worktree.updated", { worktreeId, headSha: "def5678", diffStat: { files: 3, insertions: 120, deletions: 7 } }),
  ]);
  await r.append([draft("post.created", { postId: newId(), agentId: worker, kind: "direction", summary: "batch the tokenizer", body: "", evidence: [], proposeRoomVisible: false })], worker);
  const leadPost = newId();
  await r.append([draft("post.created", { postId: leadPost, agentId: lead, kind: "conclusion", summary: "split work three ways", body: "", evidence: [], proposeRoomVisible: true })], lead);
  await r.append([draft("message.sent", { messageId: newId(), toAgentId: worker, text: "take the tokenizer", delivery: "fyi" })], lead);

  await page.getByRole("link", { name: "Worktrees" }).click();
  const wt = page.getByTestId("worktree-digger");
  await expect(wt).toContainText("banyan/x/digger");
  await expect(wt).toContainText("batch the tokenizer");
  await expect(wt).toContainText("+120");

  await page.getByRole("link", { name: "Coordination" }).click();
  await expect(page.getByTestId("message")).toContainText("take the tokenizer");

  // The top-level leader has no parent leader, so its post waits for a human.
  await page.getByRole("link", { name: "Findings" }).click();
  await expect(page.getByTestId("column-pending")).toContainText("split work three ways");
  await page.getByTestId("post-split work three ways").getByRole("button", { name: "Approve" }).click();
  await expect(page.getByTestId("column-room")).toContainText("split work three ways");
  await expect.poll(async () => (await serverState(room.roomId, room.token)).posts[leadPost]?.review).toMatchObject({ state: "approved", by: { kind: "member", id: room.memberId } });

  await page.getByRole("button", { name: "中文" }).click();
  await expect(page.getByRole("link", { name: "结论" })).toBeVisible();
  await page.getByLabel("theme").selectOption("dark");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await expect(page.getByRole("link", { name: "结论" })).toBeVisible();
});

// End-to-end tests against a real server, real SQLite file and real WebSocket clients.
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import type { FastifyInstance } from "fastify";
import { newId, type AppendResult, type EventDraft, type RoomEvent, type RoomState, type ServerMessage } from "@banyan/shared";
import { buildApp } from "../src/app.ts";

class WsClient {
  private messages: ServerMessage[] = [];
  private waiters: (() => void)[] = [];
  readonly closed: Promise<{ code: number }>;

  private constructor(private ws: WebSocket) {
    ws.on("message", (raw) => {
      this.messages.push(JSON.parse(raw.toString()) as ServerMessage);
      for (const w of this.waiters.splice(0)) w();
    });
    this.closed = new Promise((resolve) => ws.on("close", (code) => resolve({ code })));
  }

  static async connect(base: string, roomId: string, token: string): Promise<WsClient> {
    const ws = new WebSocket(`${base.replace("http", "ws")}/api/rooms/${roomId}/ws?token=${encodeURIComponent(token)}`);
    const client = new WsClient(ws);
    await new Promise<void>((resolve, reject) => {
      ws.once("open", () => resolve());
      ws.once("error", reject);
    });
    return client;
  }

  send(msg: unknown): void {
    this.ws.send(JSON.stringify(msg));
  }

  // Waits for and removes the first message matching the predicate.
  async take<T extends ServerMessage>(pred: (m: ServerMessage) => m is T, timeoutMs = 5000): Promise<T> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const i = this.messages.findIndex(pred);
      if (i >= 0) return this.messages.splice(i, 1)[0] as T;
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new Error(`timed out; pending messages: ${JSON.stringify(this.messages)}`);
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, remaining);
        this.waiters.push(() => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
  }

  async append(drafts: EventDraft[], asAgent?: string): Promise<AppendResult[]> {
    const requestId = newId();
    this.send({ type: "append", requestId, drafts, ...(asAgent ? { asAgent } : {}) });
    const reply = await this.take((m): m is Extract<ServerMessage, { type: "append_result" }> => m.type === "append_result" && m.requestId === requestId);
    return reply.results;
  }

  // Collects streamed events until at least `count` have arrived.
  async events(count: number): Promise<RoomEvent[]> {
    const out: RoomEvent[] = [];
    while (out.length < count) {
      const m = await this.take((x): x is Extract<ServerMessage, { type: "events" }> => x.type === "events");
      out.push(...m.events);
    }
    return out;
  }

  pendingCount(): number {
    return this.messages.length;
  }

  close(): void {
    this.ws.close();
  }
}

function draft<T extends EventDraft["type"]>(type: T, payload: Extract<EventDraft, { type: T }>["payload"], eventId = newId()): EventDraft {
  return { eventId, type, payload } as EventDraft;
}

let dbPath: string;
let app: FastifyInstance;
let base: string;
let clock: number;

async function start(): Promise<void> {
  app = await buildApp({ dbPath, now: () => clock });
  base = await app.listen({ host: "127.0.0.1", port: 0 });
}

async function post(path: string, body: unknown, token?: string): Promise<{ status: number; json: any }> {
  const res = await fetch(`${base}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: await res.json() };
}

async function get(path: string, token?: string): Promise<{ status: number; json: any }> {
  const res = await fetch(`${base}${path}`, { headers: token ? { authorization: `Bearer ${token}` } : {} });
  return { status: res.status, json: await res.json() };
}

interface Fixture {
  roomId: string;
  ownerId: string;
  ownerToken: string;
  inviteToken: string;
  runnerId: string;
  runnerToken: string;
  groupId: string;
  agentId: string;
  rootGoalId: string;
}

// Room with an owner, the owner's runner, one group on the root goal and one worker agent.
async function seed(): Promise<Fixture> {
  const created = await post("/api/rooms", {
    name: "sglang perf",
    repoUrl: "git@github.com:me/sglang.git",
    baseBranch: "main",
    goalTitle: "Improve sglang performance",
    ownerName: "Rhett",
  });
  expect(created.status).toBe(200);
  const { roomId, memberId, memberToken, inviteToken } = created.json;
  const runner = await post(`/api/rooms/${roomId}/runners`, { hostname: "mac" }, memberToken);
  expect(runner.status).toBe(200);
  const state = (await get(`/api/rooms/${roomId}/state`, memberToken)).json.state as RoomState;
  const rootGoalId = state.room!.rootGoalId;
  const owner = await WsClient.connect(base, roomId, memberToken);
  const groupId = newId();
  const agentId = newId();
  const results = await owner.append([
    draft("group.created", { groupId, goalId: rootGoalId, name: "root" }),
    draft("agent.created", { agentId, groupId, runnerId: runner.json.runnerId, name: "w1", role: "worker", provider: "claude", model: "claude-opus-5-5", goalId: rootGoalId, instructions: "" }),
  ]);
  expect(results.every((r) => r.ok)).toBe(true);
  owner.close();
  return { roomId, ownerId: memberId, ownerToken: memberToken, inviteToken, runnerId: runner.json.runnerId, runnerToken: runner.json.runnerToken, groupId, agentId, rootGoalId };
}

beforeEach(async () => {
  dbPath = join(mkdtempSync(join(tmpdir(), "banyan-server-test-")), "banyan.sqlite");
  clock = 1_700_000_000_000;
  await start();
});

afterEach(async () => {
  await app.close();
});

describe("rooms and membership", () => {
  it("creates a room with an owner and a root goal", async () => {
    const f = await seed();
    const { status, json } = await get(`/api/rooms/${f.roomId}/state`, f.ownerToken);
    expect(status).toBe(200);
    const state = json.state as RoomState;
    expect(state.room).toMatchObject({ name: "sglang perf", baseBranch: "main" });
    expect(state.goals[f.rootGoalId]).toMatchObject({ title: "Improve sglang performance", parentId: null });
    expect(state.members[f.ownerId]).toEqual({ id: f.ownerId, displayName: "Rhett", role: "owner" });
    expect(state.runners[f.runnerId]).toEqual({ id: f.runnerId, memberId: f.ownerId, hostname: "mac" });
  });

  it("creates a room without a shared fork, and requires a fork's URL and branch together", async () => {
    const created = await post("/api/rooms", { name: "local", goalTitle: "Local work", ownerName: "Rhett" });
    expect(created.status).toBe(200);
    const state = (await get(`/api/rooms/${created.json.roomId}/state`, created.json.memberToken)).json.state as RoomState;
    expect(state.room).toMatchObject({ name: "local", repoUrl: null, baseBranch: null, personal: false });
    const personal = await post("/api/rooms", { name: "mine", goalTitle: "Mine", ownerName: "Rhett", personal: true });
    expect((await get(`/api/rooms/${personal.json.roomId}/state`, personal.json.memberToken)).json.state.room).toMatchObject({ personal: true });
    const half = await post("/api/rooms", { name: "x", repoUrl: "git@example.com:x.git", goalTitle: "g", ownerName: "Rhett" });
    expect(half.status).toBe(400);
    expect(half.json.error).toContain("repoUrl and baseBranch go together");
  });

  it("rejects bad request bodies", async () => {
    const { status, json } = await post("/api/rooms", { name: "" });
    expect(status).toBe(400);
    expect(json.error).toContain("name");
  });

  it("rejects missing, wrong-kind and cross-room tokens", async () => {
    const a = await seed();
    const b = await seed();
    expect((await get(`/api/rooms/${a.roomId}/state`)).status).toBe(401);
    expect((await get(`/api/rooms/${a.roomId}/state`, a.inviteToken)).status).toBe(401);
    expect((await get(`/api/rooms/${a.roomId}/state`, b.ownerToken)).status).toBe(401);
    expect((await post(`/api/rooms/${a.roomId}/runners`, { hostname: "x" }, a.runnerToken)).status).toBe(401);
  });

  it("joins with an invite until it expires", async () => {
    const f = await seed();
    const joined = await post(`/api/rooms/${f.roomId}/join`, { inviteToken: f.inviteToken, displayName: "Bob" });
    expect(joined.status).toBe(200);
    const state = (await get(`/api/rooms/${f.roomId}/state`, joined.json.memberToken)).json.state as RoomState;
    expect(state.members[joined.json.memberId]).toMatchObject({ displayName: "Bob", role: "member" });

    clock += 8 * 24 * 3600 * 1000;
    expect((await post(`/api/rooms/${f.roomId}/join`, { inviteToken: f.inviteToken, displayName: "Eve" })).status).toBe(401);
    const fresh = await post(`/api/rooms/${f.roomId}/invites`, {}, f.ownerToken);
    expect((await post(`/api/rooms/${f.roomId}/join`, { inviteToken: fresh.json.inviteToken, displayName: "Eve" })).status).toBe(200);
  });
});

describe("websocket", () => {
  it("closes unauthorized sockets", async () => {
    const f = await seed();
    const ws = await WsClient.connect(base, f.roomId, f.inviteToken);
    expect(await ws.take((m): m is Extract<ServerMessage, { type: "error" }> => m.type === "error")).toEqual({ type: "error", error: "unauthorized" });
    expect((await ws.closed).code).toBe(4401);
  });

  it("reports malformed client messages", async () => {
    const f = await seed();
    const ws = await WsClient.connect(base, f.roomId, f.ownerToken);
    ws.send({ type: "nope" });
    const err = await ws.take((m): m is Extract<ServerMessage, { type: "error" }> => m.type === "error");
    expect(err.error).toContain("type");
    ws.close();
  });

  it("lets a runner act as its own agent but not as another runner's agent", async () => {
    const f = await seed();
    const runner = await WsClient.connect(base, f.roomId, f.runnerToken);
    const [ok] = await runner.append([draft("agent.phase_reported", { agentId: f.agentId, phase: "exploring" })], f.agentId);
    expect(ok).toMatchObject({ ok: true });

    const otherRunner = await post(`/api/rooms/${f.roomId}/runners`, { hostname: "linux" }, f.ownerToken);
    const other = await WsClient.connect(base, f.roomId, otherRunner.json.runnerToken);
    const [denied] = await other.append([draft("agent.phase_reported", { agentId: f.agentId, phase: "hijacked" })], f.agentId);
    expect(denied).toMatchObject({ ok: false, error: "runner does not host this agent" });

    const member = await WsClient.connect(base, f.roomId, f.ownerToken);
    const [memberDenied] = await member.append([draft("agent.phase_reported", { agentId: f.agentId, phase: "x" })], f.agentId);
    expect(memberDenied).toMatchObject({ ok: false, error: "members may not act as agents" });

    const [serverOnly] = await member.append([draft("member.joined", { memberId: "x", displayName: "x", role: "owner" })]);
    expect(serverOnly).toMatchObject({ ok: false, error: "member.joined can only be emitted by the server" });
    for (const c of [runner, other, member]) c.close();
  });

  it("streams the backlog, then live events, and excludes transcript history from the backlog", async () => {
    const f = await seed();
    const runner = await WsClient.connect(base, f.roomId, f.runnerToken);
    await runner.append([draft("transcript.appended", { agentId: f.agentId, entries: [{ kind: "assistant", text: "old", ts: 1 }] })]);

    const viewer = await WsClient.connect(base, f.roomId, f.ownerToken);
    viewer.send({ type: "subscribe", afterSeq: 0 });
    const backlog = await viewer.events(5);
    expect(backlog.map((e) => e.type)).toEqual(["room.created", "member.joined", "runner.registered", "group.created", "agent.created"]);

    await runner.append([
      draft("agent.activity_changed", { agentId: f.agentId, activity: "working" }),
      draft("transcript.appended", { agentId: f.agentId, entries: [{ kind: "assistant", text: "live", ts: 2 }] }),
    ]);
    const live = await viewer.events(2);
    expect(live.map((e) => e.type)).toEqual(["agent.activity_changed", "transcript.appended"]);
    expect(live[0]!.actor).toEqual({ kind: "runner", id: f.runnerId });
    runner.close();
    viewer.close();
  });

  it("resumes a subscription from the last seen seq", async () => {
    const f = await seed();
    const runner = await WsClient.connect(base, f.roomId, f.runnerToken);
    const viewer = await WsClient.connect(base, f.roomId, f.ownerToken);
    viewer.send({ type: "subscribe", afterSeq: 0 });
    const seen = await viewer.events(5);
    const lastSeq = seen[seen.length - 1]!.seq;
    viewer.close();

    await runner.append([draft("agent.process_changed", { agentId: f.agentId, process: "running" })]);
    const reconnected = await WsClient.connect(base, f.roomId, f.ownerToken);
    reconnected.send({ type: "subscribe", afterSeq: lastSeq });
    const missed = await reconnected.events(1);
    expect(missed.map((e) => e.type)).toEqual(["agent.process_changed"]);
    expect(missed[0]!.seq).toBeGreaterThan(lastSeq);
    runner.close();
    reconnected.close();
  });

  it("acknowledges replayed event ids idempotently", async () => {
    const f = await seed();
    const runner = await WsClient.connect(base, f.roomId, f.runnerToken);
    const d = draft("agent.activity_changed", { agentId: f.agentId, activity: "idle" });
    const [first] = await runner.append([d]);
    const [replayed] = await runner.append([d]);
    expect(first).toMatchObject({ ok: true });
    expect(replayed).toEqual(first);

    const viewer = await WsClient.connect(base, f.roomId, f.ownerToken);
    viewer.send({ type: "subscribe", afterSeq: 0 });
    const all = await viewer.events(6);
    expect(all.filter((e) => e.eventId === d.eventId)).toHaveLength(1);
    expect(await viewer.take((m): m is Extract<ServerMessage, { type: "presence" }> => m.type === "presence")).toEqual({ type: "presence", onlineRunnerIds: [f.runnerId] });
    // No further messages beyond the six events and the presence snapshot.
    await new Promise((r) => setTimeout(r, 100));
    expect(viewer.pendingCount()).toBe(0);
    runner.close();
    viewer.close();
  });

  it("rejects one bad draft without blocking the rest of the batch", async () => {
    const f = await seed();
    const runner = await WsClient.connect(base, f.roomId, f.runnerToken);
    const results = await runner.append([
      draft("agent.process_changed", { agentId: "missing", process: "running" }),
      draft("agent.process_changed", { agentId: f.agentId, process: "running" }),
    ]);
    expect(results.map((r) => r.ok)).toEqual([false, true]);
    runner.close();
  });
});

describe("health", () => {
  it("answers the liveness probe without authentication", async () => {
    expect(await get("/api/health")).toEqual({ status: 200, json: { ok: true } });
  });
});

describe("presence", () => {
  const presence = (m: ServerMessage): m is Extract<ServerMessage, { type: "presence" }> => m.type === "presence";

  it("tells subscribers which runners are connected", async () => {
    const f = await seed();
    const viewer = await WsClient.connect(base, f.roomId, f.ownerToken);
    viewer.send({ type: "subscribe", afterSeq: 0 });
    expect((await viewer.take(presence)).onlineRunnerIds).toEqual([]);

    const runner = await WsClient.connect(base, f.roomId, f.runnerToken);
    expect((await viewer.take(presence)).onlineRunnerIds).toEqual([f.runnerId]);
    // A second connection of the same runner (e.g. while reconnecting) keeps it online.
    const runnerAgain = await WsClient.connect(base, f.roomId, f.runnerToken);
    expect((await viewer.take(presence)).onlineRunnerIds).toEqual([f.runnerId]);
    runner.close();
    expect((await viewer.take(presence)).onlineRunnerIds).toEqual([f.runnerId]);
    runnerAgain.close();
    expect((await viewer.take(presence)).onlineRunnerIds).toEqual([]);
    viewer.close();
  });
});

describe("web UI hosting", () => {
  it("serves the built UI, falls back to index.html for app routes, and keeps API 404s", async () => {
    await app.close();
    const webDir = mkdtempSync(join(tmpdir(), "banyan-web-"));
    writeFileSync(join(webDir, "index.html"), "<!doctype html><title>Banyan</title>");
    writeFileSync(join(webDir, "app.js"), "console.log('banyan')");
    app = await buildApp({ dbPath, webDir, now: () => clock });
    base = await app.listen({ host: "127.0.0.1", port: 0 });

    const index = await fetch(`${base}/`);
    expect(await index.text()).toContain("<title>Banyan</title>");
    expect(index.headers.get("content-security-policy")).toContain("script-src 'self'");
    expect(await (await fetch(`${base}/app.js`)).text()).toBe("console.log('banyan')");
    const deepLink = await fetch(`${base}/rooms/abc/agents/xyz`);
    expect(deepLink.status).toBe(200);
    expect(deepLink.headers.get("content-security-policy")).toContain("script-src 'self'");
    expect(await deepLink.text()).toContain("<title>Banyan</title>");
    const missingApi = await fetch(`${base}/api/nope`);
    expect(missingApi.status).toBe(404);
    expect(await missingApi.json()).toEqual({ error: "not found" });
  });
});

describe("desktop client distribution", () => {
  it("serves the install script and only the installers from the downloads directory", async () => {
    await app.close();
    const dir = mkdtempSync(join(tmpdir(), "banyan-desktop-"));
    writeFileSync(join(dir, "install.sh"), "#!/bin/bash\necho install\n");
    writeFileSync(join(dir, "Banyan-x64.dmg"), "x64 image");
    writeFileSync(join(dir, "builder-debug.yml"), "leftover");
    app = await buildApp({ dbPath, desktop: { installScript: join(dir, "install.sh"), downloadsDir: dir }, now: () => clock });
    base = await app.listen({ host: "127.0.0.1", port: 0 });

    const script = await fetch(`${base}/install.sh`);
    expect(script.headers.get("content-type")).toBe("text/x-shellscript; charset=utf-8");
    expect(await script.text()).toBe("#!/bin/bash\necho install\n");
    expect(await (await fetch(`${base}/downloads/Banyan-x64.dmg`)).text()).toBe("x64 image");
    expect((await fetch(`${base}/downloads/Banyan-arm64.dmg`)).status).toBe(404);
    expect((await fetch(`${base}/downloads/builder-debug.yml`)).status).toBe(404);
    expect((await fetch(`${base}/downloads/`)).status).toBe(404);
  });
});

describe("persistence", () => {
  it("rebuilds identical state from the log after a restart", async () => {
    const f = await seed();
    const runner = await WsClient.connect(base, f.roomId, f.runnerToken);
    await runner.append([
      draft("agent.session_bound", { agentId: f.agentId, providerSessionId: "sess-1" }),
      draft("worktree.created", { worktreeId: "wt1", agentId: f.agentId, branch: "room/x/w1", baseSha: "abc" }),
    ]);
    await runner.append([draft("post.created", { postId: "p1", agentId: f.agentId, kind: "finding", summary: "s", body: "b", evidence: [], proposeRoomVisible: true })], f.agentId);
    runner.close();
    const before = (await get(`/api/rooms/${f.roomId}/state`, f.ownerToken)).json.state;

    await app.close();
    await start();
    const after = (await get(`/api/rooms/${f.roomId}/state`, f.ownerToken)).json.state;
    expect(after).toEqual(before);
    expect(after.agents[f.agentId].providerSessionId).toBe("sess-1");
  });

  it("pages transcripts newest first", async () => {
    const f = await seed();
    const runner = await WsClient.connect(base, f.roomId, f.runnerToken);
    for (const text of ["one", "two", "three"]) {
      await runner.append([draft("transcript.appended", { agentId: f.agentId, entries: [{ kind: "assistant", text, ts: 1 }] })]);
    }
    runner.close();
    const page1 = await get(`/api/rooms/${f.roomId}/agents/${f.agentId}/transcript?limit=2`, f.ownerToken);
    const texts1 = (page1.json.events as RoomEvent[]).map((e) => (e.type === "transcript.appended" ? e.payload.entries[0]!.text : ""));
    expect(texts1).toEqual(["three", "two"]);
    const oldest = (page1.json.events as RoomEvent[]).at(-1)!.seq;
    const page2 = await get(`/api/rooms/${f.roomId}/agents/${f.agentId}/transcript?limit=2&beforeSeq=${oldest}`, f.ownerToken);
    expect((page2.json.events as RoomEvent[]).map((e) => (e.type === "transcript.appended" ? e.payload.entries[0]!.text : ""))).toEqual(["one"]);
    expect((await get(`/api/rooms/${f.roomId}/agents/${f.agentId}/transcript`, f.runnerToken)).status).toBe(401);
  });
});

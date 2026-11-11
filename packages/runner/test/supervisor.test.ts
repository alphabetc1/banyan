// Supervisor lifecycle edge cases. A scripted provider controls only *when* a session becomes
// ready, asks for approval or exits; the server, store, link and Room MCP are all real.
// Full provider behaviour is covered by providers.e2e.test.ts.
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { newId, type Delivery } from "@banyan/shared";
import { ServerLink } from "../src/link.ts";
import { LocalStore } from "../src/local-store.ts";
import { MemoryLogger } from "../src/logger.ts";
import type { AgentProvider, AgentSession, SessionCallbacks, SessionSpec } from "../src/providers/types.ts";
import { RoomMcp } from "../src/room-mcp.ts";
import { Supervisor } from "../src/supervisor.ts";
import { appendAsMember, createFork, createRoom, draft, tempDir, TestServer, waitFor } from "./helpers.ts";

interface Script {
  // Delay before the session reports ready.
  readyAfterMs?: number;
  // Runs once the session is ready.
  onReady?: (cb: SessionCallbacks, session: ScriptedSession) => void;
}

class ScriptedSession implements AgentSession {
  readonly ready: Promise<void>;
  sent: { text: string; delivery: Delivery }[] = [];
  stopped = false;
  constructor(
    readonly cb: SessionCallbacks,
    script: Script,
  ) {
    this.ready = new Promise((resolve) =>
      setTimeout(() => {
        cb.onSessionId(`session-${newId()}`);
        resolve();
        script.onReady?.(cb, this);
      }, script.readyAfterMs ?? 0),
    );
  }
  send(text: string, delivery: Delivery): void {
    this.sent.push({ text, delivery });
  }
  async stop(): Promise<void> {
    this.stopped = true;
    this.cb.onExit({ crashed: false, detail: "stopped" });
  }
}

class ScriptedProvider implements AgentProvider {
  sessions: ScriptedSession[] = [];
  constructor(private script: Script) {}
  start(_spec: SessionSpec, cb: SessionCallbacks): AgentSession {
    const s = new ScriptedSession(cb, this.script);
    this.sessions.push(s);
    return s;
  }
  async close(): Promise<void> {}
}

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

async function setup(script: Script, opts: { createAgent?: boolean; store?: LocalStore; repoUrl?: string } = {}) {
  const server = new TestServer();
  await server.start();
  cleanups.push(() => server.stop());
  const room = await createRoom(server, opts.repoUrl ?? createFork());
  const groupId = newId();
  const agentId = newId();
  const roomDir = tempDir("supervisor");
  await appendAsMember(server, room.roomId, room.memberToken, [draft("group.created", { groupId, goalId: room.rootGoalId, name: "g" })]);
  const createAgent = () =>
    appendAsMember(server, room.roomId, room.memberToken, [
      draft("agent.created", { agentId, groupId, runnerId: room.runnerId, name: "lead", role: "leader", provider: "claude", model: "default", goalId: room.rootGoalId, instructions: "" }),
    ]);
  if (opts.createAgent !== false) await createAgent();
  const store = opts.store ?? new LocalStore(join(roomDir, "runner.sqlite"));
  const log = new MemoryLogger();
  let supervisor: Supervisor | null = null;
  const link = new ServerLink({ serverUrl: server.base, roomId: room.roomId, token: room.runnerToken, store, log, onEvents: (e) => supervisor?.onEvents(e) });
  await link.start();
  // These cases never commit; an unexpected call fails loudly.
  const mcp = new RoomMcp({ state: () => link.state!, emit: (d, a) => link.emit(d, a), now: Date.now, commit: () => Promise.reject(new Error("commit is not part of these tests")) });
  await mcp.start();
  const provider = new ScriptedProvider(script);
  supervisor = new Supervisor({
    runnerId: room.runnerId,
    roomDir,
    store,
    mcp,
    providers: { claude: provider, codex: provider },
    log,
    state: () => link.state!,
    emit: (d, a = null) => link.emit(d, a),
  });
  cleanups.push(async () => {
    await supervisor!.close();
    await mcp.close();
    link.close();
    store.close();
  });
  const serverState = () => server.state(room.roomId, room.memberToken);
  return { server, room, agentId, groupId, store, link, log, provider, supervisor, serverState, createAgent };
}

describe("Supervisor", () => {
  it("expires approval requests a previous process left in the outbox", async () => {
    const pre = await setup({}, { createAgent: true });
    const leftover = newId();
    // Simulate a crashed process: the request was persisted but never reached the server.
    pre.store.enqueue([draft("approval.requested", { approvalId: leftover, agentId: pre.agentId, tool: "Bash", input: "make" })], null);
    await pre.supervisor.start();
    await waitFor(async () => (await pre.serverState()).approvals[leftover]?.state === "expired", "leftover approval to expire");
    await waitFor(() => pre.store.outboxSize() === 0, "outbox to drain");
    expect(pre.log.lines.filter((l) => l.level !== "info")).toEqual([]);
  });

  it("expires an approval whose session exits before the server echoed the request", async () => {
    let approvalAsked = false;
    const t = await setup({
      onReady: (cb) => {
        void cb.requestApproval({ tool: "Bash", input: "rm -rf build" });
        approvalAsked = true;
        cb.onExit({ crashed: false, detail: "session ended" });
      },
    });
    await t.supervisor.start();
    await waitFor(() => approvalAsked, "approval request");
    const approval = await waitFor(async () => Object.values((await t.serverState()).approvals).find((a) => a.agentId === t.agentId), "approval on server");
    await waitFor(async () => (await t.serverState()).approvals[approval.id]?.state === "expired", "approval to expire");
    const agent = (await t.serverState()).agents[t.agentId]!;
    expect(agent).toMatchObject({ process: "exited", processDetail: "session ended" });
    expect(t.log.lines.filter((l) => l.level !== "info")).toEqual([]);
  });

  it("shows the agent as starting while its workspace is prepared", async () => {
    const t = await setup({ readyAfterMs: 1500 });
    void t.supervisor.start();
    await waitFor(async () => (await t.serverState()).agents[t.agentId]?.process === "starting", "starting state");
    expect((await t.serverState()).agents[t.agentId]?.processDetail).toBe("preparing workspace");
    await waitFor(async () => (await t.serverState()).agents[t.agentId]?.process === "running", "running state");
  });

  it("wakes the leader when a worker reports done or blocked", async () => {
    const t = await setup({});
    await t.supervisor.start();
    await waitFor(() => t.provider.sessions.length === 1, "leader session");
    const workerId = newId();
    await appendAsMember(t.server, t.room.roomId, t.room.memberToken, [
      draft("agent.created", { agentId: workerId, groupId: t.groupId, runnerId: t.room.runnerId, name: "digger", role: "worker", provider: "claude", model: "default", goalId: t.room.rootGoalId, instructions: "" }),
    ]);
    await waitFor(() => t.provider.sessions.length === 2, "worker session");
    t.link.emit([draft("agent.phase_reported", { agentId: workerId, phase: "exploring" })], workerId);
    t.link.emit([draft("agent.phase_reported", { agentId: workerId, phase: "done", note: "notes committed" })], workerId);
    const leader = t.provider.sessions[0]!;
    await waitFor(() => leader.sent.some((m) => m.text.includes('"done"')), "leader alert");
    expect(leader.sent.filter((m) => m.text.includes("reported phase"))).toEqual([
      { text: 'Worker "digger" reported phase "done": notes committed. Check room_group_digest and decide what happens next.', delivery: "fyi" },
    ]);
  });

  it("does not leave an agent in starting when shutdown interrupts workspace preparation", async () => {
    const t = await setup({}, { repoUrl: join(tempDir("missing"), "no-such-repo.git") });
    const started = t.supervisor.start();
    await t.supervisor.close();
    await started;
    const agent = await waitFor(async () => {
      const a = (await t.serverState()).agents[t.agentId];
      return a?.process === "exited" ? a : null;
    }, "exited state");
    expect(agent.processDetail).toBe("runner stopped while starting");
    expect(t.log.lines.filter((l) => l.level !== "info")).toEqual([]);
  });

  it("stops a session that finishes starting after shutdown began", async () => {
    const t = await setup({ readyAfterMs: 300 });
    void t.supervisor.start();
    await waitFor(() => t.provider.sessions.length === 1, "session start");
    await t.supervisor.close();
    expect(t.provider.sessions[0]!.stopped).toBe(true);
    expect(t.log.lines.filter((l) => l.level !== "info")).toEqual([]);
  });
});

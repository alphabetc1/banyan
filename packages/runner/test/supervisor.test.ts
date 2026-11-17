// Supervisor lifecycle edge cases. A scripted provider controls only *when* a session becomes
// ready, asks for approval or exits; the server, store, link and Room MCP are all real.
// Full provider behaviour is covered by providers.e2e.test.ts.
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
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
  specs: SessionSpec[] = [];
  constructor(private script: Script) {}
  start(spec: SessionSpec, cb: SessionCallbacks): AgentSession {
    const s = new ScriptedSession(cb, this.script);
    this.sessions.push(s);
    this.specs.push(spec);
    return s;
  }
  async close(): Promise<void> {}
}

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

async function setup(script: Script, opts: { createAgent?: boolean; store?: LocalStore; repoUrl?: string | null } = {}) {
  const server = new TestServer();
  await server.start();
  cleanups.push(() => server.stop());
  const room = await createRoom(server, opts.repoUrl === undefined ? createFork() : opts.repoUrl);
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
  return { server, room, roomDir, agentId, groupId, store, link, log, provider, supervisor, serverState, createAgent };
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

  it("works in a worktree of a local repository, from its checked-out commit, without pushing", async () => {
    // A local repository on a feature branch, with its own remote.
    const remote = createFork();
    const repo = join(tempDir("local-repo"), "repo");
    execFileSync("git", ["clone", "-q", remote, repo]);
    execFileSync("git", ["checkout", "-q", "-b", "feature"], { cwd: repo });
    writeFileSync(join(repo, "feature.txt"), "wip\n");
    execFileSync("git", ["add", "."], { cwd: repo });
    execFileSync("git", ["-c", "user.name=me", "-c", "user.email=me@example.com", "commit", "-qm", "wip"], { cwd: repo });
    const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).trim();
    let turnEnd!: () => void;
    const t = await setup({ onReady: (cb) => (turnEnd = () => cb.onTurnEnd({ ok: true, error: null })) }, { createAgent: false, repoUrl: null });
    const workerId = newId();
    await appendAsMember(t.server, t.room.roomId, t.room.memberToken, [
      draft("agent.created", { agentId: workerId, groupId: null, runnerId: t.room.runnerId, name: "local w", role: "worker", provider: "claude", model: "default", goalId: t.room.rootGoalId, instructions: "", repoPath: repo }),
    ]);
    await t.supervisor.start();
    await waitFor(async () => (await t.serverState()).agents[workerId]?.process === "running", "worker running");

    const wt = t.store.worktree(workerId)!;
    expect(wt).toMatchObject({ path: join(t.roomDir, "worktrees", workerId), baseSha: head, branch: "banyan/" + t.room.roomId.slice(-6).toLowerCase() + "/local-w" });
    expect(t.provider.specs[0]!.cwd).toBe(wt.path);
    expect(execFileSync("git", ["worktree", "list"], { cwd: repo, encoding: "utf8" })).toContain(wt.path);
    expect(readFileSync(join(wt.path, "feature.txt"), "utf8")).toBe("wip\n");

    // After a turn with a commit, the worktree is reported but the branch stays local.
    writeFileSync(join(wt.path, "result.txt"), "done\n");
    execFileSync("git", ["add", "."], { cwd: wt.path });
    execFileSync("git", ["-c", "user.name=me", "-c", "user.email=me@example.com", "commit", "-qm", "result"], { cwd: wt.path });
    turnEnd();
    const state = await waitFor(async () => {
      const s = await t.serverState();
      const reported = Object.values(s.worktrees).find((w) => w.agentId === workerId);
      return reported && reported.diffStat.files === 1 ? s : null;
    }, "worktree update");
    expect(Object.values(state.worktrees).find((w) => w.agentId === workerId)!.diffStat).toEqual({ files: 1, insertions: 1, deletions: 0 });
    expect(execFileSync("git", ["branch", "-a", "--list", "*banyan*"], { cwd: repo, encoding: "utf8" })).not.toContain("remotes/");
    expect(execFileSync("git", ["ls-remote", "--heads", remote], { encoding: "utf8" })).not.toContain("banyan/");
    expect(t.log.lines.filter((l) => l.level !== "info")).toEqual([]);
  });

  it("expands ~ in a local repository path", async () => {
    const home = mkdtempSync(join(homedir(), ".banyan-test-repo-"));
    cleanups.push(() => rmSync(home, { recursive: true, force: true }));
    execFileSync("git", ["clone", "-q", createFork(), join(home, "repo")]);
    const t = await setup({}, { createAgent: false, repoUrl: null });
    const workerId = newId();
    await appendAsMember(t.server, t.room.roomId, t.room.memberToken, [
      draft("agent.created", { agentId: workerId, groupId: null, runnerId: t.room.runnerId, name: "w", role: "worker", provider: "claude", model: "default", goalId: t.room.rootGoalId, instructions: "", repoPath: `~/${basename(home)}/repo` }),
    ]);
    await t.supervisor.start();
    await waitFor(async () => (await t.serverState()).agents[workerId]?.process === "running", "worker running");
    expect(execFileSync("git", ["worktree", "list"], { cwd: join(home, "repo"), encoding: "utf8" })).toContain(t.store.worktree(workerId)!.path);
  });

  it("explains that an agent in a room without a fork needs a local repository", async () => {
    const t = await setup({}, { createAgent: false, repoUrl: null });
    const workerId = newId();
    await appendAsMember(t.server, t.room.roomId, t.room.memberToken, [
      draft("agent.created", { agentId: workerId, groupId: null, runnerId: t.room.runnerId, name: "w", role: "worker", provider: "claude", model: "default", goalId: t.room.rootGoalId, instructions: "" }),
    ]);
    await t.supervisor.start();
    const agent = await waitFor(async () => {
      const a = (await t.serverState()).agents[workerId];
      return a?.process === "crashed" ? a : null;
    }, "start failure");
    expect(agent.processDetail).toBe("failed to start: this room has no shared repository; give the agent a repository on its runner's machine");
    expect(t.log.lines).toEqual([{ level: "error", msg: `agent ${workerId} failed to start: this room has no shared repository; give the agent a repository on its runner's machine` }]);
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

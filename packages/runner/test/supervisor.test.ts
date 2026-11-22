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

async function setup(script: Script, opts: { createAgent?: boolean; store?: LocalStore; repoUrl?: string | null; personal?: boolean } = {}) {
  const server = new TestServer();
  await server.start();
  cleanups.push(() => server.stop());
  const room = await createRoom(server, opts.repoUrl === undefined ? createFork() : opts.repoUrl, opts.personal);
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
  const mcp = new RoomMcp({
    state: () => link.state!,
    emit: (d, a) => link.emit(d, a),
    now: Date.now,
    commit: () => Promise.reject(new Error("commit is not part of these tests")),
    head: (agentId) => supervisor!.headFor(agentId),
  });
  await mcp.start();
  const provider = new ScriptedProvider(script);
  const makeSupervisor = () =>
    new Supervisor({
      runnerId: room.runnerId,
      roomDir,
      store,
      mcp,
      providers: { claude: provider, codex: provider },
      terminals: { claude: provider, codex: provider, shell: provider },
      log,
      state: () => link.state!,
      emit: (d, a = null) => link.emit(d, a),
    });
  supervisor = makeSupervisor();
  // A runner process stopping and the next one starting, on the same store and connection.
  const restartSupervisor = async () => {
    await supervisor!.close();
    supervisor = makeSupervisor();
    await supervisor.start();
    return supervisor;
  };
  cleanups.push(async () => {
    await supervisor!.close();
    await mcp.close();
    link.close();
    store.close();
  });
  const serverState = () => server.state(room.roomId, room.memberToken);
  return { server, room, roomDir, agentId, groupId, store, link, log, provider, supervisor, serverState, createAgent, restartSupervisor };
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

  it("forks a terminal agent: a copy of its session, in a worktree carrying its uncommitted changes", async () => {
    const repo = join(tempDir("fork-repo"), "repo");
    execFileSync("git", ["clone", "-q", createFork(), repo]);
    const t = await setup({}, { createAgent: false, repoUrl: null, personal: true });
    const sourceId = newId();
    const common = { groupId: null, runnerId: t.room.runnerId, role: "worker" as const, provider: "claude" as const, model: "default", goalId: t.room.rootGoalId, instructions: "", terminal: true, repoPath: repo };
    await appendAsMember(t.server, t.room.roomId, t.room.memberToken, [draft("agent.created", { ...common, agentId: sourceId, name: "source" })]);
    await t.supervisor.start();
    const sourceSession = await waitFor(async () => (await t.serverState()).agents[sourceId]?.providerSessionId, "source session");
    // The source has committed work and uncommitted changes on top.
    const source = t.store.worktree(sourceId)!;
    writeFileSync(join(source.path, "done.txt"), "committed\n");
    execFileSync("git", ["add", "."], { cwd: source.path });
    execFileSync("git", ["-c", "user.name=me", "-c", "user.email=me@example.com", "commit", "-qm", "done"], { cwd: source.path });
    writeFileSync(join(source.path, "wip.txt"), "uncommitted\n");
    const sourceHead = execFileSync("git", ["rev-parse", "HEAD"], { cwd: source.path, encoding: "utf8" }).trim();

    const forkId = newId();
    await appendAsMember(t.server, t.room.roomId, t.room.memberToken, [draft("agent.created", { ...common, agentId: forkId, name: "source-fork", forkOf: sourceId })]);
    await waitFor(async () => (await t.serverState()).agents[forkId]?.process === "running", "fork running");
    const spec = t.provider.specs.find((s) => s.agentId === forkId)!;
    expect(spec).toMatchObject({ forkSessionId: sourceSession, resumeSessionId: null });
    const fork = t.store.worktree(forkId)!;
    expect(spec.cwd).toBe(fork.path);
    expect(fork.baseSha).toBe(sourceHead);
    expect(readFileSync(join(fork.path, "done.txt"), "utf8")).toBe("committed\n");
    expect(readFileSync(join(fork.path, "wip.txt"), "utf8")).toBe("uncommitted\n");
    // It waits for its person instead of being told anything, and gets a session of its own.
    expect(t.provider.sessions[t.provider.specs.indexOf(spec)]!.sent).toEqual([]);
    const state = await t.serverState();
    expect(state.agents[forkId]!.providerSessionId).not.toBeNull();
    expect(state.agents[forkId]!.providerSessionId).not.toBe(sourceSession);
    const transcript = await t.server.transcript(t.room.roomId, forkId, t.room.memberToken);
    expect(transcript.map((e) => e.text)).toContain("forked from source");
    // The source carries on untouched.
    expect(readFileSync(join(source.path, "wip.txt"), "utf8")).toBe("uncommitted\n");
    expect(t.log.lines.filter((l) => l.level !== "info")).toEqual([]);
  });

  // A clone, a two-second benchmark and a supervisor restart: more than the default test budget
  // under parallel load.
  it("verifies submitted results one at a time on a clean checkout, tells the agent, and finishes them after a restart", { timeout: 60_000 }, async () => {
    const repo = join(tempDir("bench-repo"), "repo");
    execFileSync("git", ["clone", "-q", createFork(), repo]);
    const t = await setup({}, { createAgent: false, repoUrl: null });
    const workerId = newId();
    await appendAsMember(t.server, t.room.roomId, t.room.memberToken, [
      draft("goal.metric_set", { goalId: t.room.rootGoalId, metric: { name: "throughput", direction: "higher", unit: "tok/s", command: "sh bench.sh" } }),
      draft("agent.created", { agentId: workerId, groupId: null, runnerId: t.room.runnerId, name: "bencher", role: "worker", provider: "claude", model: "default", goalId: t.room.rootGoalId, instructions: "", repoPath: repo }),
    ]);
    await t.supervisor.start();
    await waitFor(async () => (await t.serverState()).agents[workerId]?.process === "running", "worker running");
    const session = () => t.provider.sessions[t.provider.specs.findIndex((s) => s.agentId === workerId)]!;
    // A coordinated agent learns the metric and how results count.
    expect(t.provider.specs.find((s) => s.agentId === workerId)!.systemPrompt).toContain("is measured by throughput (higher is better, in tok/s), with this command run in the repository: sh bench.sh");
    const wt = t.store.worktree(workerId)!;
    const commitBench = (script: string) => {
      writeFileSync(join(wt.path, "bench.sh"), script);
      execFileSync("git", ["add", "."], { cwd: wt.path });
      execFileSync("git", ["-c", "user.name=me", "-c", "user.email=me@example.com", "commit", "-qm", "bench"], { cwd: wt.path });
      return execFileSync("git", ["rev-parse", "HEAD"], { cwd: wt.path, encoding: "utf8" }).trim();
    };
    const submit = (resultId: string, commitSha: string, value: number) =>
      t.link.emit([draft("result.submitted", { resultId, agentId: workerId, goalId: t.room.rootGoalId, value, commitSha, note: "" })], workerId);
    const result = async (id: string) => (await t.serverState()).results[id];

    // Both are queued at once; the second runs after the first, and each verdict reaches the agent.
    const good = commitBench("echo warming up\necho 'throughput: 950 tok/s'\n");
    const broken = commitBench("echo oops >&2\nexit 1\n");
    submit("good", good, 1000);
    submit("broken", broken, 2000);
    await waitFor(async () => (await result("good"))?.status === "verified" && (await result("broken"))?.status === "failed", "both verdicts");
    expect(await result("good")).toMatchObject({ value: 950, claimed: 1000 });
    expect(await result("broken")).toMatchObject({ failure: "the command exited with code 1", log: "oops\n", value: null });
    expect(session().sent.filter((m) => m.text.startsWith("Your result"))).toEqual([
      { text: "Your result (1000 tok/s) was verified at 950 tok/s.", delivery: "fyi" },
      { text: "Your result (2000 tok/s) could not be verified: the command exited with code 1.", delivery: "fyi" },
    ]);

    // A runner stopping mid-verification leaves no verdict; the next one finishes it.
    const slow = commitBench("sleep 2\necho 'throughput: 1100 tok/s'\n");
    submit("slow", slow, 1100);
    await waitFor(async () => (await result("slow"))?.status === "pending", "slow result submitted");
    await new Promise((r) => setTimeout(r, 500));
    await t.restartSupervisor();
    await waitFor(async () => (await result("slow"))?.status === "verified", "slow result verified after the restart", 30_000);
    expect((await result("slow"))!.value).toBe(1100);
    expect(t.log.lines.filter((l) => l.level === "error")).toEqual([]);
  });

  it("runs standalone agents of a personal workspace as plain sessions, and grouped ones with Banyan", async () => {
    const t = await setup({}, { createAgent: true, personal: true });
    const plainId = newId();
    await appendAsMember(t.server, t.room.roomId, t.room.memberToken, [
      draft("agent.created", { agentId: plainId, groupId: null, runnerId: t.room.runnerId, name: "plain", role: "worker", provider: "claude", model: "default", goalId: t.room.rootGoalId, instructions: "  Fix the flaky test.  " }),
    ]);
    await t.supervisor.start();
    await waitFor(async () => {
      const s = await t.serverState();
      return s.agents[plainId]?.process === "running" && s.agents[t.agentId]?.process === "running";
    }, "both agents running");
    const byAgent = (id: string) => t.provider.sessions[t.provider.specs.findIndex((spec) => spec.agentId === id)]!;
    const plainSpec = t.provider.specs.find((s) => s.agentId === plainId)!;
    expect(plainSpec).toMatchObject({ systemPrompt: null, roomMcpUrl: null });
    expect(byAgent(plainId).sent).toEqual([{ text: "Fix the flaky test.", delivery: "steer" }]);
    // The leader of a group keeps Banyan's coordination even in a personal workspace.
    const leaderSpec = t.provider.specs.find((s) => s.agentId === t.agentId)!;
    expect(leaderSpec.systemPrompt).toContain("You are an agent in a Banyan room");
    expect(leaderSpec.roomMcpUrl).toContain(t.agentId);
    expect(byAgent(t.agentId).sent[0]!.text).toContain("room_get_context");

    // A directive recorded while they run reaches the coordinated agent, not the plain one;
    // changing or retiring it does too, and other memory changes stay silent.
    const notes = (id: string) => byAgent(id).sent.filter((m) => m.text.includes("standing directive"));
    await appendAsMember(t.server, t.room.roomId, t.room.memberToken, [draft("memory.recorded", { entryId: "d1", kind: "directive", title: "Benchmark on H100 only", body: "" })]);
    await waitFor(() => notes(t.agentId).length === 1, "the directive note");
    expect(notes(t.agentId)[0]).toEqual({ text: "A person added a standing directive to the room's memory; always follow it:\n- Benchmark on H100 only", delivery: "fyi" });
    await appendAsMember(t.server, t.room.roomId, t.room.memberToken, [
      draft("memory.recorded", { entryId: "f1", kind: "fact", title: "a fact", body: "" }),
      draft("memory.updated", { entryId: "d1", title: "Benchmark on H100 or H200", body: "" }),
      draft("memory.retired", { entryId: "d1" }),
    ]);
    await waitFor(() => notes(t.agentId).length === 3, "the change and retirement notes");
    expect(notes(t.agentId).map((m) => m.text.split("\n")[0])).toEqual([
      "A person added a standing directive to the room's memory; always follow it:",
      "A person changed a standing directive to the room's memory; always follow it:",
      "A person retired this standing directive; it no longer applies:",
    ]);
    expect(notes(plainId)).toEqual([]);
  });

  it("does not start a plain managed agent without instructions", async () => {
    const t = await setup({}, { createAgent: false, personal: true });
    const plainId = newId();
    await appendAsMember(t.server, t.room.roomId, t.room.memberToken, [
      draft("agent.created", { agentId: plainId, groupId: null, runnerId: t.room.runnerId, name: "plain", role: "worker", provider: "codex", model: "default", goalId: t.room.rootGoalId, instructions: "" }),
    ]);
    await t.supervisor.start();
    const agent = await waitFor(async () => {
      const a = (await t.serverState()).agents[plainId];
      return a?.process === "crashed" ? a : null;
    }, "start failure");
    expect(agent.processDetail).toBe("failed to start: a managed agent needs instructions to start with; add instructions or run it in a terminal");
    expect(t.provider.specs).toEqual([]);
    expect(t.log.lines.map((l) => l.level)).toEqual(["error"]);
  });

  it("runs an agent in a folder that is not a git repository as it is, without a worktree", async () => {
    const plainFolder = tempDir("plain-folder");
    const emptyRepo = tempDir("empty-repo");
    execFileSync("git", ["init", "-q", emptyRepo]);
    const t = await setup({}, { createAgent: false, repoUrl: null, personal: true });
    const [inFolder, inEmptyRepo, missing] = [newId(), newId(), newId()];
    const base = { groupId: null, runnerId: t.room.runnerId, role: "worker" as const, provider: "claude" as const, model: "default", goalId: t.room.rootGoalId, instructions: "go", terminal: false };
    await appendAsMember(t.server, t.room.roomId, t.room.memberToken, [
      draft("agent.created", { ...base, agentId: inFolder, name: "folder", repoPath: plainFolder }),
      draft("agent.created", { ...base, agentId: inEmptyRepo, name: "empty", repoPath: emptyRepo }),
      draft("agent.created", { ...base, agentId: missing, name: "missing", repoPath: join(plainFolder, "nope") }),
    ]);
    await t.supervisor.start();
    await waitFor(async () => {
      const s = await t.serverState();
      return s.agents[inFolder]?.process === "running" && s.agents[inEmptyRepo]?.process === "running" && s.agents[missing]?.process === "crashed";
    }, "both running and the missing folder failing");
    const cwd = (id: string) => t.provider.specs.find((spec) => spec.agentId === id)!.cwd;
    expect(cwd(inFolder)).toBe(plainFolder);
    expect(cwd(inEmptyRepo)).toBe(emptyRepo);
    expect(t.store.worktree(inFolder)).toBeNull();
    expect(Object.values((await t.serverState()).worktrees)).toEqual([]);
    expect((await t.serverState()).agents[missing]!.processDetail).toBe(`failed to start: no such folder: ${join(plainFolder, "nope")}`);
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

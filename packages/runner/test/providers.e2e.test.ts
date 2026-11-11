// End-to-end: a real runner drives real Claude Code and Codex agents against a real room
// server and a real git fork. Costs real API usage; run with `pnpm test:e2e`.
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { newId, type Agent, type RoomState } from "@banyan/shared";
import { MemoryLogger } from "../src/logger.ts";
import { DEFAULT_MODEL } from "../src/providers/types.ts";
import { Runner } from "../src/runner.ts";
import { git } from "../src/worktree.ts";
import { appendAsMember, createFork, createRoom, draft, tempDir, TestServer, waitFor, type RoomFixture } from "./helpers.ts";

const AGENT_TIMEOUT_MS = 6 * 60_000;

// The file outside the worktree needs a human approval for both providers; committing goes
// through room_commit, so no git operation should ever wait for a human.
const instructions = (outsidePath: string) => `This is an automated end-to-end test of Banyan. Do exactly these steps, nothing else:
1. Call room_get_context.
2. Call room_set_status with phase "testing".
3. Call room_declare_direction with summary "e2e direction" and hypothesis "smoke test".
4. Create a file hello.txt containing exactly the word banyan, then commit it with the room_commit tool, message "add hello".
5. Write exactly the word ok into the file ${outsidePath} (it is outside your worktree; that is intended).
6. Call room_post_finding with kind "finding", summary "e2e finding", body "done", proposeRoomVisible false.
7. Remember the codeword PAPAYA for later.
Then reply DONE.`;

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

interface Harness {
  outsidePath: string;
  server: TestServer;
  room: RoomFixture;
  fork: string;
  roomDir: string;
  agentId: string;
  log: MemoryLogger;
  state(): Promise<RoomState>;
  agent(): Promise<Agent>;
  startRunner(): Promise<Runner>;
}

async function harness(provider: Agent["provider"]): Promise<Harness> {
  const server = new TestServer();
  await server.start();
  cleanups.push(() => server.stop());
  const fork = createFork();
  const room = await createRoom(server, fork);
  const roomDir = tempDir("runner-room");
  // Outside the worktree and outside the temp directories Codex's sandbox allows by default.
  const outsideDir = mkdtempSync(join(homedir(), ".banyan-e2e-"));
  cleanups.push(() => rmSync(outsideDir, { recursive: true, force: true }));
  const outsidePath = join(outsideDir, "probe.txt");
  const log = new MemoryLogger();
  const groupId = newId();
  const agentId = newId();
  const state = () => server.state(room.roomId, room.memberToken);
  const startRunner = async () => {
    // Default permission mode routes every file write and shell command through human approval.
    const runner = new Runner(
      { serverUrl: server.base, roomId: room.roomId, runnerId: room.runnerId, runnerToken: room.runnerToken, roomDir, claudePermissionMode: "default" },
      log,
    );
    await runner.start();
    cleanups.push(() => runner.stop());
    return runner;
  };
  await appendAsMember(server, room.roomId, room.memberToken, [
    draft("group.created", { groupId, goalId: room.rootGoalId, name: "e2e" }),
  ]);
  const h: Harness = { outsidePath, server, room, fork, roomDir, agentId, log, state, agent: async () => (await state()).agents[agentId]!, startRunner };
  // The agent is created after the runner starts, exercising the live agent.created path.
  h.startRunner = async () => {
    const runner = await startRunner();
    if (!(await state()).agents[agentId]) {
      await appendAsMember(server, room.roomId, room.memberToken, [
        draft("agent.created", { agentId, groupId, runnerId: room.runnerId, name: "e2e worker", role: "worker", provider, model: DEFAULT_MODEL, goalId: room.rootGoalId, instructions: instructions(outsidePath) }),
      ]);
    }
    return runner;
  };
  return h;
}

// Plays the human: approves every pending approval of the agent until stopped.
function autoApprove(h: Harness): () => void {
  let active = true;
  void (async () => {
    while (active) {
      const s = await h.state();
      const pending = Object.values(s.approvals).filter((a) => a.agentId === h.agentId && a.state === "pending");
      if (pending.length > 0) {
        await appendAsMember(h.server, h.room.roomId, h.room.memberToken, pending.map((a) => draft("approval.decided", { approvalId: a.id, decision: "allowed" })));
      }
      await new Promise((r) => setTimeout(r, 500));
    }
  })();
  return () => {
    active = false;
  };
}

async function transcriptTexts(h: Harness): Promise<string[]> {
  const res = await fetch(`${h.server.base}/api/rooms/${h.room.roomId}/agents/${h.agentId}/transcript?limit=200`, { headers: { authorization: `Bearer ${h.room.memberToken}` } });
  const { events } = (await res.json()) as { events: { payload: { entries: { text: string }[] } }[] };
  return events.flatMap((e) => e.payload.entries.map((x) => x.text));
}

async function runScenario(provider: Agent["provider"]): Promise<void> {
  const h = await harness(provider);
  const stopApproving = autoApprove(h);
  cleanups.push(stopApproving);
  const runner = await h.startRunner();

  // The agent follows the instructions: status, direction, a committed file, a finding.
  const finished = await waitFor(async () => {
    const s = await h.state();
    return Object.values(s.posts).some((p) => p.agentId === h.agentId && p.summary === "e2e finding") ? s : null;
  }, "e2e finding post", AGENT_TIMEOUT_MS, 1000);
  const agent = finished.agents[h.agentId]!;
  expect(agent.providerSessionId).toBeTruthy();
  expect(agent.process).toBe("running");
  // Agents are told to report "done" once finished, which may already have replaced "testing".
  expect(["testing", "done"]).toContain(agent.phase?.value);
  expect(Object.values(finished.posts).filter((p) => p.agentId === h.agentId && p.kind === "direction").map((p) => p.summary)).toEqual(["e2e direction"]);
  const approvals = Object.values(finished.approvals).filter((a) => a.agentId === h.agentId);
  expect(approvals.every((a) => a.state === "allowed")).toBe(true);
  expect(approvals.some((a) => a.input.includes(h.outsidePath))).toBe(true);
  expect(readFileSync(h.outsidePath, "utf8").trim()).toBe("ok");
  expect(approvals.filter((a) => /git (add|commit)/.test(a.input))).toEqual([]);

  // The turn end syncs the worktree and pushes the branch to the fork.
  const wt = await waitFor(async () => {
    const s = await h.state();
    const w = agent.worktreeId ? s.worktrees[agent.worktreeId] : undefined;
    return w && w.headSha !== w.baseSha ? w : null;
  }, "worktree commit", AGENT_TIMEOUT_MS, 1000);
  expect(wt.diffStat.files).toBeGreaterThanOrEqual(1);
  expect(await waitFor(() => git(h.fork, ["rev-parse", wt.branch]).catch(() => null), "branch on fork", 60_000, 1000)).toBe(wt.headSha);
  expect((await git(h.fork, ["show", `${wt.branch}:hello.txt`])).trim()).toBe("banyan");
  expect((await transcriptTexts(h)).length).toBeGreaterThan(0);

  // Restart the runner: the session is resumed and keeps its context.
  await waitFor(async () => (await h.agent()).activity === "idle", "agent idle before restart", AGENT_TIMEOUT_MS, 1000);
  await runner.stop();
  cleanups.pop();
  await h.startRunner();
  await waitFor(async () => {
    const a = await h.agent();
    return a.process === "running" && a.processDetail === "resumed";
  }, "resumed session", AGENT_TIMEOUT_MS, 1000);
  expect((await h.agent()).providerSessionId).toBe(agent.providerSessionId);
  await waitFor(async () => (await h.agent()).activity === "idle", "agent idle after resume", AGENT_TIMEOUT_MS, 1000);
  await appendAsMember(h.server, h.room.roomId, h.room.memberToken, [
    draft("message.sent", {
      messageId: newId(),
      toAgentId: h.agentId,
      delivery: "fyi",
      text: 'Call room_post_finding with kind "finding", summary set to only the codeword I asked you to remember, body "recall", proposeRoomVisible false.',
    }),
  ]);
  const recalled = await waitFor(async () => {
    const s = await h.state();
    return Object.values(s.posts).find((p) => p.agentId === h.agentId && p.body === "recall") ?? null;
  }, "recall post", AGENT_TIMEOUT_MS, 1000);
  expect(recalled.summary).toContain("PAPAYA");

  // Only runner lifecycle logs are expected; every warning must be explained.
  for (const line of h.log.lines.filter((l) => l.level !== "info")) {
    expect(line.msg).toMatch(/^codex app-server: /);
  }
}

describe("providers end to end", () => {
  it("runs a Claude agent through approvals, a pushed commit and a resume", async () => {
    await runScenario("claude");
  }, 30 * 60_000);

  it("runs a Codex agent through approvals, a pushed commit and a resume", async () => {
    await runScenario("codex");
  }, 30 * 60_000);
});

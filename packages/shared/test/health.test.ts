import { describe, expect, it } from "vitest";
import { DEFAULT_HEALTH_THRESHOLDS as T, deriveHealth, describeHealthReason, emptyRoomState, type Agent, type RoomState } from "../src/index.ts";

const NOW = 10_000_000_000;

function setup(overrides: Partial<Agent> = {}): { state: RoomState; agent: Agent } {
  const state = emptyRoomState();
  const agent: Agent = {
    id: "a",
    groupId: "g",
    runnerId: "r",
    memberId: "m",
    name: "a",
    role: "worker",
    provider: "claude",
    model: "m",
    goalId: "goal",
    instructions: "",
    repoPath: null,
    terminal: false,
    providerSessionId: "s",
    process: "running",
    processDetail: null,
    activity: "working",
    resumability: "live",
    resumabilityDetail: null,
    phase: null,
    worktreeId: null,
    createdAt: NOW - 1000,
    lastEventAt: NOW - 1000,
    ...overrides,
  };
  state.agents.a = agent;
  return { state, agent };
}

function pendingApproval(state: RoomState, requestedAt: number): void {
  state.approvals.x = { id: "x", agentId: "a", tool: "Bash", input: "ls", state: "pending", decidedBy: null, requestedAt };
}

describe("deriveHealth", () => {
  it("is green for an active agent", () => {
    const { state, agent } = setup();
    expect(deriveHealth(state, agent, NOW)).toEqual({ level: "green", reasons: [] });
  });

  it("is red when crashed or when the session is lost", () => {
    const crashed = setup({ process: "crashed", processDetail: "OOM" });
    expect(deriveHealth(crashed.state, crashed.agent, NOW)).toEqual({ level: "red", reasons: [{ code: "crashed", detail: "OOM" }] });
    const lost = setup({ resumability: "lost", resumabilityDetail: "missing transcript" });
    expect(deriveHealth(lost.state, lost.agent, NOW).reasons).toEqual([{ code: "session_lost", detail: "missing transcript" }]);
  });

  it("is yellow while an approval waits and red once it waits too long", () => {
    const { state, agent } = setup();
    pendingApproval(state, NOW - 60_000);
    expect(deriveHealth(state, agent, NOW)).toEqual({ level: "yellow", reasons: [{ code: "approvals_waiting", count: 1 }] });
    pendingApproval(state, NOW - T.approvalWaitMs - 60_000);
    expect(deriveHealth(state, agent, NOW)).toEqual({ level: "red", reasons: [{ code: "approvals_overdue", count: 1, minutes: 11 }] });
  });

  it("flags a silent working agent as stalled, with a longer limit while waiting for a GPU", () => {
    const silent = setup({ lastEventAt: NOW - T.stallMs - 60_000 });
    expect(deriveHealth(silent.state, silent.agent, NOW)).toEqual({ level: "yellow", reasons: [{ code: "stalled", minutes: 16 }] });
    const gpu = setup({ lastEventAt: NOW - T.stallMs - 60_000, phase: { value: "waiting_gpu", note: null, updatedAt: NOW - 60_000 } });
    expect(deriveHealth(gpu.state, gpu.agent, NOW).level).toBe("green");
    const idle = setup({ activity: "idle", lastEventAt: NOW - T.stallMs - 60_000 });
    expect(deriveHealth(idle.state, idle.agent, NOW).level).toBe("green");
  });

  it("flags a stale self-reported phase and a stopped agent", () => {
    const stale = setup({ phase: { value: "benchmarking", note: null, updatedAt: NOW - T.phaseStaleMs - 60_000 } });
    expect(deriveHealth(stale.state, stale.agent, NOW).reasons).toEqual([{ code: "phase_stale", phase: "benchmarking", minutes: 121 }]);
    const exited = setup({ process: "exited", activity: "idle" });
    expect(deriveHealth(exited.state, exited.agent, NOW)).toEqual({ level: "yellow", reasons: [{ code: "not_running" }] });
  });

  it("describes every reason in English for agents", () => {
    expect(
      [
        { code: "crashed", detail: null },
        { code: "crashed", detail: "OOM" },
        { code: "session_lost", detail: "gone" },
        { code: "approvals_overdue", count: 2, minutes: 12 },
        { code: "approvals_waiting", count: 1 },
        { code: "not_running" },
        { code: "context_full" },
        { code: "stalled", minutes: 20 },
        { code: "phase_stale", phase: "benchmarking", minutes: 130 },
      ].map((r) => describeHealthReason(r as Parameters<typeof describeHealthReason>[0])),
    ).toEqual([
      "crashed",
      "crashed: OOM",
      "session lost: gone",
      "2 approval(s) waiting 12 min",
      "1 approval(s) waiting for a human",
      "not running",
      "context window full",
      "no activity for 20 min",
      'phase "benchmarking" not updated for 130 min',
    ]);
  });
});

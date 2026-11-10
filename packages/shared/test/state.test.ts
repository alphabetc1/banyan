import { describe, expect, it } from "vitest";
import {
  applyEvent,
  authorize,
  emptyRoomState,
  isGoalWithin,
  pendingApprovalCount,
  type Actor,
  type EventDraft,
  type RoomState,
} from "../src/index.ts";

const SYSTEM: Actor = { kind: "system" };
const ALICE: Actor = { kind: "member", id: "alice" };
const BOB: Actor = { kind: "member", id: "bob" };
const ALICE_RUNNER: Actor = { kind: "runner", id: "runner-a" };
const BOB_RUNNER: Actor = { kind: "runner", id: "runner-b" };
const agent = (id: string): Actor => ({ kind: "agent", id });

let eventCounter = 0;
function draft<T extends EventDraft["type"]>(type: T, payload: Extract<EventDraft, { type: T }>["payload"]): EventDraft {
  eventCounter += 1;
  return { eventId: `e${eventCounter}`, type, payload } as EventDraft;
}

// Mirrors the server: authorize against current state, then apply with the next seq.
class Room {
  state: RoomState = emptyRoomState();
  submit(actor: Actor, d: EventDraft): string | null {
    const error = authorize(this.state, actor, d);
    if (error === null) applyEvent(this.state, { ...d, seq: this.state.lastSeq + 1, roomId: "room-1", ts: 1000 + this.state.lastSeq, actor });
    return error;
  }
  must(actor: Actor, d: EventDraft): void {
    expect(this.submit(actor, d)).toBeNull();
  }
}

// Root goal "perf" -> "prefill" -> "tokenizer"; group "prefill-group" on "prefill" with
// leader L (alice), monitor M (alice) and workers W1 (alice) and W2 (bob); a root group with leader R.
function seededRoom(): Room {
  const r = new Room();
  r.must(SYSTEM, draft("room.created", { name: "sglang perf", repoUrl: "git@github.com:me/sglang.git", baseBranch: "main", rootGoalId: "perf", rootGoalTitle: "Improve sglang performance", rootGoalDescription: "" }));
  r.must(SYSTEM, draft("member.joined", { memberId: "alice", displayName: "Alice", role: "owner" }));
  r.must(SYSTEM, draft("member.joined", { memberId: "bob", displayName: "Bob", role: "member" }));
  r.must(SYSTEM, draft("runner.registered", { runnerId: "runner-a", memberId: "alice", hostname: "mac" }));
  r.must(SYSTEM, draft("runner.registered", { runnerId: "runner-b", memberId: "bob", hostname: "linux" }));
  r.must(ALICE, draft("goal.created", { goalId: "prefill", parentId: "perf", title: "Improve prefill", description: "" }));
  r.must(ALICE, draft("goal.created", { goalId: "tokenizer", parentId: "prefill", title: "Faster tokenizer", description: "" }));
  r.must(ALICE, draft("group.created", { groupId: "root-group", goalId: "perf", name: "root" }));
  r.must(ALICE, draft("group.created", { groupId: "prefill-group", goalId: "prefill", name: "prefill" }));
  const base = { provider: "claude" as const, model: "claude-opus-5-5", instructions: "" };
  r.must(ALICE, draft("agent.created", { ...base, agentId: "R", groupId: "root-group", runnerId: "runner-a", name: "root-leader", role: "leader", goalId: "perf" }));
  r.must(ALICE, draft("agent.created", { ...base, agentId: "L", groupId: "prefill-group", runnerId: "runner-a", name: "leader", role: "leader", goalId: "prefill" }));
  r.must(ALICE, draft("agent.created", { ...base, agentId: "M", groupId: "prefill-group", runnerId: "runner-a", name: "monitor", role: "monitor", goalId: "prefill" }));
  r.must(ALICE, draft("agent.created", { ...base, agentId: "W1", groupId: "prefill-group", runnerId: "runner-a", name: "w1", role: "worker", goalId: "tokenizer" }));
  r.must(BOB, draft("agent.created", { ...base, provider: "codex", model: "gpt-5", agentId: "W2", groupId: "prefill-group", runnerId: "runner-b", name: "w2", role: "worker", goalId: "prefill" }));
  return r;
}

describe("projection", () => {
  it("builds the room, goal tree and group roles", () => {
    const r = seededRoom();
    expect(r.state.room?.rootGoalId).toBe("perf");
    expect(r.state.goals.tokenizer?.parentId).toBe("prefill");
    expect(r.state.groups["prefill-group"]).toMatchObject({ leaderAgentId: "L", monitorAgentId: "M" });
    expect(r.state.agents.W2).toMatchObject({ memberId: "bob", provider: "codex", process: "unknown", activity: "unknown" });
    expect(r.state.lastSeq).toBe(14);
  });

  it("tracks agent runtime state and liveness from runner reports", () => {
    const r = seededRoom();
    r.must(ALICE_RUNNER, draft("agent.session_bound", { agentId: "W1", providerSessionId: "sess-1" }));
    r.must(ALICE_RUNNER, draft("agent.process_changed", { agentId: "W1", process: "running" }));
    r.must(ALICE_RUNNER, draft("agent.activity_changed", { agentId: "W1", activity: "working" }));
    r.must(agent("W1"), draft("agent.phase_reported", { agentId: "W1", phase: "waiting_gpu", note: "queue position 3" }));
    r.must(ALICE_RUNNER, draft("transcript.appended", { agentId: "W1", entries: [{ kind: "assistant", text: "hi", ts: 1 }] }));
    const w1 = r.state.agents.W1!;
    expect(w1).toMatchObject({ providerSessionId: "sess-1", process: "running", activity: "working" });
    expect(w1.phase).toEqual({ value: "waiting_gpu", note: "queue position 3", updatedAt: 1000 + 17 });
    expect(w1.lastEventAt).toBe(1000 + 18);
  });

  it("keeps the reason for a resumability change", () => {
    const r = seededRoom();
    r.must(ALICE_RUNNER, draft("agent.resumability_changed", { agentId: "W1", resumability: "lost", detail: "session file missing after reboot" }));
    expect(r.state.agents.W1).toMatchObject({ resumability: "lost", resumabilityDetail: "session file missing after reboot" });
  });

  it("tracks worktrees", () => {
    const r = seededRoom();
    r.must(ALICE_RUNNER, draft("worktree.created", { worktreeId: "wt1", agentId: "W1", branch: "room/x/w1", baseSha: "abc" }));
    r.must(ALICE_RUNNER, draft("worktree.updated", { worktreeId: "wt1", headSha: "def", diffStat: { files: 2, insertions: 10, deletions: 3 } }));
    expect(r.state.agents.W1?.worktreeId).toBe("wt1");
    expect(r.state.worktrees.wt1).toMatchObject({ baseSha: "abc", headSha: "def", diffStat: { files: 2, insertions: 10, deletions: 3 } });
  });

  it("routes room-visible posts through leader review and lets humans override", () => {
    const r = seededRoom();
    r.must(agent("W1"), draft("post.created", { postId: "p1", agentId: "W1", kind: "finding", summary: "tokenizer is 30% of prefill", body: "", evidence: [], proposeRoomVisible: true }));
    r.must(agent("W1"), draft("post.created", { postId: "p2", agentId: "W1", kind: "direction", summary: "try batching", body: "", evidence: [], proposeRoomVisible: false }));
    expect(r.state.posts.p1).toMatchObject({ groupId: "prefill-group", goalId: "tokenizer", review: { state: "pending" } });
    expect(r.state.posts.p2?.review.state).toBe("none");

    r.must(agent("L"), draft("post.reviewed", { postId: "p1", decision: "approved", note: "solid" }));
    expect(r.state.posts.p1?.review).toEqual({ state: "approved", by: agent("L"), note: "solid" });

    r.must(BOB, draft("post.reviewed", { postId: "p1", decision: "rejected" }));
    expect(r.state.posts.p1?.review).toEqual({ state: "rejected", by: BOB, note: null });
  });

  it("counts pending approvals per agent", () => {
    const r = seededRoom();
    r.must(ALICE_RUNNER, draft("approval.requested", { approvalId: "a1", agentId: "W1", tool: "Bash", input: "rm -rf build" }));
    r.must(ALICE_RUNNER, draft("approval.requested", { approvalId: "a2", agentId: "W1", tool: "Write", input: "x" }));
    expect(pendingApprovalCount(r.state, "W1")).toBe(2);
    r.must(BOB, draft("approval.decided", { approvalId: "a1", decision: "denied" }));
    expect(pendingApprovalCount(r.state, "W1")).toBe(1);
    expect(r.state.approvals.a1).toMatchObject({ state: "denied", decidedBy: BOB });
  });

  it("isGoalWithin walks ancestors", () => {
    const r = seededRoom();
    expect(isGoalWithin(r.state, "tokenizer", "perf")).toBe(true);
    expect(isGoalWithin(r.state, "tokenizer", "tokenizer")).toBe(true);
    expect(isGoalWithin(r.state, "perf", "prefill")).toBe(false);
  });
});

describe("authorize", () => {
  it("reserves server-only events for the server", () => {
    const r = seededRoom();
    expect(r.submit(ALICE, draft("member.joined", { memberId: "eve", displayName: "Eve", role: "owner" }))).toMatch(/only be emitted by the server/);
  });

  it("rejects writes to a room that does not exist", () => {
    const r = new Room();
    expect(r.submit(ALICE, draft("group.created", { groupId: "g", goalId: "x", name: "g" }))).toBe("room does not exist");
  });

  it("only lets members start agents on their own runners", () => {
    const r = seededRoom();
    const d = draft("agent.created", { agentId: "X", groupId: "prefill-group", runnerId: "runner-b", name: "x", role: "worker", provider: "claude", model: "m", goalId: "prefill", instructions: "" });
    expect(r.submit(ALICE, d)).toBe("members may only start agents on their own runners");
  });

  it("enforces one leader and one monitor per group", () => {
    const r = seededRoom();
    const base = { groupId: "prefill-group", runnerId: "runner-a", name: "x", provider: "claude" as const, model: "m", goalId: "prefill", instructions: "" };
    expect(r.submit(ALICE, draft("agent.created", { ...base, agentId: "L2", role: "leader" }))).toBe("group already has a leader");
    expect(r.submit(ALICE, draft("agent.created", { ...base, agentId: "M2", role: "monitor" }))).toBe("group already has a monitor");
  });

  it("requires agent goals to lie within the group's goal", () => {
    const r = seededRoom();
    const d = draft("agent.created", { agentId: "X", groupId: "prefill-group", runnerId: "runner-a", name: "x", role: "worker", provider: "claude", model: "m", goalId: "perf", instructions: "" });
    expect(r.submit(ALICE, d)).toBe("agent goal must lie within its group's goal");
  });

  it("only lets an agent's own runner report its runtime state", () => {
    const r = seededRoom();
    expect(r.submit(BOB_RUNNER, draft("agent.process_changed", { agentId: "W1", process: "crashed" }))).toBe("only the agent's runner may report this");
    expect(r.submit(ALICE, draft("transcript.appended", { agentId: "W1", entries: [{ kind: "user", text: "x", ts: 1 }] }))).toBe("only the agent's runner may report this");
  });

  it("prevents agents from impersonating each other", () => {
    const r = seededRoom();
    expect(r.submit(agent("W2"), draft("agent.phase_reported", { agentId: "W1", phase: "x" }))).toBe("agents may only report their own phase");
    const post = draft("post.created", { postId: "p", agentId: "W1", kind: "finding", summary: "s", body: "", evidence: [], proposeRoomVisible: false });
    expect(r.submit(agent("W2"), post)).toBe("agents may only post as themselves");
  });

  it("restricts reviews to the post's own group leader, excluding self-review", () => {
    const r = seededRoom();
    r.must(agent("W1"), draft("post.created", { postId: "p1", agentId: "W1", kind: "finding", summary: "s", body: "", evidence: [], proposeRoomVisible: true }));
    r.must(agent("L"), draft("post.created", { postId: "pl", agentId: "L", kind: "conclusion", summary: "s", body: "", evidence: [], proposeRoomVisible: true }));
    expect(r.submit(agent("W2"), draft("post.reviewed", { postId: "p1", decision: "approved" }))).toBe("only the post's group leader may review it");
    expect(r.submit(agent("R"), draft("post.reviewed", { postId: "p1", decision: "approved" }))).toBe("only the post's group leader may review it");
    expect(r.submit(agent("L"), draft("post.reviewed", { postId: "pl", decision: "approved" }))).toBe("leaders may not review their own posts");
    r.must(agent("L"), draft("post.reviewed", { postId: "p1", decision: "approved" }));
    expect(r.submit(agent("L"), draft("post.reviewed", { postId: "p1", decision: "rejected" }))).toBe("post is not awaiting review");
  });

  it("lets leaders create goals only inside their subtree", () => {
    const r = seededRoom();
    r.must(agent("L"), draft("goal.created", { goalId: "kv", parentId: "prefill", title: "kv", description: "" }));
    expect(r.submit(agent("L"), draft("goal.created", { goalId: "decode", parentId: "perf", title: "decode", description: "" }))).toMatch(/covering group leader/);
    expect(r.submit(agent("W1"), draft("goal.status_changed", { goalId: "tokenizer", status: "done" }))).toMatch(/covering group leader/);
    r.must(agent("L"), draft("goal.status_changed", { goalId: "tokenizer", status: "done" }));
    expect(r.state.goals.tokenizer?.status).toBe("done");
  });

  it("enforces message routing rules", () => {
    const r = seededRoom();
    const msg = (to: string) => draft("message.sent", { messageId: `m-${to}-${eventCounter}`, toAgentId: to, text: "hi", delivery: "fyi" });
    r.must(agent("L"), msg("W2"));
    r.must(agent("M"), msg("L"));
    r.must(BOB, msg("W1"));
    expect(r.submit(agent("M"), msg("W1"))).toMatch(/monitors may only message their leader/);
    expect(r.submit(agent("W1"), msg("W2"))).toMatch(/leaders may message their group/);
    expect(r.submit(agent("L"), msg("R"))).toMatch(/leaders may message their group/);
    expect(r.submit(agent("L"), msg("L"))).toBe("agents may not message themselves");
  });

  it("allows deciding an approval once, by members only", () => {
    const r = seededRoom();
    r.must(ALICE_RUNNER, draft("approval.requested", { approvalId: "a1", agentId: "W1", tool: "Bash", input: "ls" }));
    expect(r.submit(agent("L"), draft("approval.decided", { approvalId: "a1", decision: "allowed" }))).toBe("only members may decide approvals");
    r.must(ALICE, draft("approval.decided", { approvalId: "a1", decision: "allowed" }));
    expect(r.submit(BOB, draft("approval.decided", { approvalId: "a1", decision: "denied" }))).toBe("approval already decided");
  });

  it("rejects duplicate ids", () => {
    const r = seededRoom();
    expect(r.submit(ALICE, draft("group.created", { groupId: "prefill-group", goalId: "perf", name: "dup" }))).toBe("group prefill-group already exists");
  });
});

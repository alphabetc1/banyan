import { describe, expect, it } from "vitest";
import { applyEvent, authorize, draft, emptyRoomState, type Actor, type EventDraft, type RoomState } from "@banyan/shared";
import { agentIcon, agentStatus, attentionItems, attentionKey, goalTree, groupAgents, groupsInSubtree, latestPost, ownAttention, postColumn, standaloneAgentsInSubtree } from "../src/derive.ts";
import { MESSAGES, reasonText } from "../src/i18n.ts";

const NOW = 2_000_000_000_000;
const SYSTEM: Actor = { kind: "system" };
const OWNER: Actor = { kind: "member", id: "m1" };
const RUNNER: Actor = { kind: "runner", id: "r1" };

function build(steps: [Actor, EventDraft][]): RoomState {
  const state = emptyRoomState();
  for (const [actor, d] of steps) {
    expect(authorize(state, actor, d)).toBeNull();
    applyEvent(state, { ...d, seq: state.lastSeq + 1, roomId: "room", ts: NOW - 1000, actor });
  }
  return state;
}

const agentBase = { runnerId: "r1", provider: "claude" as const, model: "default", instructions: "" };

function room(): RoomState {
  return build([
    [SYSTEM, draft("room.created", { name: "r", repoUrl: "u", baseBranch: "main", rootGoalId: "root", rootGoalTitle: "perf", rootGoalDescription: "" })],
    [SYSTEM, draft("member.joined", { memberId: "m1", displayName: "Rhett", role: "owner" })],
    [SYSTEM, draft("runner.registered", { runnerId: "r1", memberId: "m1", hostname: "mac" })],
    [OWNER, draft("goal.created", { goalId: "prefill", parentId: "root", title: "prefill", description: "" })],
    [OWNER, draft("goal.created", { goalId: "tok", parentId: "prefill", title: "tokenizer", description: "" })],
    [OWNER, draft("goal.created", { goalId: "decode", parentId: "root", title: "decode", description: "" })],
    [OWNER, draft("group.created", { groupId: "g", goalId: "prefill", name: "prefill" })],
    [OWNER, draft("agent.created", { ...agentBase, agentId: "w", groupId: "g", name: "w", role: "worker", goalId: "tok" })],
    [OWNER, draft("agent.created", { ...agentBase, agentId: "l", groupId: "g", name: "l", role: "leader", goalId: "prefill" })],
    [OWNER, draft("agent.created", { ...agentBase, agentId: "m", groupId: "g", name: "m", role: "monitor", goalId: "prefill" })],
    [RUNNER, draft("agent.process_changed", { agentId: "w", process: "running" })],
  ]);
}

describe("derive", () => {
  it("builds the goal tree with agent counts per subtree", () => {
    const tree = goalTree(room())!;
    expect(tree.goal.title).toBe("perf");
    expect(tree.agentCount).toBe(3);
    expect(tree.children.map((c) => [c.goal.title, c.agentCount])).toEqual([
      ["prefill", 3],
      ["decode", 0],
    ]);
    expect(tree.children[0]!.children.map((c) => [c.goal.title, c.agentCount])).toEqual([["tokenizer", 1]]);
  });

  it("lists groups in a goal's subtree, shallowest first", () => {
    const s = room();
    applyEvent(s, { ...draft("group.created", { groupId: "gt", goalId: "tok", name: "tok" }), seq: 50, roomId: "room", ts: NOW, actor: OWNER });
    expect(groupsInSubtree(s, "root").map((g) => g.id)).toEqual(["g", "gt"]);
    expect(groupsInSubtree(s, "tok").map((g) => g.id)).toEqual(["gt"]);
    expect(groupsInSubtree(s, "decode")).toEqual([]);
  });

  it("orders a group leader, monitor, then workers", () => {
    expect(groupAgents(room(), "g").map((a) => a.id)).toEqual(["l", "m", "w"]);
  });

  it("marks agents of disconnected runners as offline, keeping red problems red", () => {
    const s = room();
    expect(agentStatus(s, s.agents.w!, ["r1"], NOW).level).toBe("green");
    expect(agentStatus(s, s.agents.w!, [], NOW)).toEqual({ level: "offline", reasons: [{ code: "runner_offline" }] });
    applyEvent(s, { ...draft("agent.process_changed", { agentId: "w", process: "crashed", detail: "OOM" }), seq: 99, roomId: "room", ts: NOW, actor: RUNNER });
    expect(agentStatus(s, s.agents.w!, [], NOW)).toEqual({ level: "red", reasons: [{ code: "runner_offline" }, { code: "crashed", detail: "OOM" }] });
  });

  it("collects approvals, red agents and human-only reviews for the attention inbox", () => {
    const s = room();
    const steps: [Actor, EventDraft][] = [
      [RUNNER, draft("approval.requested", { approvalId: "a1", agentId: "w", tool: "Bash", input: "make" })],
      [RUNNER, draft("agent.process_changed", { agentId: "m", process: "crashed" })],
      [{ kind: "agent", id: "w" }, draft("post.created", { postId: "pw", agentId: "w", kind: "finding", summary: "worker finding", body: "", evidence: [], proposeRoomVisible: true })],
      // The leader of the top group has no parent leader, so only humans can review this.
      [{ kind: "agent", id: "l" }, draft("post.created", { postId: "pl", agentId: "l", kind: "conclusion", summary: "leader conclusion", body: "", evidence: [], proposeRoomVisible: true })],
    ];
    for (const [actor, d] of steps) {
      expect(authorize(s, actor, d)).toBeNull();
      applyEvent(s, { ...d, seq: s.lastSeq + 1, roomId: "room", ts: NOW, actor });
    }
    expect(attentionItems(s, ["r1"], NOW)).toEqual([
      { kind: "approval", approvalId: "a1", agentId: "w", tool: "Bash", since: NOW },
      { kind: "unhealthy", agentId: "m", reasons: [{ code: "crashed", detail: null }] },
      { kind: "review", postId: "pl", agentId: "l", summary: "leader conclusion" },
    ]);
  });

  it("keeps only attention items about agents on the member's own runners", () => {
    const s = room();
    const steps: [Actor, EventDraft][] = [
      [SYSTEM, draft("member.joined", { memberId: "m2", displayName: "Ada", role: "member" })],
      [SYSTEM, draft("runner.registered", { runnerId: "r2", memberId: "m2", hostname: "linux" })],
      [{ kind: "member", id: "m2" }, draft("agent.created", { ...agentBase, runnerId: "r2", agentId: "x", groupId: "g", name: "x", role: "worker", goalId: "tok" })],
    ];
    for (const [actor, d] of steps) applyEvent(s, { ...d, seq: s.lastSeq + 1, roomId: "room", ts: NOW, actor });
    const mine = { kind: "approval" as const, approvalId: "a1", agentId: "w", tool: "Bash", since: NOW };
    const theirs = { kind: "unhealthy" as const, agentId: "x", reasons: [] };
    const unknown = { kind: "review" as const, postId: "p", agentId: "gone", summary: "" };
    expect(ownAttention(s, "m1", [mine, theirs, unknown])).toEqual([mine]);
    expect(ownAttention(s, "m2", [mine, theirs, unknown])).toEqual([theirs]);
  });

  it("lists standalone agents in a goal's subtree, oldest first", () => {
    const s = room();
    const solo = (agentId: string, goalId: string, ts: number) => {
      const d = draft("agent.created", { ...agentBase, agentId, groupId: null, name: agentId, role: "worker", goalId });
      applyEvent(s, { ...d, seq: s.lastSeq + 1, roomId: "room", ts, actor: OWNER });
    };
    solo("s-tok", "tok", NOW + 2);
    solo("s-root", "root", NOW + 1);
    solo("s-decode", "decode", NOW + 3);
    expect(standaloneAgentsInSubtree(s, "root").map((a) => a.id)).toEqual(["s-root", "s-tok", "s-decode"]);
    expect(standaloneAgentsInSubtree(s, "prefill").map((a) => a.id)).toEqual(["s-tok"]);
    expect(standaloneAgentsInSubtree(s, "decode").map((a) => a.id)).toEqual(["s-decode"]);
  });

  it("shows each agent as one icon: needs you, working, done, error, offline, stopped, starting, terminal", () => {
    const s = room();
    const report = (agentId: string, d: EventDraft, actor: Actor = RUNNER) => applyEvent(s, { ...d, seq: s.lastSeq + 1, roomId: "room", ts: NOW, actor });
    const icon = (id: string, online = ["r1"]) => agentIcon(s, s.agents[id]!, online, NOW);
    // w is running with unknown activity: still starting up.
    expect(icon("w")).toBe("starting");
    report("w", draft("agent.activity_changed", { agentId: "w", activity: "working" }));
    expect(icon("w")).toBe("working");
    report("w", draft("agent.activity_changed", { agentId: "w", activity: "idle" }));
    expect(icon("w")).toBe("done");
    report("w", draft("agent.activity_changed", { agentId: "w", activity: "awaiting_input" }));
    expect(icon("w")).toBe("needs_you");
    report("w", draft("agent.activity_changed", { agentId: "w", activity: "working" }));
    report("w", draft("approval.requested", { approvalId: "a9", agentId: "w", tool: "Bash", input: "ls" }));
    expect(icon("w")).toBe("needs_you");
    expect(icon("w", [])).toBe("offline");
    report("l", draft("agent.process_changed", { agentId: "l", process: "crashed", detail: "boom" }));
    expect(icon("l")).toBe("error");
    report("m", draft("agent.process_changed", { agentId: "m", process: "exited" }));
    expect(icon("m")).toBe("stopped");
    report("x", draft("agent.created", { ...agentBase, agentId: "sh", groupId: null, name: "sh", role: "worker", provider: "shell", goalId: "root", terminal: true }), OWNER);
    expect(icon("sh")).toBe("starting");
    report("sh", draft("agent.process_changed", { agentId: "sh", process: "running" }));
    expect(icon("sh")).toBe("terminal");
  });

  it("keys attention items by what they are about", () => {
    expect(attentionKey({ kind: "approval", approvalId: "a1", agentId: "w", tool: "Bash", since: NOW })).toBe("approval:a1");
    expect(attentionKey({ kind: "unhealthy", agentId: "w", reasons: [] })).toBe("unhealthy:w");
    expect(attentionKey({ kind: "review", postId: "p1", agentId: "w", summary: "" })).toBe("review:p1");
  });

  it("places posts into findings columns", () => {
    const base = { id: "p", agentId: "a", groupId: "g", goalId: "x", summary: "", body: "", evidence: [], createdAt: 0 };
    expect(postColumn({ ...base, kind: "direction", proposeRoomVisible: false, review: { state: "none", by: null, note: null } })).toBeNull();
    expect(postColumn({ ...base, kind: "finding", proposeRoomVisible: true, review: { state: "pending", by: null, note: null } })).toBe("pending");
    expect(postColumn({ ...base, kind: "finding", proposeRoomVisible: true, review: { state: "approved", by: null, note: null } })).toBe("room");
    expect(postColumn({ ...base, kind: "finding", proposeRoomVisible: false, review: { state: "none", by: null, note: null } })).toBe("group");
    expect(postColumn({ ...base, kind: "finding", proposeRoomVisible: true, review: { state: "rejected", by: null, note: null } })).toBeNull();
  });

  it("finds an agent's latest post of a kind", () => {
    const s = room();
    for (const [i, summary] of ["first", "second"].entries()) {
      const d = draft("post.created", { postId: `d${i}`, agentId: "w", kind: "direction", summary, body: "", evidence: [], proposeRoomVisible: false });
      applyEvent(s, { ...d, seq: 100 + i, roomId: "room", ts: NOW + i, actor: { kind: "agent", id: "w" } });
    }
    expect(latestPost(s, "w", "direction")?.summary).toBe("second");
    expect(latestPost(s, "w", "finding")).toBeUndefined();
  });
});

describe("i18n", () => {
  it("translates every key into both languages", () => {
    expect(Object.keys(MESSAGES.zh).sort()).toEqual(Object.keys(MESSAGES.en).sort());
    for (const lang of ["zh", "en"] as const) for (const v of Object.values(MESSAGES[lang])) expect(v.trim()).not.toBe("");
  });

  it("renders status reasons in both languages", () => {
    expect(reasonText("zh", { code: "approvals_waiting", count: 2 })).toBe("2 个审批待处理");
    expect(reasonText("en", { code: "approvals_waiting", count: 2 })).toBe("2 approval(s) waiting for a human");
    expect(reasonText("zh", { code: "phase_stale", phase: "benchmarking", minutes: 130 })).toBe("阶段「benchmarking」130 分钟未更新");
    expect(reasonText("en", { code: "runner_offline" })).toBe("runner offline");
  });
});

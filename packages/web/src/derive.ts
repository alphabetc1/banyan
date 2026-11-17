// View-model derivations over the room projection, kept pure for testing.
import { deriveHealth, goalPath, isGoalWithin, postReviewers, type Actor, type Agent, type Goal, type Group, type Health, type HealthReason, type Post, type RoomState } from "@banyan/shared";

export type CardStatus = Health["level"] | "offline";

export type StatusReason = HealthReason | { code: "runner_offline" };

export interface AgentStatus {
  level: CardStatus;
  reasons: StatusReason[];
}

// Health plus runner presence: an agent whose runner is disconnected cannot be trusted to be
// alive, whatever its last reported state says.
export function agentStatus(state: RoomState, agent: Agent, onlineRunnerIds: string[], now: number): AgentStatus {
  const health = deriveHealth(state, agent, now);
  if (!onlineRunnerIds.includes(agent.runnerId) && agent.process !== "exited") {
    return { level: health.level === "red" ? "red" : "offline", reasons: [{ code: "runner_offline" }, ...health.reasons] };
  }
  return health;
}

export interface GoalNode {
  goal: Goal;
  children: GoalNode[];
  // Agents whose own goal lies in this subtree.
  agentCount: number;
}

export function goalTree(state: RoomState): GoalNode | null {
  const root = state.room ? state.goals[state.room.rootGoalId] : undefined;
  if (!root) return null;
  const children = new Map<string, Goal[]>();
  for (const g of Object.values(state.goals)) {
    if (g.parentId === null) continue;
    const list = children.get(g.parentId) ?? [];
    list.push(g);
    children.set(g.parentId, list);
  }
  const ownAgents = new Map<string, number>();
  for (const a of Object.values(state.agents)) ownAgents.set(a.goalId, (ownAgents.get(a.goalId) ?? 0) + 1);
  const build = (goal: Goal, seen: Set<string>): GoalNode => {
    seen.add(goal.id);
    const kids = (children.get(goal.id) ?? []).filter((c) => !seen.has(c.id)).sort((a, b) => a.createdAt - b.createdAt).map((c) => build(c, seen));
    return { goal, children: kids, agentCount: (ownAgents.get(goal.id) ?? 0) + kids.reduce((n, k) => n + k.agentCount, 0) };
  };
  return build(root, new Set());
}

// Groups on the goal and everywhere beneath it, shallowest goal first.
export function groupsInSubtree(state: RoomState, goalId: string): Group[] {
  const depth = (g: Group) => goalPath(state, g.goalId).length;
  return Object.values(state.groups)
    .filter((g) => isGoalWithin(state, g.goalId, goalId))
    .sort((a, b) => depth(a) - depth(b));
}

// Agents outside any group whose goal lies in the subtree, oldest first.
export function standaloneAgentsInSubtree(state: RoomState, goalId: string): Agent[] {
  return Object.values(state.agents)
    .filter((a) => a.groupId === null && isGoalWithin(state, a.goalId, goalId))
    .sort((a, b) => a.createdAt - b.createdAt);
}

// Leader first, then monitor, then workers by creation time.
export function groupAgents(state: RoomState, groupId: string): Agent[] {
  const rank = { leader: 0, monitor: 1, worker: 2 } as const;
  return Object.values(state.agents)
    .filter((a) => a.groupId === groupId)
    .sort((a, b) => rank[a.role] - rank[b.role] || a.createdAt - b.createdAt);
}

export type AttentionItem =
  | { kind: "approval"; approvalId: string; agentId: string; tool: string; since: number }
  | { kind: "unhealthy"; agentId: string; reasons: StatusReason[] }
  | { kind: "review"; postId: string; agentId: string; summary: string }
  | { kind: "input"; agentId: string };

// What needs a human: pending approvals, terminal agents waiting for input, red agents, and
// posts no agent can review.
export function attentionItems(state: RoomState, onlineRunnerIds: string[], now: number): AttentionItem[] {
  const items: AttentionItem[] = [];
  for (const a of Object.values(state.approvals)) {
    if (a.state === "pending") items.push({ kind: "approval", approvalId: a.id, agentId: a.agentId, tool: a.tool, since: a.requestedAt });
  }
  for (const agent of Object.values(state.agents)) {
    if (agent.process === "running" && agent.activity === "awaiting_input") items.push({ kind: "input", agentId: agent.id });
    const status = agentStatus(state, agent, onlineRunnerIds, now);
    if (status.level === "red") items.push({ kind: "unhealthy", agentId: agent.id, reasons: status.reasons });
  }
  for (const p of Object.values(state.posts)) {
    if (p.review.state === "pending" && postReviewers(state, p).length === 0) items.push({ kind: "review", postId: p.id, agentId: p.agentId, summary: p.summary });
  }
  return items;
}

export function attentionKey(item: AttentionItem): string {
  switch (item.kind) {
    case "approval":
      return `approval:${item.approvalId}`;
    case "unhealthy":
      return `unhealthy:${item.agentId}`;
    case "review":
      return `review:${item.postId}`;
    case "input":
      return `input:${item.agentId}`;
  }
}

// Attention items about agents hosted on one of this member's runners.
export function ownAttention(state: RoomState, memberId: string, items: AttentionItem[]): AttentionItem[] {
  return items.filter((item) => {
    const agent = state.agents[item.agentId];
    return agent !== undefined && state.runners[agent.runnerId]?.memberId === memberId;
  });
}

export type PostColumn = "pending" | "group" | "room";

export function postColumn(p: Post): PostColumn | null {
  if (p.kind === "direction") return null;
  if (p.review.state === "pending") return "pending";
  if (p.proposeRoomVisible && p.review.state === "approved") return "room";
  return p.review.state === "rejected" ? null : "group";
}

export function actorName(state: RoomState, actor: Actor | null): string {
  if (!actor) return "";
  if (actor.kind === "agent") return state.agents[actor.id]?.name ?? actor.id;
  if (actor.kind === "member") return state.members[actor.id]?.displayName ?? actor.id;
  return actor.kind;
}

export function latestPost(state: RoomState, agentId: string, kind: Post["kind"]): Post | undefined {
  let latest: Post | undefined;
  for (const p of Object.values(state.posts)) if (p.agentId === agentId && p.kind === kind && (!latest || p.createdAt > latest.createdAt)) latest = p;
  return latest;
}

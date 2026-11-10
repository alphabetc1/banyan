// Room projection: a pure reducer over the event log, shared by server, runner and web UI.
// It assumes events were validated by the server before being appended.
import type {
  Activity,
  Actor,
  AgentRole,
  ApprovalDecision,
  DiffStat,
  Evidence,
  GoalStatus,
  PostKind,
  ProcessState,
  Provider,
  Resumability,
  RoomEvent,
} from "./events.ts";

export interface Room {
  id: string;
  name: string;
  repoUrl: string;
  baseBranch: string;
  rootGoalId: string;
  createdAt: number;
}

export interface Member {
  id: string;
  displayName: string;
  role: "owner" | "member";
}

export interface Runner {
  id: string;
  memberId: string;
  hostname: string;
}

export interface Goal {
  id: string;
  parentId: string | null;
  title: string;
  description: string;
  status: GoalStatus;
  createdAt: number;
}

export interface Group {
  id: string;
  goalId: string;
  name: string;
  leaderAgentId: string | null;
  monitorAgentId: string | null;
}

export interface Phase {
  value: string;
  note: string | null;
  updatedAt: number;
}

export interface Agent {
  id: string;
  groupId: string;
  runnerId: string;
  memberId: string;
  name: string;
  role: AgentRole;
  provider: Provider;
  model: string;
  goalId: string;
  instructions: string;
  providerSessionId: string | null;
  process: ProcessState;
  processDetail: string | null;
  activity: Activity;
  resumability: Resumability;
  resumabilityDetail: string | null;
  phase: Phase | null;
  worktreeId: string | null;
  createdAt: number;
  // Timestamp of the latest event about this agent, used for stall detection.
  lastEventAt: number;
}

export interface Worktree {
  id: string;
  agentId: string;
  branch: string;
  baseSha: string;
  headSha: string;
  diffStat: DiffStat;
  updatedAt: number;
}

export interface Post {
  id: string;
  agentId: string;
  groupId: string;
  goalId: string;
  kind: PostKind;
  summary: string;
  body: string;
  evidence: Evidence[];
  proposeRoomVisible: boolean;
  review: { state: "pending" | "approved" | "rejected" | "none"; by: Actor | null; note: string | null };
  createdAt: number;
}

export interface Approval {
  id: string;
  agentId: string;
  tool: string;
  input: string;
  state: "pending" | ApprovalDecision;
  decidedBy: Actor | null;
  requestedAt: number;
}

export interface Message {
  id: string;
  from: Actor;
  toAgentId: string;
  text: string;
  delivery: "steer" | "fyi";
  sentAt: number;
}

export interface RoomState {
  room: Room | null;
  members: Record<string, Member>;
  runners: Record<string, Runner>;
  goals: Record<string, Goal>;
  groups: Record<string, Group>;
  agents: Record<string, Agent>;
  worktrees: Record<string, Worktree>;
  posts: Record<string, Post>;
  approvals: Record<string, Approval>;
  messages: Record<string, Message>;
  lastSeq: number;
}

export function emptyRoomState(): RoomState {
  return {
    room: null,
    members: {},
    runners: {},
    goals: {},
    groups: {},
    agents: {},
    worktrees: {},
    posts: {},
    approvals: {},
    messages: {},
    lastSeq: 0,
  };
}

function touchAgent(state: RoomState, agentId: string, ts: number): Agent | undefined {
  const agent = state.agents[agentId];
  if (agent) agent.lastEventAt = Math.max(agent.lastEventAt, ts);
  return agent;
}

// Mutates and returns `state`. Callers that need immutability (React) should clone first.
export function applyEvent(state: RoomState, e: RoomEvent): RoomState {
  state.lastSeq = e.seq;
  switch (e.type) {
    case "room.created": {
      const p = e.payload;
      state.room = { id: e.roomId, name: p.name, repoUrl: p.repoUrl, baseBranch: p.baseBranch, rootGoalId: p.rootGoalId, createdAt: e.ts };
      state.goals[p.rootGoalId] = {
        id: p.rootGoalId,
        parentId: null,
        title: p.rootGoalTitle,
        description: p.rootGoalDescription,
        status: "open",
        createdAt: e.ts,
      };
      break;
    }
    case "member.joined":
      state.members[e.payload.memberId] = { id: e.payload.memberId, displayName: e.payload.displayName, role: e.payload.role };
      break;
    case "runner.registered":
      state.runners[e.payload.runnerId] = { id: e.payload.runnerId, memberId: e.payload.memberId, hostname: e.payload.hostname };
      break;
    case "goal.created": {
      const p = e.payload;
      state.goals[p.goalId] = { id: p.goalId, parentId: p.parentId, title: p.title, description: p.description, status: "open", createdAt: e.ts };
      break;
    }
    case "goal.status_changed": {
      const goal = state.goals[e.payload.goalId];
      if (goal) goal.status = e.payload.status;
      break;
    }
    case "group.created":
      state.groups[e.payload.groupId] = {
        id: e.payload.groupId,
        goalId: e.payload.goalId,
        name: e.payload.name,
        leaderAgentId: null,
        monitorAgentId: null,
      };
      break;
    case "agent.created": {
      const p = e.payload;
      const runner = state.runners[p.runnerId];
      state.agents[p.agentId] = {
        id: p.agentId,
        groupId: p.groupId,
        runnerId: p.runnerId,
        memberId: runner?.memberId ?? "",
        name: p.name,
        role: p.role,
        provider: p.provider,
        model: p.model,
        goalId: p.goalId,
        instructions: p.instructions,
        providerSessionId: null,
        process: "unknown",
        processDetail: null,
        activity: "unknown",
        resumability: "live",
        resumabilityDetail: null,
        phase: null,
        worktreeId: null,
        createdAt: e.ts,
        lastEventAt: e.ts,
      };
      const group = state.groups[p.groupId];
      if (group && p.role === "leader") group.leaderAgentId = p.agentId;
      if (group && p.role === "monitor") group.monitorAgentId = p.agentId;
      break;
    }
    case "agent.session_bound": {
      const agent = touchAgent(state, e.payload.agentId, e.ts);
      if (agent) agent.providerSessionId = e.payload.providerSessionId;
      break;
    }
    case "agent.process_changed": {
      const agent = touchAgent(state, e.payload.agentId, e.ts);
      if (agent) {
        agent.process = e.payload.process;
        agent.processDetail = e.payload.detail ?? null;
      }
      break;
    }
    case "agent.activity_changed": {
      const agent = touchAgent(state, e.payload.agentId, e.ts);
      if (agent) agent.activity = e.payload.activity;
      break;
    }
    case "agent.resumability_changed": {
      const agent = touchAgent(state, e.payload.agentId, e.ts);
      if (agent) {
        agent.resumability = e.payload.resumability;
        agent.resumabilityDetail = e.payload.detail ?? null;
      }
      break;
    }
    case "agent.phase_reported": {
      const agent = touchAgent(state, e.payload.agentId, e.ts);
      if (agent) agent.phase = { value: e.payload.phase, note: e.payload.note ?? null, updatedAt: e.ts };
      break;
    }
    case "worktree.created": {
      const p = e.payload;
      state.worktrees[p.worktreeId] = {
        id: p.worktreeId,
        agentId: p.agentId,
        branch: p.branch,
        baseSha: p.baseSha,
        headSha: p.baseSha,
        diffStat: { files: 0, insertions: 0, deletions: 0 },
        updatedAt: e.ts,
      };
      const agent = touchAgent(state, p.agentId, e.ts);
      if (agent) agent.worktreeId = p.worktreeId;
      break;
    }
    case "worktree.updated": {
      const wt = state.worktrees[e.payload.worktreeId];
      if (wt) {
        wt.headSha = e.payload.headSha;
        wt.diffStat = e.payload.diffStat;
        wt.updatedAt = e.ts;
        touchAgent(state, wt.agentId, e.ts);
      }
      break;
    }
    case "post.created": {
      const p = e.payload;
      const agent = touchAgent(state, p.agentId, e.ts);
      if (!agent) break;
      state.posts[p.postId] = {
        id: p.postId,
        agentId: p.agentId,
        groupId: agent.groupId,
        goalId: agent.goalId,
        kind: p.kind,
        summary: p.summary,
        body: p.body,
        evidence: p.evidence,
        proposeRoomVisible: p.proposeRoomVisible,
        review: { state: p.proposeRoomVisible ? "pending" : "none", by: null, note: null },
        createdAt: e.ts,
      };
      break;
    }
    case "post.reviewed": {
      const post = state.posts[e.payload.postId];
      if (post) post.review = { state: e.payload.decision, by: e.actor, note: e.payload.note ?? null };
      break;
    }
    case "approval.requested": {
      const p = e.payload;
      touchAgent(state, p.agentId, e.ts);
      state.approvals[p.approvalId] = {
        id: p.approvalId,
        agentId: p.agentId,
        tool: p.tool,
        input: p.input,
        state: "pending",
        decidedBy: null,
        requestedAt: e.ts,
      };
      break;
    }
    case "approval.decided": {
      const approval = state.approvals[e.payload.approvalId];
      if (approval) {
        approval.state = e.payload.decision;
        approval.decidedBy = e.actor;
      }
      break;
    }
    case "message.sent": {
      const p = e.payload;
      state.messages[p.messageId] = { id: p.messageId, from: e.actor, toAgentId: p.toAgentId, text: p.text, delivery: p.delivery, sentAt: e.ts };
      break;
    }
    case "transcript.appended":
      // Transcript content is stored and paged separately; it only refreshes liveness here.
      touchAgent(state, e.payload.agentId, e.ts);
      break;
  }
  return state;
}

// True when `goalId` equals `ancestorId` or lies beneath it in the goal tree.
export function isGoalWithin(state: RoomState, goalId: string, ancestorId: string): boolean {
  let current: string | null = goalId;
  const seen = new Set<string>();
  while (current !== null && !seen.has(current)) {
    if (current === ancestorId) return true;
    seen.add(current);
    current = state.goals[current]?.parentId ?? null;
  }
  return false;
}

export function pendingApprovalCount(state: RoomState, agentId: string): number {
  return Object.values(state.approvals).filter((a) => a.agentId === agentId && a.state === "pending").length;
}

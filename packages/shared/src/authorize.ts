// Write authorization and referential checks for event drafts.
// The server runs this before appending; it returns a reason string when the draft is rejected.
import { SERVER_ONLY_EVENT_TYPES, type Actor, type EventDraft } from "./events.ts";
import { isGoalWithin, postReviewers, type Agent, type RoomState } from "./state.ts";

function agentOwnedByRunner(state: RoomState, actor: Actor, agentId: string): string | null {
  const agent = state.agents[agentId];
  if (!agent) return `unknown agent ${agentId}`;
  if (actor.kind !== "runner" || agent.runnerId !== actor.id) return "only the agent's runner may report this";
  return null;
}

function actingAgent(state: RoomState, actor: Actor): Agent | null {
  return actor.kind === "agent" ? (state.agents[actor.id] ?? null) : null;
}

// A leader may manage goals inside the subtree rooted at its group's goal.
function leaderCovers(state: RoomState, actor: Actor, goalId: string): boolean {
  const agent = actingAgent(state, actor);
  if (!agent || agent.role !== "leader") return false;
  const group = state.groups[agent.groupId];
  return group !== undefined && isGoalWithin(state, goalId, group.goalId);
}

type ServerOnlyDraft = Extract<EventDraft, { type: (typeof SERVER_ONLY_EVENT_TYPES)[number] }>;

function isServerOnly(draft: EventDraft): draft is ServerOnlyDraft {
  return (SERVER_ONLY_EVENT_TYPES as readonly string[]).includes(draft.type);
}

export function authorize(state: RoomState, actor: Actor, draft: EventDraft): string | null {
  if (isServerOnly(draft)) {
    return actor.kind === "system" ? null : `${draft.type} can only be emitted by the server`;
  }
  if (!state.room) return "room does not exist";

  switch (draft.type) {
    case "goal.created": {
      const p = draft.payload;
      if (state.goals[p.goalId]) return `goal ${p.goalId} already exists`;
      if (!state.goals[p.parentId]) return `unknown parent goal ${p.parentId}`;
      if (actor.kind === "member" || leaderCovers(state, actor, p.parentId)) return null;
      return "only members or the covering group leader may create goals";
    }
    case "goal.status_changed": {
      if (!state.goals[draft.payload.goalId]) return `unknown goal ${draft.payload.goalId}`;
      if (actor.kind === "member" || leaderCovers(state, actor, draft.payload.goalId)) return null;
      return "only members or the covering group leader may change goal status";
    }
    case "group.created": {
      const p = draft.payload;
      if (actor.kind !== "member") return "only members may create groups";
      if (state.groups[p.groupId]) return `group ${p.groupId} already exists`;
      if (!state.goals[p.goalId]) return `unknown goal ${p.goalId}`;
      return null;
    }
    case "agent.created": {
      const p = draft.payload;
      if (actor.kind !== "member") return "only members may create agents";
      if (state.agents[p.agentId]) return `agent ${p.agentId} already exists`;
      const group = state.groups[p.groupId];
      if (!group) return `unknown group ${p.groupId}`;
      const runner = state.runners[p.runnerId];
      if (!runner) return `unknown runner ${p.runnerId}`;
      if (runner.memberId !== actor.id) return "members may only start agents on their own runners";
      if (!state.goals[p.goalId]) return `unknown goal ${p.goalId}`;
      if (!isGoalWithin(state, p.goalId, group.goalId)) return "agent goal must lie within its group's goal";
      if (p.role === "leader" && group.leaderAgentId !== null) return "group already has a leader";
      if (p.role === "monitor" && group.monitorAgentId !== null) return "group already has a monitor";
      return null;
    }
    case "agent.session_bound":
    case "agent.process_changed":
    case "agent.activity_changed":
    case "agent.resumability_changed":
    case "transcript.appended":
      return agentOwnedByRunner(state, actor, draft.payload.agentId);
    case "worktree.created":
      if (state.worktrees[draft.payload.worktreeId]) return `worktree ${draft.payload.worktreeId} already exists`;
      return agentOwnedByRunner(state, actor, draft.payload.agentId);
    case "worktree.updated": {
      const wt = state.worktrees[draft.payload.worktreeId];
      if (!wt) return `unknown worktree ${draft.payload.worktreeId}`;
      return agentOwnedByRunner(state, actor, wt.agentId);
    }
    case "approval.requested":
      if (state.approvals[draft.payload.approvalId]) return `approval ${draft.payload.approvalId} already exists`;
      return agentOwnedByRunner(state, actor, draft.payload.agentId);
    case "approval.decided": {
      if (actor.kind !== "member") return "only members may decide approvals";
      const approval = state.approvals[draft.payload.approvalId];
      if (!approval) return `unknown approval ${draft.payload.approvalId}`;
      if (approval.state !== "pending") return "approval already decided";
      return null;
    }
    case "approval.expired": {
      const approval = state.approvals[draft.payload.approvalId];
      if (!approval) return `unknown approval ${draft.payload.approvalId}`;
      if (approval.state !== "pending") return "approval already decided";
      return agentOwnedByRunner(state, actor, approval.agentId);
    }
    case "agent.phase_reported":
      if (actor.kind !== "agent" || actor.id !== draft.payload.agentId) return "agents may only report their own phase";
      return state.agents[actor.id] ? null : `unknown agent ${actor.id}`;
    case "post.created":
      if (actor.kind !== "agent" || actor.id !== draft.payload.agentId) return "agents may only post as themselves";
      if (!state.agents[actor.id]) return `unknown agent ${actor.id}`;
      if (state.posts[draft.payload.postId]) return `post ${draft.payload.postId} already exists`;
      return null;
    case "post.reviewed": {
      const post = state.posts[draft.payload.postId];
      if (!post) return `unknown post ${draft.payload.postId}`;
      // Humans may override any review decision at any time.
      if (actor.kind === "member") return null;
      const agent = actingAgent(state, actor);
      if (!agent || !postReviewers(state, post).includes(agent.id)) {
        return "only the post's group leader, or the parent leader for a leader's own post, may review it";
      }
      if (post.review.state !== "pending") return "post is not awaiting review";
      return null;
    }
    case "message.sent": {
      const p = draft.payload;
      if (state.messages[p.messageId]) return `message ${p.messageId} already exists`;
      const target = state.agents[p.toAgentId];
      if (!target) return `unknown agent ${p.toAgentId}`;
      if (actor.kind === "member") return null;
      const sender = actingAgent(state, actor);
      if (!sender) return "only members or agents may send messages";
      if (sender.id === target.id) return "agents may not message themselves";
      const group = state.groups[sender.groupId];
      if (sender.role === "leader" && target.groupId === sender.groupId) return null;
      if (sender.role === "monitor" && group?.leaderAgentId === target.id) return null;
      return "leaders may message their group; monitors may only message their leader";
    }
  }
}

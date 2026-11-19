// Write authorization and referential checks for event drafts.
// The server runs this before appending; it returns a reason string when the draft is rejected.
import { SERVER_ONLY_EVENT_TYPES, type Actor, type EventDraft } from "./events.ts";
import { agentGroup, isGoalWithin, postReviewers, type Agent, type RoomState } from "./state.ts";

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
  const group = agentGroup(state, agent);
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
    case "goal.metric_set":
      if (actor.kind !== "member") return "only people set a goal's metric";
      return state.goals[draft.payload.goalId] ? null : `unknown goal ${draft.payload.goalId}`;
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
      const runner = state.runners[p.runnerId];
      if (!runner) return `unknown runner ${p.runnerId}`;
      if (runner.memberId !== actor.id) return "members may only start agents on their own runners";
      if (!state.goals[p.goalId]) return `unknown goal ${p.goalId}`;
      if (p.provider === "shell" && (p.role !== "worker" || p.terminal !== true)) return "a shell is a worker in a terminal";
      if (p.forkOf !== undefined) {
        const source = state.agents[p.forkOf];
        if (!source || source.archived) return `unknown agent ${p.forkOf}`;
        // The copy is made on the machine holding the session, by the CLI that wrote it.
        if (source.runnerId !== p.runnerId || source.provider !== p.provider || source.provider === "shell") return "a fork runs on its agent's runner with the same CLI";
        if (!source.terminal || p.terminal !== true) return "only terminal agents can be forked";
        if (source.providerSessionId === null) return "the agent has no session to fork yet";
        if (p.role !== "worker") return "a fork is a worker";
      }
      if (p.groupId === null) return p.role === "worker" ? null : "only workers may be standalone; leaders and monitors belong to a group";
      const group = state.groups[p.groupId];
      if (!group) return `unknown group ${p.groupId}`;
      if (!isGoalWithin(state, p.goalId, group.goalId)) return "agent goal must lie within its group's goal";
      if (p.role === "leader" && group.leaderAgentId !== null) return "group already has a leader";
      if (p.role === "monitor" && group.monitorAgentId !== null) return "group already has a monitor";
      return null;
    }
    case "agent.archived":
    case "agent.restart_requested":
    case "agent.renamed": {
      const agent = state.agents[draft.payload.agentId];
      if (!agent) return `unknown agent ${draft.payload.agentId}`;
      if (agent.archived) return "the agent has been removed";
      if (actor.kind !== "member") return "only people may remove, restart or rename agents";
      if (agent.memberId !== actor.id && state.members[actor.id]?.role !== "owner") return "only the agent's owner or the room owner may do this";
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
    case "result.submitted": {
      const p = draft.payload;
      if (actor.kind !== "agent" || actor.id !== p.agentId) return "agents may only submit their own results";
      const agent = state.agents[p.agentId];
      if (!agent) return `unknown agent ${p.agentId}`;
      if (state.results[p.resultId]) return `result ${p.resultId} already exists`;
      const goal = state.goals[p.goalId];
      if (!goal?.metric) return "that goal has no metric to submit results for";
      if (!isGoalWithin(state, agent.goalId, p.goalId)) return "results go to a goal on your own goal path";
      if (p.basedOn !== undefined && state.results[p.basedOn]?.goalId !== p.goalId) return `unknown result ${p.basedOn} on that goal`;
      return null;
    }
    case "result.verified":
    case "result.verification_failed": {
      const result = state.results[draft.payload.resultId];
      if (!result) return `unknown result ${draft.payload.resultId}`;
      if (result.status !== "pending") return "the result has already been verified";
      return agentOwnedByRunner(state, actor, result.agentId);
    }
    case "memory.recorded": {
      if (actor.kind !== "member") return "only people record memory; agents propose learnings";
      if (state.memory[draft.payload.entryId]) return `memory entry ${draft.payload.entryId} already exists`;
      const source = draft.payload.sourcePostId;
      return source === undefined || state.posts[source] ? null : `unknown post ${source}`;
    }
    case "memory.updated":
    case "memory.retired": {
      if (actor.kind !== "member") return "only people change memory";
      const entry = state.memory[draft.payload.entryId];
      if (!entry) return `unknown memory entry ${draft.payload.entryId}`;
      return entry.retired ? "the memory entry has been retired" : null;
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
      const group = agentGroup(state, sender);
      if (sender.role === "leader" && group && target.groupId === group.id) return null;
      if (sender.role === "monitor" && group?.leaderAgentId === target.id) return null;
      return "leaders may message their group; monitors may only message their leader";
    }
  }
}

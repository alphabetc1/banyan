// Event schemas. Every write in Banyan is an event; all other state is a projection of the log.
// Clients submit an EventDraft; the server stamps seq, roomId, ts and actor to form a RoomEvent.
import { z } from "zod";

export const AgentRole = z.enum(["leader", "monitor", "worker"]);
export type AgentRole = z.infer<typeof AgentRole>;

export const Provider = z.enum(["claude", "codex"]);
export type Provider = z.infer<typeof Provider>;

export const GoalStatus = z.enum(["open", "done", "abandoned"]);
export type GoalStatus = z.infer<typeof GoalStatus>;

// starting: the runner is preparing the workspace (e.g. cloning the repository) before launch.
export const ProcessState = z.enum(["starting", "running", "exited", "crashed", "unknown"]);
export type ProcessState = z.infer<typeof ProcessState>;

export const Activity = z.enum(["working", "idle", "unknown"]);
export type Activity = z.infer<typeof Activity>;

export const Resumability = z.enum(["live", "resumable", "context_full", "lost"]);
export type Resumability = z.infer<typeof Resumability>;

export const PostKind = z.enum(["direction", "finding", "conclusion"]);
export type PostKind = z.infer<typeof PostKind>;

export const ReviewDecision = z.enum(["approved", "rejected"]);
export type ReviewDecision = z.infer<typeof ReviewDecision>;

export const ApprovalDecision = z.enum(["allowed", "denied"]);
export type ApprovalDecision = z.infer<typeof ApprovalDecision>;

export const Delivery = z.enum(["steer", "fyi"]);
export type Delivery = z.infer<typeof Delivery>;

const Id = z.string().min(1).max(64);
const ShortText = z.string().min(1).max(500);
const LongText = z.string().max(20_000);

export const DiffStat = z.object({
  files: z.number().int().nonnegative(),
  insertions: z.number().int().nonnegative(),
  deletions: z.number().int().nonnegative(),
});
export type DiffStat = z.infer<typeof DiffStat>;

export const Evidence = z.object({
  label: ShortText,
  detail: LongText,
});
export type Evidence = z.infer<typeof Evidence>;

export const TranscriptEntry = z.object({
  kind: z.enum(["user", "assistant", "tool_call", "tool_result", "system"]),
  text: LongText,
  ts: z.number().int(),
});
export type TranscriptEntry = z.infer<typeof TranscriptEntry>;

function variant<T extends string, P extends z.ZodType>(type: T, payload: P) {
  return z.object({ eventId: Id, type: z.literal(type), payload });
}

// Event types that only the server itself may emit (through the HTTP API).
export const SERVER_ONLY_EVENT_TYPES = ["room.created", "member.joined", "runner.registered"] as const;

export const EventDraft = z.discriminatedUnion("type", [
  variant(
    "room.created",
    z.object({ name: ShortText, repoUrl: ShortText, baseBranch: ShortText, rootGoalId: Id, rootGoalTitle: ShortText, rootGoalDescription: LongText }),
  ),
  variant("member.joined", z.object({ memberId: Id, displayName: ShortText, role: z.enum(["owner", "member"]) })),
  variant("runner.registered", z.object({ runnerId: Id, memberId: Id, hostname: ShortText })),
  variant("goal.created", z.object({ goalId: Id, parentId: Id, title: ShortText, description: LongText })),
  variant("goal.status_changed", z.object({ goalId: Id, status: GoalStatus })),
  variant("group.created", z.object({ groupId: Id, goalId: Id, name: ShortText })),
  variant(
    "agent.created",
    // groupId is null for a standalone agent, which works on its goal outside any group.
    z.object({ agentId: Id, groupId: Id.nullable(), runnerId: Id, name: ShortText, role: AgentRole, provider: Provider, model: ShortText, goalId: Id, instructions: LongText }),
  ),
  variant("agent.session_bound", z.object({ agentId: Id, providerSessionId: Id })),
  variant("agent.process_changed", z.object({ agentId: Id, process: ProcessState, detail: LongText.optional() })),
  variant("agent.activity_changed", z.object({ agentId: Id, activity: Activity })),
  variant("agent.resumability_changed", z.object({ agentId: Id, resumability: Resumability, detail: LongText.optional() })),
  variant("agent.phase_reported", z.object({ agentId: Id, phase: ShortText, note: LongText.optional() })),
  variant("worktree.created", z.object({ worktreeId: Id, agentId: Id, branch: ShortText, baseSha: ShortText })),
  variant("worktree.updated", z.object({ worktreeId: Id, headSha: ShortText, diffStat: DiffStat })),
  variant(
    "post.created",
    z.object({ postId: Id, agentId: Id, kind: PostKind, summary: ShortText, body: LongText, evidence: z.array(Evidence).max(20), proposeRoomVisible: z.boolean() }),
  ),
  variant("post.reviewed", z.object({ postId: Id, decision: ReviewDecision, note: LongText.optional() })),
  variant("approval.requested", z.object({ approvalId: Id, agentId: Id, tool: ShortText, input: LongText })),
  variant("approval.decided", z.object({ approvalId: Id, decision: ApprovalDecision, note: LongText.optional() })),
  // The agent process that asked is gone (crash or restart), so nobody waits for a decision.
  variant("approval.expired", z.object({ approvalId: Id, reason: ShortText })),
  variant("message.sent", z.object({ messageId: Id, toAgentId: Id, text: LongText, delivery: Delivery })),
  variant("transcript.appended", z.object({ agentId: Id, entries: z.array(TranscriptEntry).min(1).max(200) })),
]);
export type EventDraft = z.infer<typeof EventDraft>;
export type EventType = EventDraft["type"];

// Who produced an event. Agents never authenticate themselves: their runner submits
// on their behalf and the server derives the agent actor from runner ownership.
export type Actor =
  | { kind: "system" }
  | { kind: "member"; id: string }
  | { kind: "runner"; id: string }
  | { kind: "agent"; id: string };

export type RoomEvent = EventDraft & { seq: number; roomId: string; ts: number; actor: Actor };

export type EventOf<T extends EventType> = Extract<RoomEvent, { type: T }>;

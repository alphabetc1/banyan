// Derived agent health shown as red / yellow / green. Liveness comes from runner-observed
// signals; the agent's self-reported phase only adds meaning (e.g. waiting for a GPU).
// Reasons are structured so each client can render them in its own language.
import type { Agent, RoomState } from "./state.ts";

export interface HealthThresholds {
  // A pending approval older than this turns the agent red.
  approvalWaitMs: number;
  // No events for this long while working means the agent may be stuck.
  stallMs: number;
  // Stall threshold while the agent reports waiting for a GPU.
  gpuWaitStallMs: number;
  // A self-reported phase older than this, while running, is considered stale.
  phaseStaleMs: number;
}

export const DEFAULT_HEALTH_THRESHOLDS: HealthThresholds = {
  approvalWaitMs: 10 * 60_000,
  stallMs: 15 * 60_000,
  gpuWaitStallMs: 2 * 3600_000,
  phaseStaleMs: 2 * 3600_000,
};

export type HealthReason =
  | { code: "crashed"; detail: string | null }
  | { code: "session_lost"; detail: string | null }
  | { code: "approvals_overdue"; count: number; minutes: number }
  | { code: "approvals_waiting"; count: number }
  | { code: "not_running" }
  | { code: "context_full" }
  | { code: "stalled"; minutes: number }
  | { code: "phase_stale"; phase: string; minutes: number };

export interface Health {
  level: "red" | "yellow" | "green";
  reasons: HealthReason[];
}

const minutes = (ms: number) => Math.round(ms / 60_000);

export function deriveHealth(state: RoomState, agent: Agent, now: number, t: HealthThresholds = DEFAULT_HEALTH_THRESHOLDS): Health {
  const red: HealthReason[] = [];
  const yellow: HealthReason[] = [];

  if (agent.process === "crashed") red.push({ code: "crashed", detail: agent.processDetail });
  if (agent.resumability === "lost") red.push({ code: "session_lost", detail: agent.resumabilityDetail });

  const pending = Object.values(state.approvals).filter((a) => a.agentId === agent.id && a.state === "pending");
  const oldest = pending.reduce((min, a) => Math.min(min, a.requestedAt), Number.POSITIVE_INFINITY);
  if (pending.length > 0 && now - oldest > t.approvalWaitMs) red.push({ code: "approvals_overdue", count: pending.length, minutes: minutes(now - oldest) });
  else if (pending.length > 0) yellow.push({ code: "approvals_waiting", count: pending.length });

  if (agent.process === "exited") yellow.push({ code: "not_running" });
  if (agent.resumability === "context_full") yellow.push({ code: "context_full" });

  const waitingGpu = agent.phase?.value === "waiting_gpu";
  const stallLimit = waitingGpu ? t.gpuWaitStallMs : t.stallMs;
  const silentFor = now - agent.lastEventAt;
  if (agent.process === "running" && agent.activity === "working" && pending.length === 0 && silentFor > stallLimit) {
    yellow.push({ code: "stalled", minutes: minutes(silentFor) });
  }
  if (agent.process === "running" && agent.phase && now - agent.phase.updatedAt > t.phaseStaleMs) {
    yellow.push({ code: "phase_stale", phase: agent.phase.value, minutes: minutes(now - agent.phase.updatedAt) });
  }

  if (red.length > 0) return { level: "red", reasons: [...red, ...yellow] };
  if (yellow.length > 0) return { level: "yellow", reasons: yellow };
  return { level: "green", reasons: [] };
}

// English rendering, used where agents read health (Room MCP digests).
export function describeHealthReason(r: HealthReason): string {
  switch (r.code) {
    case "crashed":
      return r.detail ? `crashed: ${r.detail}` : "crashed";
    case "session_lost":
      return r.detail ? `session lost: ${r.detail}` : "session lost";
    case "approvals_overdue":
      return `${r.count} approval(s) waiting ${r.minutes} min`;
    case "approvals_waiting":
      return `${r.count} approval(s) waiting for a human`;
    case "not_running":
      return "not running";
    case "context_full":
      return "context window full";
    case "stalled":
      return `no activity for ${r.minutes} min`;
    case "phase_stale":
      return `phase "${r.phase}" not updated for ${r.minutes} min`;
  }
}

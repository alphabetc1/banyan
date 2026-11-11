// Derived agent health shown as red / yellow / green. Liveness comes from runner-observed
// signals; the agent's self-reported phase only adds meaning (e.g. waiting for a GPU).
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

export interface Health {
  level: "red" | "yellow" | "green";
  reasons: string[];
}

function minutes(ms: number): string {
  return `${Math.round(ms / 60_000)} min`;
}

export function deriveHealth(state: RoomState, agent: Agent, now: number, t: HealthThresholds = DEFAULT_HEALTH_THRESHOLDS): Health {
  const red: string[] = [];
  const yellow: string[] = [];

  if (agent.process === "crashed") red.push(`crashed${agent.processDetail ? `: ${agent.processDetail}` : ""}`);
  if (agent.resumability === "lost") red.push(`session lost${agent.resumabilityDetail ? `: ${agent.resumabilityDetail}` : ""}`);

  const pending = Object.values(state.approvals).filter((a) => a.agentId === agent.id && a.state === "pending");
  const oldest = pending.reduce((min, a) => Math.min(min, a.requestedAt), Number.POSITIVE_INFINITY);
  if (pending.length > 0 && now - oldest > t.approvalWaitMs) red.push(`${pending.length} approval(s) waiting ${minutes(now - oldest)}`);
  else if (pending.length > 0) yellow.push(`${pending.length} approval(s) waiting for a human`);

  if (agent.process === "exited") yellow.push("not running");
  if (agent.resumability === "context_full") yellow.push("context window full");

  const waitingGpu = agent.phase?.value === "waiting_gpu";
  const stallLimit = waitingGpu ? t.gpuWaitStallMs : t.stallMs;
  const silentFor = now - agent.lastEventAt;
  if (agent.process === "running" && agent.activity === "working" && pending.length === 0 && silentFor > stallLimit) {
    yellow.push(`no activity for ${minutes(silentFor)}`);
  }
  if (agent.process === "running" && agent.phase && now - agent.phase.updatedAt > t.phaseStaleMs) {
    yellow.push(`phase "${agent.phase.value}" not updated for ${minutes(now - agent.phase.updatedAt)}`);
  }

  if (red.length > 0) return { level: "red", reasons: [...red, ...yellow] };
  if (yellow.length > 0) return { level: "yellow", reasons: yellow };
  return { level: "green", reasons: [] };
}

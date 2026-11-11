// Provider-neutral contract between the supervisor and an agent session (Claude or Codex).
import type { Delivery, TranscriptEntry } from "@banyan/shared";

// Model name meaning "use the provider's locally configured default".
export const DEFAULT_MODEL = "default";

export interface SessionSpec {
  agentId: string;
  cwd: string;
  model: string;
  systemPrompt: string;
  // Room MCP endpoint whose URL path binds this agent's identity.
  roomMcpUrl: string;
  resumeSessionId: string | null;
}

export interface SessionCallbacks {
  onSessionId(id: string): void;
  onActivity(activity: "working" | "idle"): void;
  onTranscript(entries: TranscriptEntry[]): void;
  // Resolves when a human decides in the web UI; may stay pending for a long time.
  requestApproval(req: { tool: string; input: string }): Promise<"allowed" | "denied">;
  onTurnEnd(info: { ok: boolean; error: string | null }): void;
  onExit(info: { crashed: boolean; detail: string }): void;
}

export interface AgentSession {
  // Resolves once the provider confirmed the session (and its id); rejects if it failed to start,
  // e.g. when the session to resume no longer exists.
  readonly ready: Promise<void>;
  send(text: string, delivery: Delivery): void;
  stop(): Promise<void>;
}

export interface AgentProvider {
  start(spec: SessionSpec, callbacks: SessionCallbacks): AgentSession;
  close(): Promise<void>;
}

export const TRANSCRIPT_TEXT_MAX = 4000;

export function clip(text: string, max = TRANSCRIPT_TEXT_MAX): string {
  return text.length <= max ? text : `${text.slice(0, max)}… [${text.length - max} more chars]`;
}

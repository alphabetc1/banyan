// Provider-neutral contract between the supervisor and an agent session (Claude or Codex).
import type { Delivery, TranscriptEntry } from "@banyan/shared";

// Model name meaning "use the provider's locally configured default".
export const DEFAULT_MODEL = "default";

export interface SessionSpec {
  agentId: string;
  cwd: string;
  model: string;
  // Banyan's coordination instructions; null for a plain agent.
  systemPrompt: string | null;
  // Room MCP endpoint whose URL path binds this agent's identity; null for a plain agent.
  roomMcpUrl: string | null;
  resumeSessionId: string | null;
}

export interface SessionCallbacks {
  onSessionId(id: string): void;
  onActivity(activity: "working" | "idle" | "awaiting_input"): void;
  onTranscript(entries: TranscriptEntry[]): void;
  // Resolves when a human decides in the web UI; may stay pending for a long time.
  requestApproval(req: { tool: string; input: string }): Promise<"allowed" | "denied">;
  onTurnEnd(info: { ok: boolean; error: string | null }): void;
  // A session that can refuse input (see AgentSession.acceptsInput) calls this when it can
  // take input again.
  onAcceptsInput?(): void;
  onExit(info: { crashed: boolean; detail: string }): void;
}

// The live terminal of a session running the provider's own interactive UI.
export interface TerminalHandle {
  write(data: string): void;
  resize(cols: number, rows: number): void;
  // Recent output for a view that attaches now, and every later chunk until it detaches;
  // onEnd fires once the terminal's process has exited.
  attach(listener: (data: string) => void, onEnd?: (detail: string) => void): { backlog: string; detach(): void };
}

export interface AgentSession {
  // Resolves once the provider confirmed the session (and its id); rejects if it failed to start,
  // e.g. when the session to resume no longer exists.
  readonly ready: Promise<void>;
  // recorded: Banyan has already put this text in the transcript (a room message), so a
  // provider that reports input itself must not report it again.
  send(text: string, delivery: Delivery, recorded?: boolean): void;
  // False while input with this delivery would land somewhere it must not, such as a question
  // the CLI is asking in its terminal, or, for fyi, a turn still in progress; messages then
  // wait. Absent means input is always accepted.
  acceptsInput?(delivery: Delivery): boolean;
  stop(): Promise<void>;
  // Present for sessions that run in a terminal.
  readonly terminal?: TerminalHandle;
}

export interface AgentProvider {
  start(spec: SessionSpec, callbacks: SessionCallbacks): AgentSession;
  close(): Promise<void>;
}

export const TRANSCRIPT_TEXT_MAX = 4000;

export function clip(text: string, max = TRANSCRIPT_TEXT_MAX): string {
  return text.length <= max ? text : `${text.slice(0, max)}… [${text.length - max} more chars]`;
}

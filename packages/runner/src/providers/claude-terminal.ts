// Claude agents in Claude Code's own interactive terminal UI, so everything native works:
// skills, slash commands, /model, plan mode, the status line and its permission prompts.
// The session runs in a pseudo-terminal; Banyan follows it through Claude Code hooks that
// post to a local HTTP endpoint, and talks to it by typing into the terminal.
import { randomBytes, randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { Delivery, TranscriptEntry } from "@banyan/shared";
import type { PermissionMode } from "@anthropic-ai/claude-agent-sdk";
import type { IPty } from "node-pty";
import { agentEnv } from "../agent-env.ts";
import type { AgentProcesses } from "../agent-processes.ts";
import { spawnPty } from "../pty.ts";
import { clip, DEFAULT_MODEL, type AgentProvider, type AgentSession, type SessionCallbacks, type SessionSpec, type TerminalHandle } from "./types.ts";

// Kept for a view that attaches later; Claude Code redraws its screen often, so this covers
// several screens of history.
const BACKLOG_MAX_CHARS = 512 * 1024;
const COLS = 120;
const ROWS = 36;
// A session counts as started once a hook arrives or it has stayed up this long (the folder
// trust question, for one, holds back every hook).
const STARTED_AFTER_MS = 3000;
const STOP_GRACE_MS = 5000;
const STEER_SETTLE_MS = 300;
const PASTE_SETTLE_MS = 100;
const HOOK_EVENTS = ["UserPromptSubmit", "PreToolUse", "PostToolUse", "PermissionRequest", "Notification", "Stop"] as const;
// Notifications meaning Claude Code is waiting for its person, not just idle.
const NEEDS_PERSON = new Set(["permission_prompt", "elicitation_dialog", "agent_needs_input"]);

// Terminal output without escape sequences.
function plainText(output: string): string {
  return output.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "").replace(/\x1b\][^\x07]*\x07/g, "");
}

// The fields Banyan reads from hook input, as Claude Code 2.1 sends them.
interface HookInput {
  hook_event_name?: string;
  session_id?: string;
  prompt?: string;
  tool_name?: string;
  tool_input?: unknown;
  tool_response?: unknown;
  notification_type?: string;
  last_assistant_message?: string;
}

class TerminalSession implements AgentSession, TerminalHandle {
  readonly ready: Promise<void>;
  readonly terminal: TerminalHandle = this;
  private pty: IPty | null = null;
  private backlog = "";
  private listeners = new Set<(data: string) => void>();
  private endListeners = new Set<(detail: string) => void>();
  private initialPrompt: string | null = null;
  // Room messages typed in, which the supervisor has already put in the transcript.
  private recordedInputs: string[] = [];
  private started = false;
  private stopped = false;
  private exited = false;
  private awaitingPerson = false;
  private markStarted!: () => void;
  private failStart!: (e: Error) => void;
  readonly sessionId: string;

  constructor(
    private spec: SessionSpec,
    private cb: SessionCallbacks,
    private hookUrl: string,
    private processes: AgentProcesses,
    private permissionMode: PermissionMode | undefined,
  ) {
    this.sessionId = spec.resumeSessionId ?? randomUUID();
    this.ready = new Promise((resolve, reject) => {
      this.markStarted = () => {
        if (this.started) return;
        this.started = true;
        resolve();
      };
      this.failStart = reject;
    });
    this.ready.catch(() => {});
    // The supervisor queues the first message right after start(); it becomes the prompt
    // Claude Code starts with.
    queueMicrotask(() => this.spawn());
  }

  private spawn(): void {
    const hooks = Object.fromEntries(HOOK_EVENTS.map((e) => [e, [{ hooks: [{ type: "http", url: this.hookUrl }] }]]));
    // Room tools are Banyan's own coordination channel and never need a person, as in managed
    // sessions; everything else follows the person's own permission settings.
    const settings = { hooks, permissions: { allow: ["mcp__room"] } };
    const args = [
      "--settings",
      JSON.stringify(settings),
      "--mcp-config",
      JSON.stringify({ mcpServers: { room: { type: "http", url: this.spec.roomMcpUrl } } }),
      "--append-system-prompt",
      this.spec.systemPrompt,
      ...(this.spec.model === DEFAULT_MODEL ? [] : ["--model", this.spec.model]),
      ...(this.permissionMode ? ["--permission-mode", this.permissionMode] : []),
      ...(this.spec.resumeSessionId ? ["--resume", this.spec.resumeSessionId] : ["--session-id", this.sessionId]),
      ...(this.initialPrompt ? [this.initialPrompt] : []),
    ];
    let pty: IPty;
    try {
      pty = spawnPty("claude", args, {
        name: "xterm-256color",
        cols: COLS,
        rows: ROWS,
        cwd: this.spec.cwd,
        env: { ...agentEnv(process.env), TERM: "xterm-256color", COLORTERM: "truecolor" },
      });
    } catch (e) {
      this.failStart(new Error(`cannot start claude: ${(e as Error).message}`));
      this.cb.onExit({ crashed: true, detail: `cannot start claude: ${(e as Error).message}` });
      return;
    }
    this.pty = pty;
    // The terminal's process leads its own group, so a runner that dies can have it ended.
    const forget = this.processes.record(pty.pid, "claude", "--settings");
    this.cb.onSessionId(this.sessionId);
    const startedTimer = setTimeout(() => this.markStarted(), STARTED_AFTER_MS);
    pty.onData((data) => {
      this.backlog = (this.backlog + data).slice(-BACKLOG_MAX_CHARS);
      for (const l of this.listeners) l(data);
      // Before any hook can fire, the folder trust question waits for the person. The screen
      // places its words with cursor moves, so they are matched without escapes or spaces.
      if (!this.started && !this.awaitingPerson && /trustthisfolder/i.test(plainText(this.backlog).replace(/\s/g, ""))) this.setAwaitingPerson(true);
    });
    pty.onExit(({ exitCode, signal }) => {
      clearTimeout(startedTimer);
      forget();
      this.exited = true;
      const detail = `claude exited (code ${exitCode}${signal ? `, signal ${signal}` : ""})`;
      if (!this.started) this.failStart(new Error(`${detail} before starting: ${this.backlogTail()}`));
      for (const l of this.endListeners) l(detail);
      this.endListeners.clear();
      this.listeners.clear();
      this.cb.onExit({ crashed: !this.stopped && exitCode !== 0, detail: this.stopped ? "stopped" : detail });
    });
  }

  private backlogTail(): string {
    return plainText(this.backlog).replace(/\s+/g, " ").trim().slice(-300);
  }

  private setAwaitingPerson(waiting: boolean): void {
    if (this.awaitingPerson === waiting) return;
    this.awaitingPerson = waiting;
    this.cb.onActivity(waiting ? "awaiting_input" : "working");
  }

  onHook(input: HookInput): void {
    this.markStarted();
    const ts = Date.now();
    const entries: TranscriptEntry[] = [];
    switch (input.hook_event_name) {
      case "UserPromptSubmit": {
        this.setAwaitingPerson(false);
        this.cb.onActivity("working");
        const prompt = input.prompt ?? "";
        const recorded = this.recordedInputs.indexOf(prompt);
        if (recorded >= 0) this.recordedInputs.splice(recorded, 1);
        else if (prompt) entries.push({ kind: "user", text: clip(prompt), ts });
        break;
      }
      case "PreToolUse":
        this.setAwaitingPerson(false);
        entries.push({ kind: "tool_call", text: clip(`${input.tool_name ?? "tool"} ${JSON.stringify(input.tool_input ?? {})}`), ts });
        break;
      case "PermissionRequest":
        this.setAwaitingPerson(true);
        break;
      case "Notification":
        if (input.notification_type && NEEDS_PERSON.has(input.notification_type)) this.setAwaitingPerson(true);
        break;
      case "PostToolUse": {
        this.setAwaitingPerson(false);
        const response = typeof input.tool_response === "string" ? input.tool_response : JSON.stringify(input.tool_response ?? "");
        entries.push({ kind: "tool_result", text: clip(response), ts });
        break;
      }
      case "Stop":
        this.awaitingPerson = false;
        if (input.last_assistant_message) entries.push({ kind: "assistant", text: clip(input.last_assistant_message), ts });
        this.cb.onActivity("idle");
        this.cb.onTurnEnd({ ok: true, error: null });
        break;
    }
    if (entries.length > 0) this.cb.onTranscript(entries);
  }

  send(text: string, delivery: Delivery, recorded = false): void {
    if (!this.pty) {
      // Before the terminal exists, the first message becomes Claude Code's starting prompt.
      if (this.initialPrompt === null && !recorded) {
        this.initialPrompt = text;
        return;
      }
      setTimeout(() => this.send(text, delivery, recorded), STEER_SETTLE_MS);
      return;
    }
    if (recorded) this.recordedInputs.push(text);
    const pty = this.pty;
    const type = () => {
      if (this.exited) return;
      // Bracketed paste keeps multi-line text together as one message.
      pty.write(`\x1b[200~${text}\x1b[201~`);
      setTimeout(() => !this.exited && pty.write("\r"), PASTE_SETTLE_MS);
    };
    if (delivery === "steer") {
      // Escape interrupts what Claude Code is doing, as it does for a person at the keyboard.
      pty.write("\x1b");
      setTimeout(type, STEER_SETTLE_MS);
    } else {
      type();
    }
  }

  async stop(): Promise<void> {
    this.stopped = true;
    const pty = this.pty;
    if (!pty || this.exited) return;
    const exited = new Promise<void>((resolve) => pty.onExit(() => resolve()));
    pty.kill("SIGTERM");
    const timer = setTimeout(() => !this.exited && pty.kill("SIGKILL"), STOP_GRACE_MS);
    await exited;
    clearTimeout(timer);
  }

  write(data: string): void {
    if (!this.exited) this.pty?.write(data);
  }

  resize(cols: number, rows: number): void {
    if (!this.exited && cols > 0 && rows > 0) this.pty?.resize(cols, rows);
  }

  attach(listener: (data: string) => void, onEnd?: (detail: string) => void): { backlog: string; detach(): void } {
    this.listeners.add(listener);
    if (onEnd) {
      if (this.exited) onEnd("terminal has ended");
      else this.endListeners.add(onEnd);
    }
    return {
      backlog: this.backlog,
      detach: () => {
        this.listeners.delete(listener);
        if (onEnd) this.endListeners.delete(onEnd);
      },
    };
  }
}

export class ClaudeTerminalProvider implements AgentProvider {
  private server: Server | null = null;
  private base = "";
  // Hook URLs carry the agent id and a secret, so a hook reaches only its own session.
  private sessions = new Map<string, { secret: string; session: TerminalSession }>();

  // Without a permission mode, the person's own Claude Code default applies.
  constructor(
    private processes: AgentProcesses,
    private permissionMode?: PermissionMode,
  ) {}

  async open(): Promise<void> {
    const server = createServer((req, res) => {
      const match = req.url?.match(/^\/hook\/([\w-]+)\/([\w-]+)$/);
      const entry = match ? this.sessions.get(match[1]!) : undefined;
      if (req.method !== "POST" || !entry || entry.secret !== match![2]) {
        res.writeHead(404).end();
        return;
      }
      let body = "";
      req.on("data", (d: Buffer) => (body += d.toString()));
      req.on("end", () => {
        // An empty JSON object lets Claude Code carry on as it would without the hook.
        res.writeHead(200, { "content-type": "application/json" }).end("{}");
        try {
          entry.session.onHook(JSON.parse(body) as HookInput);
        } catch {
          // A malformed hook body cannot be acted on; Claude Code continues regardless.
        }
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    this.server = server;
    this.base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  }

  start(spec: SessionSpec, callbacks: SessionCallbacks): AgentSession {
    if (!this.server) throw new Error("terminal provider is not open");
    const secret = randomBytes(16).toString("hex");
    const session = new TerminalSession(
      spec,
      {
        ...callbacks,
        onExit: (info) => {
          if (this.sessions.get(spec.agentId)?.session === session) this.sessions.delete(spec.agentId);
          callbacks.onExit(info);
        },
      },
      `${this.base}/hook/${spec.agentId}/${secret}`,
      this.processes,
      this.permissionMode,
    );
    this.sessions.set(spec.agentId, { secret, session });
    return session;
  }

  async close(): Promise<void> {
    await Promise.all([...this.sessions.values()].map((s) => s.session.stop()));
    await new Promise<void>((resolve) => (this.server ? this.server.close(() => resolve()) : resolve()));
    this.server = null;
  }
}

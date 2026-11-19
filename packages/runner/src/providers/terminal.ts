// Agents in their CLI's own interactive terminal UI (Claude Code or Codex), so everything
// native works: skills, slash commands, model switching, the status line and the CLI's own
// permission prompts. The session runs in a pseudo-terminal; Banyan follows it through the
// CLI's hooks, which post to a local HTTP endpoint, and talks to it by typing into it.
import { randomBytes, randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { PermissionMode } from "@anthropic-ai/claude-agent-sdk";
import type { Delivery, TranscriptEntry } from "@banyan/shared";
import type { IPty } from "node-pty";
import { agentEnv } from "../agent-env.ts";
import type { AgentProcesses } from "../agent-processes.ts";
import { spawnPty } from "../pty.ts";
import { clip, DEFAULT_MODEL, type AgentProvider, type AgentSession, type SessionCallbacks, type SessionSpec, type TerminalHandle } from "./types.ts";

// Kept for a view that attaches later; the CLIs redraw their screen often, so this covers
// several screens of history.
const BACKLOG_MAX_CHARS = 512 * 1024;
// Recent output checked for a question on screen before the first hook.
const SCREEN_TAIL_CHARS = 4000;
const COLS = 120;
const ROWS = 36;
// A session counts as started once a hook arrives or it has stayed up this long (questions
// such as folder trust hold back every hook).
const STARTED_AFTER_MS = 3000;
const STOP_GRACE_MS = 5000;
const STEER_SETTLE_MS = 300;
const PASTE_SETTLE_MS = 100;
// Notifications meaning Claude Code waits for its person, not just idle.
const NEEDS_PERSON = new Set(["permission_prompt", "elicitation_dialog", "agent_needs_input"]);

// Terminal output without escape sequences.
function plainText(output: string): string {
  return output.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "").replace(/\x1b\][^\x07]*\x07/g, "");
}

// The hook input fields Banyan reads; Claude Code 2.1 and Codex 0.167 send the same names.
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

interface Launch {
  spec: SessionSpec;
  hookUrl: string;
  // The person's own extra arguments for this CLI, such as permission flags.
  extraArgs: string[];
  // The session id Banyan chose, for a CLI that takes one.
  sessionId: string | null;
  initialPrompt: string | null;
}

// What differs between the CLIs.
interface CliProfile {
  command: string;
  // Whether Banyan can choose a new session's id up front; otherwise it arrives with the
  // first hook.
  choosesSessionId: boolean;
  args(launch: Launch): string[];
  env(launch: Launch): Record<string, string>;
  // Questions the CLI asks on screen before any hook can fire. The screen places words with
  // cursor moves, so these match the text with escapes and whitespace removed.
  blockingQuestions: RegExp[];
}

function claudeProfile(permissionMode: PermissionMode | undefined): CliProfile {
  const events = ["UserPromptSubmit", "PreToolUse", "PostToolUse", "PermissionRequest", "Notification", "Stop"];
  return {
    command: "claude",
    choosesSessionId: true,
    args: ({ spec, hookUrl, sessionId, initialPrompt, extraArgs }) => {
      const hooks = Object.fromEntries(events.map((e) => [e, [{ hooks: [{ type: "http", url: hookUrl }] }]]));
      // Room tools are Banyan's own coordination channel and never need a person, as in
      // managed sessions; everything else follows the person's own permission settings.
      const settings = spec.roomMcpUrl ? { hooks, permissions: { allow: ["mcp__room"] } } : { hooks };
      return [
        "--settings",
        JSON.stringify(settings),
        ...(spec.roomMcpUrl ? ["--mcp-config", JSON.stringify({ mcpServers: { room: { type: "http", url: spec.roomMcpUrl } } })] : []),
        ...(spec.systemPrompt ? ["--append-system-prompt", spec.systemPrompt] : []),
        ...(spec.model === DEFAULT_MODEL ? [] : ["--model", spec.model]),
        ...(permissionMode ? ["--permission-mode", permissionMode] : []),
        ...extraArgs,
        ...(spec.resumeSessionId
          ? ["--resume", spec.resumeSessionId]
          : spec.forkSessionId
            ? ["--resume", spec.forkSessionId, "--fork-session", "--session-id", sessionId!]
            : ["--session-id", sessionId!]),
        ...(initialPrompt ? [initialPrompt] : []),
      ];
    },
    env: () => ({}),
    blockingQuestions: [/trustthisfolder/i],
  };
}

// Codex hooks are commands, and Codex runs one only after the person trusts its exact
// definition. The definition is therefore the same for every agent, with the endpoint in an
// environment variable: trusting it once in a Codex terminal covers all later agents.
// Outside Banyan, where the variable is unset, it does nothing.
const CODEX_HOOK_COMMAND = `[ -n "$BANYAN_HOOK_URL" ] || exit 0; curl -s --max-time 5 -H 'content-type: application/json' --data-binary @- "$BANYAN_HOOK_URL" >/dev/null 2>&1; exit 0`;

const toml = (value: string) => JSON.stringify(value);

function codexProfile(): CliProfile {
  const events = ["UserPromptSubmit", "PreToolUse", "PermissionRequest", "PostToolUse", "Stop"];
  return {
    command: "codex",
    choosesSessionId: false,
    args: ({ spec, initialPrompt, extraArgs }) => {
      const config = [
        ...events.map((e) => `hooks.${e}=[{hooks=[{type="command",command=${toml(CODEX_HOOK_COMMAND)}}]}]`),
        // Room tools never need a person, as in managed sessions.
        ...(spec.roomMcpUrl ? [`mcp_servers.room.url=${toml(spec.roomMcpUrl)}`, `mcp_servers.room.default_tools_approval_mode="approve"`] : []),
        ...(spec.systemPrompt ? [`developer_instructions=${toml(spec.systemPrompt)}`] : []),
        // A fork runs in a worktree of its own: without this Codex asks whether to use the
        // forked session's directory instead, which is the other agent's worktree.
        ...(spec.forkSessionId && !spec.resumeSessionId ? [`tui.resume_cwd="current"`] : []),
      ];
      return [
        ...(spec.resumeSessionId ? ["resume"] : spec.forkSessionId ? ["fork"] : []),
        ...config.flatMap((c) => ["-c", c]),
        ...(spec.model === DEFAULT_MODEL ? [] : ["-m", spec.model]),
        ...extraArgs,
        ...(spec.resumeSessionId ? [spec.resumeSessionId] : spec.forkSessionId ? [spec.forkSessionId] : []),
        ...(initialPrompt ? [initialPrompt] : []),
      ];
    },
    env: ({ hookUrl }) => ({ BANYAN_HOOK_URL: hookUrl }),
    blockingQuestions: [/trustthisfolder/i, /hooksn?eedreview/i, /updatenow/i, /usesessiondirectory/i],
  };
}

// The person's own login shell. It has no hooks: Banyan shows its terminal but follows no
// turns, and a restart opens a new shell.
function shellProfile(): CliProfile {
  return {
    command: process.env.SHELL || "/bin/zsh",
    choosesSessionId: false,
    args: () => ["-l"],
    env: () => ({}),
    blockingQuestions: [],
  };
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
  // Input held back until the CLI is at its prompt.
  private waitingInput: { text: string; delivery: Delivery }[] = [];
  private sessionId: string | null;
  private started = false;
  private hookSeen = false;
  private stopped = false;
  private exited = false;
  private awaitingPerson = false;
  // Between a prompt being submitted and the turn's Stop.
  private turnActive = false;
  private markStarted!: () => void;
  private failStart!: (e: Error) => void;

  constructor(
    private spec: SessionSpec,
    private cb: SessionCallbacks,
    private hookUrl: string,
    private profile: CliProfile,
    private processes: AgentProcesses,
    private extraArgs: string[],
  ) {
    this.sessionId = spec.resumeSessionId ?? (profile.choosesSessionId ? randomUUID() : null);
    this.ready = new Promise((resolve, reject) => {
      this.markStarted = () => {
        if (this.started) return;
        this.started = true;
        resolve();
      };
      this.failStart = reject;
    });
    this.ready.catch(() => {});
    // The supervisor queues the first message, if any, right after start(); it becomes the
    // prompt the CLI starts with.
    queueMicrotask(() => this.spawn());
  }

  private spawn(): void {
    const launch: Launch = { spec: this.spec, hookUrl: this.hookUrl, extraArgs: this.extraArgs, sessionId: this.sessionId, initialPrompt: this.initialPrompt };
    const { command } = this.profile;
    let pty: IPty;
    try {
      pty = spawnPty(command, this.profile.args(launch), {
        name: "xterm-256color",
        cols: COLS,
        rows: ROWS,
        cwd: this.spec.cwd,
        env: { ...agentEnv(process.env), ...this.profile.env(launch), TERM: "xterm-256color", COLORTERM: "truecolor" },
      });
    } catch (e) {
      this.failStart(new Error(`cannot start ${command}: ${(e as Error).message}`));
      this.cb.onExit({ crashed: true, detail: `cannot start ${command}: ${(e as Error).message}` });
      return;
    }
    this.pty = pty;
    // The terminal's process leads its own group, so a runner that dies can have it ended.
    const forget = this.processes.record(pty.pid, command, this.profile.args(launch)[0] ?? "");
    if (this.sessionId) this.cb.onSessionId(this.sessionId);
    const startedTimer = setTimeout(() => {
      this.markStarted();
      // Up, asking nothing and without a turn yet: it waits at its prompt.
      if (!this.hookSeen && !this.awaitingPerson) this.cb.onActivity("idle");
    }, STARTED_AFTER_MS);
    pty.onData((data) => {
      this.backlog = (this.backlog + data).slice(-BACKLOG_MAX_CHARS);
      for (const l of this.listeners) l(data);
      if (!this.hookSeen) this.checkBlockingQuestion();
    });
    pty.onExit(({ exitCode, signal }) => {
      clearTimeout(startedTimer);
      forget();
      this.exited = true;
      const detail = `${command} exited (code ${exitCode}${signal ? `, signal ${signal}` : ""})`;
      if (!this.started) this.failStart(new Error(`${detail} before starting: ${this.backlogTail()}`));
      for (const l of this.endListeners) l(detail);
      this.endListeners.clear();
      this.listeners.clear();
      // Exiting while asking its person (say, "No, exit" at the folder trust question) is
      // their answer, not a crash to restart from.
      this.cb.onExit({ crashed: !this.stopped && exitCode !== 0 && !this.awaitingPerson, detail: this.stopped ? "stopped" : detail });
    });
  }

  // Before any hook, the CLI's own questions (folder trust, hook review) are the only sign
  // that it waits for its person; once answered, it waits for the first prompt.
  private checkBlockingQuestion(): void {
    const screen = plainText(this.backlog.slice(-SCREEN_TAIL_CHARS)).replace(/\s/g, "");
    const asking = this.profile.blockingQuestions.some((q) => q.test(screen));
    if (asking !== this.awaitingPerson) {
      this.awaitingPerson = asking;
      this.cb.onActivity(asking ? "awaiting_input" : "idle");
    }
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
    this.hookSeen = true;
    this.markStarted();
    if (input.session_id && input.session_id !== this.sessionId) {
      this.sessionId = input.session_id;
      this.cb.onSessionId(input.session_id);
    }
    const ts = Date.now();
    const entries: TranscriptEntry[] = [];
    switch (input.hook_event_name) {
      case "UserPromptSubmit": {
        this.turnActive = true;
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
        this.turnActive = false;
        this.awaitingPerson = false;
        if (input.last_assistant_message) entries.push({ kind: "assistant", text: clip(input.last_assistant_message), ts });
        this.cb.onActivity("idle");
        this.cb.onTurnEnd({ ok: true, error: null });
        break;
    }
    if (entries.length > 0) this.cb.onTranscript(entries);
    const ready = this.waitingInput.filter((i) => this.acceptsInput(i.delivery));
    this.waitingInput = this.waitingInput.filter((i) => !ready.includes(i));
    for (const input of ready) this.type(input.text, input.delivery);
    if (this.acceptsInput("steer")) this.cb.onAcceptsInput?.();
  }

  // Typing is safe only at the CLI's prompt: once a hook has shown the session is live, and
  // never while it asks its person something, where an Enter would answer the question. An
  // fyi also waits for the turn to end; typed during a turn, the CLIs fold it into that turn.
  acceptsInput(delivery: Delivery): boolean {
    const atPrompt = this.pty !== null && !this.exited && this.hookSeen && !this.awaitingPerson;
    return atPrompt && (delivery === "steer" || !this.turnActive);
  }

  send(text: string, delivery: Delivery, recorded = false): void {
    if (!this.pty) {
      // Before the terminal exists, the first message becomes the CLI's starting prompt.
      if (this.initialPrompt === null && !recorded) {
        this.initialPrompt = text;
        return;
      }
      setTimeout(() => this.send(text, delivery, recorded), STEER_SETTLE_MS);
      return;
    }
    if (recorded) this.recordedInputs.push(text);
    if (this.acceptsInput(delivery)) this.type(text, delivery);
    else this.waitingInput.push({ text, delivery });
  }

  private type(text: string, delivery: Delivery): void {
    const pty = this.pty!;
    const type = () => {
      if (this.exited) return;
      // Bracketed paste keeps multi-line text together as one message.
      pty.write(`\x1b[200~${text}\x1b[201~`);
      setTimeout(() => !this.exited && pty.write("\r"), PASTE_SETTLE_MS);
    };
    if (delivery === "steer") {
      // Escape interrupts what the CLI is doing, as it does for a person at the keyboard.
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

export class TerminalProvider implements AgentProvider {
  private server: Server | null = null;
  private base = "";
  // Hook URLs carry the agent id and a secret, so a hook reaches only its own session.
  private sessions = new Map<string, { secret: string; session: TerminalSession }>();
  // The person's extra arguments, used by sessions started from now on.
  private extraArgs: string[] = [];

  private constructor(
    private profile: CliProfile,
    private processes: AgentProcesses,
  ) {}

  // Without a permission mode, the person's own Claude Code default applies.
  static claude(processes: AgentProcesses, permissionMode?: PermissionMode): TerminalProvider {
    return new TerminalProvider(claudeProfile(permissionMode), processes);
  }

  static codex(processes: AgentProcesses): TerminalProvider {
    return new TerminalProvider(codexProfile(), processes);
  }

  static shell(processes: AgentProcesses): TerminalProvider {
    return new TerminalProvider(shellProfile(), processes);
  }

  setExtraArgs(args: string[]): void {
    this.extraArgs = [...args];
  }

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
        // An empty JSON object lets the CLI carry on as it would without the hook.
        res.writeHead(200, { "content-type": "application/json" }).end("{}");
        try {
          entry.session.onHook(JSON.parse(body) as HookInput);
        } catch {
          // A malformed hook body cannot be acted on; the CLI continues regardless.
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
      this.profile,
      this.processes,
      this.extraArgs,
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

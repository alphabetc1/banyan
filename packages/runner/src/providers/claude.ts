// Claude Code agents through the Agent SDK: one long-lived streaming-input query per agent.
import { query, type PermissionMode, type SDKMessage, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import type { Delivery, TranscriptEntry } from "@banyan/shared";
import type { AgentProcesses } from "../agent-processes.ts";
import { clip, DEFAULT_MODEL, type AgentProvider, type AgentSession, type SessionCallbacks, type SessionSpec } from "./types.ts";

// steer must reach the agent during its current turn; fyi waits until the turn ends.
const PRIORITY: Record<Delivery, SDKUserMessage["priority"]> = { steer: "next", fyi: "later" };

// Async queue feeding user messages into a live query.
class Inbox implements AsyncIterable<SDKUserMessage> {
  private items: SDKUserMessage[] = [];
  private waiters: ((r: IteratorResult<SDKUserMessage>) => void)[] = [];
  private closed = false;

  push(m: SDKUserMessage): void {
    if (this.closed) return;
    const w = this.waiters.shift();
    if (w) w({ value: m, done: false });
    else this.items.push(m);
  }

  close(): void {
    this.closed = true;
    for (const w of this.waiters.splice(0)) w({ value: undefined, done: true });
  }

  [Symbol.asyncIterator](): AsyncIterator<SDKUserMessage> {
    return {
      next: () => {
        const m = this.items.shift();
        if (m) return Promise.resolve({ value: m, done: false });
        if (this.closed) return Promise.resolve({ value: undefined, done: true });
        return new Promise((resolve) => this.waiters.push(resolve));
      },
    };
  }
}

function toTranscript(m: SDKMessage): TranscriptEntry[] {
  const ts = Date.now();
  if (m.type === "assistant") {
    const out: TranscriptEntry[] = [];
    for (const block of m.message.content) {
      if (block.type === "text" && block.text.trim() !== "") out.push({ kind: "assistant", text: clip(block.text), ts });
      if (block.type === "tool_use") out.push({ kind: "tool_call", text: clip(`${block.name} ${JSON.stringify(block.input)}`), ts });
    }
    return out;
  }
  if (m.type === "user" && Array.isArray(m.message.content)) {
    const out: TranscriptEntry[] = [];
    for (const block of m.message.content) {
      if (typeof block === "object" && block.type === "tool_result") {
        const content = typeof block.content === "string" ? block.content : JSON.stringify(block.content ?? "");
        out.push({ kind: "tool_result", text: clip(content), ts });
      }
    }
    return out;
  }
  if (m.type === "result") {
    const summary = m.subtype === "success" ? "turn completed" : `turn failed: ${m.subtype}`;
    return [{ kind: "system", text: `${summary} (cost ≈ $${m.total_cost_usd.toFixed(4)})`, ts }];
  }
  return [];
}

class ClaudeSession implements AgentSession {
  readonly ready: Promise<void>;
  private inbox = new Inbox();
  private abort = new AbortController();
  private stopped = false;

  constructor(spec: SessionSpec, private cb: SessionCallbacks, permissionMode: PermissionMode, processes: AgentProcesses) {
    let resolveReady!: () => void;
    let rejectReady!: (e: Error) => void;
    this.ready = new Promise((resolve, reject) => {
      resolveReady = resolve;
      rejectReady = reject;
    });
    // Avoid an unhandled rejection when nobody awaits `ready`.
    this.ready.catch(() => {});

    const q = query({
      prompt: this.inbox,
      options: {
        cwd: spec.cwd,
        model: spec.model === DEFAULT_MODEL ? undefined : spec.model,
        resume: spec.resumeSessionId ?? undefined,
        abortController: this.abort,
        spawnClaudeCodeProcess: ({ command, args, cwd, env, signal }) => {
          const child = processes.spawn(command, args, { cwd, env, signal });
          child.stderr.pipe(process.stderr, { end: false });
          return child;
        },
        // Same setup as the user's own claude: their settings, CLAUDE.md files, plugins, MCP
        // servers and hooks load as usual, and every skill they have is available.
        settingSources: ["user", "project", "local"],
        skills: "all",
        mcpServers: spec.roomMcpUrl ? { room: { type: "http", url: spec.roomMcpUrl } } : {},
        systemPrompt: spec.systemPrompt ? { type: "preset", preset: "claude_code", append: spec.systemPrompt } : { type: "preset", preset: "claude_code" },
        permissionMode,
        canUseTool: async (toolName, input) => {
          // Room tools are Banyan's own coordination channel and never need a human.
          if (toolName.startsWith("mcp__room__")) return { behavior: "allow", updatedInput: input };
          const decision = await cb.requestApproval({ tool: toolName, input: clip(JSON.stringify(input)) });
          return decision === "allowed"
            ? { behavior: "allow", updatedInput: input }
            : { behavior: "deny", message: "A human reviewer denied this action in Banyan." };
        },
      },
    });

    void (async () => {
      let started = false;
      try {
        for await (const m of q) {
          if (m.type === "system" && m.subtype === "init" && !started) {
            started = true;
            cb.onSessionId(m.session_id);
            resolveReady();
          }
          const entries = toTranscript(m);
          if (entries.length > 0) cb.onTranscript(entries);
          if (m.type === "result") {
            cb.onActivity("idle");
            cb.onTurnEnd({ ok: m.subtype === "success", error: m.subtype === "success" ? null : m.subtype });
          }
        }
        if (!started) rejectReady(new Error("session ended before it started"));
        cb.onExit({ crashed: false, detail: this.stopped ? "stopped" : "session ended" });
      } catch (e) {
        const detail = (e as Error).message;
        if (!started) rejectReady(new Error(detail));
        cb.onExit({ crashed: !this.stopped, detail: this.stopped ? "stopped" : detail });
      }
    })();
  }

  send(text: string, delivery: Delivery): void {
    this.cb.onActivity("working");
    this.inbox.push({ type: "user", message: { role: "user", content: text }, parent_tool_use_id: null, priority: PRIORITY[delivery] });
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.inbox.close();
    this.abort.abort();
  }
}

export class ClaudeProvider implements AgentProvider {
  constructor(
    private processes: AgentProcesses,
    private permissionMode: PermissionMode = "auto",
  ) {}

  start(spec: SessionSpec, callbacks: SessionCallbacks): AgentSession {
    return new ClaudeSession(spec, callbacks, this.permissionMode, this.processes);
  }

  async close(): Promise<void> {}
}

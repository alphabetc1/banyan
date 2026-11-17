// Codex agents through `codex app-server`: one JSON-RPC process hosts every Codex thread
// of this runner; notifications and server requests are routed to sessions by threadId.
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import type { Delivery, TranscriptEntry } from "@banyan/shared";
import type { AskForApproval } from "./codex-protocol/v2/AskForApproval";
import type { FileUpdateChange } from "./codex-protocol/v2/FileUpdateChange";
import type { SandboxMode } from "./codex-protocol/v2/SandboxMode";
import type { ThreadItem } from "./codex-protocol/v2/ThreadItem";
import type { ThreadStatus } from "./codex-protocol/v2/ThreadStatus";
import type { TurnStatus } from "./codex-protocol/v2/TurnStatus";
import type { UserInput } from "./codex-protocol/v2/UserInput";
import type { AgentProcesses } from "../agent-processes.ts";
import type { Logger } from "../logger.ts";
import { clip, DEFAULT_MODEL, type AgentProvider, type AgentSession, type SessionCallbacks, type SessionSpec } from "./types.ts";

type Json = Record<string, any>;

// The Room MCP server name as registered in each thread's config.
const ROOM_SERVER = "room";

const KILL_GRACE_MS = 5000;

class AppServerProcess {
  private proc: ChildProcessWithoutNullStreams;
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: Json) => void; reject: (e: Error) => void }>();
  readonly exited: Promise<string>;

  constructor(
    private onNotification: (method: string, params: Json) => void,
    private onServerRequest: (method: string, params: Json) => Promise<Json>,
    log: Logger,
    processes: AgentProcesses,
  ) {
    this.proc = processes.spawn("codex", ["app-server"]);
    this.exited = new Promise((resolve) => {
      this.proc.on("exit", (code, signal) => resolve(`codex app-server exited (code ${code}, signal ${signal})`));
      this.proc.on("error", (e) => resolve(`codex app-server failed: ${e.message}`));
    });
    void this.exited.then((reason) => {
      for (const p of this.pending.values()) p.reject(new Error(reason));
      this.pending.clear();
    });
    this.proc.stderr.on("data", (d: Buffer) => log.warn(`codex app-server: ${d.toString().trim()}`));
    createInterface({ input: this.proc.stdout }).on("line", (line) => this.onLine(line));
  }

  private onLine(line: string): void {
    const msg = JSON.parse(line) as Json;
    if (msg.id !== undefined && msg.method !== undefined) {
      this.onServerRequest(msg.method, msg.params ?? {}).then(
        (result) => this.write({ id: msg.id, result }),
        (e: Error) => this.write({ id: msg.id, error: { code: -32000, message: e.message } }),
      );
    } else if (msg.id !== undefined) {
      const p = this.pending.get(msg.id);
      this.pending.delete(msg.id);
      if (msg.error) p?.reject(new Error(msg.error.message ?? JSON.stringify(msg.error)));
      else p?.resolve(msg.result);
    } else if (msg.method !== undefined) {
      this.onNotification(msg.method, msg.params ?? {});
    }
  }

  private write(msg: Json): void {
    this.proc.stdin.write(`${JSON.stringify(msg)}\n`);
  }

  request(method: string, params: Json): Promise<Json> {
    const id = this.nextId++;
    this.write({ id, method, params });
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
  }

  notify(method: string): void {
    this.write({ method });
  }

  // Asks the process to exit and waits until it has, forcing it after a grace period, so a
  // stopped runner leaves no app-server behind.
  async kill(): Promise<void> {
    if (this.proc.exitCode !== null || this.proc.signalCode !== null) return;
    this.proc.kill("SIGTERM");
    const forced = setTimeout(() => this.proc.kill("SIGKILL"), KILL_GRACE_MS);
    await this.exited;
    clearTimeout(forced);
  }
}

// Human-readable summary of a proposed file change for an approval request.
export function describeFileChange(c: FileUpdateChange): string {
  const action = c.kind.type === "update" && c.kind.move_path ? `move to ${c.kind.move_path}` : c.kind.type;
  return `${action} ${c.path}\n${c.diff}`;
}

function text(t: string): UserInput {
  return { type: "text", text: t, text_elements: [] };
}

function itemToTranscript(item: ThreadItem): TranscriptEntry | null {
  const ts = Date.now();
  switch (item.type) {
    case "agentMessage":
      return item.text.trim() === "" ? null : { kind: "assistant", text: clip(item.text), ts };
    case "commandExecution":
      return { kind: "tool_call", text: clip(`$ ${item.command}\n(exit ${item.exitCode ?? "?"})\n${item.aggregatedOutput ?? ""}`), ts };
    case "fileChange":
      return { kind: "tool_call", text: clip(`edit ${item.changes.map((c) => c.path).join(", ")}`), ts };
    case "mcpToolCall":
      return { kind: "tool_call", text: clip(`${item.server}.${item.tool} ${JSON.stringify(item.arguments)}`), ts };
    default:
      return null;
  }
}

class CodexSession implements AgentSession {
  readonly ready: Promise<void>;
  threadId: string | null = null;
  private activeTurnId: string | null = null;
  // Items seen in item/started, so approvals can show what a file change touches; the
  // approval request itself carries no paths.
  readonly items = new Map<string, ThreadItem>();
  // fyi messages wait for the current turn to end and are sent together as the next turn.
  private queued: string[] = [];
  // Deliveries run one at a time so a turn/start finishes before the next message picks
  // between starting a turn, steering it, or queueing.
  private deliveries: Promise<void> = Promise.resolve();
  private stopped = false;
  private exited = false;

  constructor(
    private host: CodexProvider,
    private spec: SessionSpec,
    readonly cb: SessionCallbacks,
  ) {
    this.ready = this.open();
    this.ready.catch(() => {});
  }

  private async open(): Promise<void> {
    const server = await this.host.connection();
    const common = {
      cwd: this.spec.cwd,
      model: this.spec.model === DEFAULT_MODEL ? null : this.spec.model,
      approvalPolicy: this.host.approvalPolicy,
      sandbox: this.host.sandbox,
      developerInstructions: this.spec.systemPrompt,
      config: { mcp_servers: { [ROOM_SERVER]: { url: this.spec.roomMcpUrl } } },
    };
    const result = this.spec.resumeSessionId
      ? await server.request("thread/resume", { ...common, threadId: this.spec.resumeSessionId, excludeTurns: true })
      : await server.request("thread/start", common);
    this.threadId = result.thread.id as string;
    this.host.register(this);
    this.cb.onSessionId(this.threadId);
  }

  send(message: string, delivery: Delivery): void {
    this.deliveries = this.deliveries
      .then(() => this.ready)
      .then(
        () => this.deliver(message, delivery),
        // The session never started; launch() handles that failure.
        () => {},
      )
      .catch((e: Error) => {
        this.cb.onTranscript([{ kind: "system", text: `failed to deliver a message to codex: ${e.message}`, ts: Date.now() }]);
      });
  }

  private async startTurn(messages: string[]): Promise<void> {
    const server = await this.host.connection();
    this.cb.onActivity("working");
    const r = await server.request("turn/start", { threadId: this.threadId, input: messages.map(text) });
    this.activeTurnId = r.turn.id as string;
  }

  private async deliver(message: string, delivery: Delivery): Promise<void> {
    if (this.stopped || !this.threadId) return;
    if (this.activeTurnId === null) return this.startTurn([...this.queued.splice(0), message]);
    if (delivery === "fyi") {
      this.queued.push(message);
      return;
    }
    const server = await this.host.connection();
    try {
      await server.request("turn/steer", { threadId: this.threadId, expectedTurnId: this.activeTurnId, input: [text(message)] });
    } catch (e) {
      // The turn may have ended between our check and the steer; then start a new one.
      if (this.activeTurnId !== null) throw e;
      await this.startTurn([...this.queued.splice(0), message]);
    }
  }

  onNotification(method: string, params: Json): void {
    if (method === "thread/status/changed") {
      const status = params.status as ThreadStatus;
      if (status.type === "active") this.cb.onActivity("working");
      if (status.type === "idle") this.cb.onActivity("idle");
      if (status.type === "systemError") this.cb.onTranscript([{ kind: "system", text: "codex reported a system error", ts: Date.now() }]);
    } else if (method === "item/started") {
      const item = params.item as ThreadItem;
      this.items.set(item.id, item);
    } else if (method === "turn/started") {
      this.activeTurnId = params.turn.id as string;
    } else if (method === "item/completed") {
      this.items.delete((params.item as ThreadItem).id);
      const entry = itemToTranscript(params.item as ThreadItem);
      if (entry) this.cb.onTranscript([entry]);
    } else if (method === "turn/completed") {
      this.activeTurnId = null;
      const status = params.turn.status as TurnStatus;
      const ok = status === "completed";
      this.cb.onTranscript([{ kind: "system", text: `turn ${status}`, ts: Date.now() }]);
      this.cb.onTurnEnd({ ok, error: ok ? null : status });
      if (this.queued.length > 0) this.send(this.queued.splice(0).join("\n\n"), "fyi");
    }
  }

  markExited(crashed: boolean, detail: string): void {
    if (this.exited) return;
    this.exited = true;
    this.cb.onExit({ crashed: crashed && !this.stopped, detail: this.stopped ? "stopped" : detail });
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.threadId && this.activeTurnId) {
      const server = await this.host.connection();
      await server.request("turn/interrupt", { threadId: this.threadId, turnId: this.activeTurnId }).catch(() => {});
    }
    this.host.unregister(this);
    this.markExited(false, "stopped");
  }
}

export class CodexProvider implements AgentProvider {
  private proc: AppServerProcess | null = null;
  private initialized: Promise<AppServerProcess> | null = null;
  private sessions = new Map<string, CodexSession>();

  constructor(
    private log: Logger,
    private processes: AgentProcesses,
    readonly approvalPolicy: AskForApproval = "on-request",
    readonly sandbox: SandboxMode = "workspace-write",
  ) {}

  // The shared app-server process after its initialize handshake. It is started on first
  // use and started again after it dies.
  connection(): Promise<AppServerProcess> {
    if (this.proc && this.initialized) return this.initialized;
    const proc = new AppServerProcess(
      (method, params) => this.route(method, params),
      (method, params) => this.answer(method, params),
      this.log,
      this.processes,
    );
    this.proc = proc;
    this.initialized = proc
      .request("initialize", { clientInfo: { name: "banyan-runner", title: null, version: "0.0.0" }, capabilities: null })
      .then(() => {
        proc.notify("initialized");
        return proc;
      });
    void proc.exited.then((reason) => {
      if (this.proc === proc) this.proc = null;
      for (const s of this.sessions.values()) s.markExited(true, reason);
      this.sessions.clear();
    });
    return this.initialized;
  }

  register(session: CodexSession): void {
    if (session.threadId) this.sessions.set(session.threadId, session);
  }

  unregister(session: CodexSession): void {
    if (session.threadId) this.sessions.delete(session.threadId);
  }

  private route(method: string, params: Json): void {
    const threadId = params.threadId as string | undefined;
    if (threadId) this.sessions.get(threadId)?.onNotification(method, params);
  }

  private async answer(method: string, params: Json): Promise<Json> {
    const session = this.sessions.get(params.threadId as string);
    if (!session) throw new Error(`no Banyan session for thread ${params.threadId}`);
    if (method === "item/commandExecution/requestApproval") {
      const decision = await session.cb.requestApproval({ tool: "shell", input: clip(params.command ?? params.reason ?? JSON.stringify(params)) });
      return { decision: decision === "allowed" ? "accept" : "decline" };
    }
    if (method === "item/fileChange/requestApproval") {
      const item = session.items.get(params.itemId as string);
      const changes = item?.type === "fileChange" ? item.changes.map(describeFileChange).join("\n") : "";
      const input = clip([params.reason, changes].filter(Boolean).join("\n") || JSON.stringify(params));
      const decision = await session.cb.requestApproval({ tool: "file_change", input });
      return { decision: decision === "allowed" ? "accept" : "decline" };
    }
    if (method === "mcpServer/elicitation/request") {
      // Room tool calls are Banyan's own channel; any other MCP server needs a human.
      if (params.serverName === ROOM_SERVER) return { action: "accept", content: null, _meta: null };
      const decision = await session.cb.requestApproval({ tool: `mcp:${params.serverName}`, input: clip(params.message ?? "") });
      return { action: decision === "allowed" ? "accept" : "decline", content: null, _meta: null };
    }
    throw new Error(`Banyan does not handle ${method}`);
  }

  start(spec: SessionSpec, callbacks: SessionCallbacks): AgentSession {
    return new CodexSession(this, spec, callbacks);
  }

  async close(): Promise<void> {
    for (const s of [...this.sessions.values()]) await s.stop();
    await this.proc?.kill();
  }
}

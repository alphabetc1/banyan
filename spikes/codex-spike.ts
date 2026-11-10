// Spike: verify the Codex app-server behaviors Banyan's runner depends on.
//   1. Per-thread HTTP MCP injection via thread/start `config`, two threads in one process.
//   2. Approval requests arrive as server requests and can stay pending.
//   3. turn/steer adds input to an active turn.
//   4. thread/resume after the app-server process is killed.
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { startRoomMcp } from "./room-mcp.ts";

const APPROVAL_HOLD_MS = 20_000;

function check(name: string, ok: boolean, detail: string): void {
  console.log(`${ok ? "PASS" : "FAIL"} ${name}: ${detail}`);
  if (!ok) process.exitCode = 1;
}

type Json = Record<string, any>;
type ServerRequestHandler = (method: string, params: Json) => Promise<Json>;

// Minimal JSONL JSON-RPC client for `codex app-server` over stdio.
class AppServer {
  private proc: ChildProcessWithoutNullStreams;
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: Json) => void; reject: (e: Error) => void }>();
  private listeners: ((method: string, params: Json) => void)[] = [];
  exited: Promise<void>;

  constructor(onServerRequest: ServerRequestHandler) {
    this.proc = spawn("codex", ["app-server"], { stdio: ["pipe", "pipe", "pipe"] });
    this.exited = new Promise((resolve) => this.proc.on("exit", () => resolve()));
    this.proc.stderr.on("data", (d) => process.stderr.write(`[codex stderr] ${d}`));
    createInterface({ input: this.proc.stdout }).on("line", (line) => {
      const msg = JSON.parse(line) as Json;
      if (msg.id !== undefined && msg.method !== undefined) {
        void onServerRequest(msg.method, msg.params).then((result) => this.write({ id: msg.id, result }));
      } else if (msg.id !== undefined) {
        const p = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) p?.reject(new Error(JSON.stringify(msg.error)));
        else p?.resolve(msg.result);
      } else {
        for (const l of this.listeners) l(msg.method, msg.params);
      }
    });
  }

  private write(msg: Json): void {
    this.proc.stdin.write(`${JSON.stringify(msg)}\n`);
  }

  request(method: string, params: Json): Promise<Json> {
    const id = this.nextId++;
    this.write({ id, method, params });
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
  }

  onNotification(l: (method: string, params: Json) => void): void {
    this.listeners.push(l);
  }

  async initialize(): Promise<void> {
    await this.request("initialize", {
      clientInfo: { name: "banyan-spike", title: null, version: "0.0.0" },
      capabilities: null,
    });
    this.write({ method: "initialized" });
  }

  // Resolves with the completed turn's final agent message text.
  waitTurn(threadId: string): Promise<{ turnId: string; text: string }> {
    return new Promise((resolve) => {
      let text = "";
      this.onNotification((method, params) => {
        if (params?.threadId !== threadId) return;
        if (method === "item/completed" && params.item.type === "agentMessage") text = params.item.text;
        if (method === "turn/completed") resolve({ turnId: params.turn.id, text });
      });
    });
  }

  kill(): void {
    this.proc.kill("SIGKILL");
  }
}

function text(t: string): Json {
  return { type: "text", text: t, text_elements: [] };
}

async function main(): Promise<void> {
  const room = await startRoomMcp();
  const cwdA = mkdtempSync(join(tmpdir(), "banyan-codex-spike-a-"));
  const cwdB = mkdtempSync(join(tmpdir(), "banyan-codex-spike-b-"));
  const threadConfig = (agentId: string): Json => ({ mcp_servers: { room: { url: room.url(agentId) } } });

  const approvals: { method: string; heldMs: number }[] = [];
  const statuses: string[] = [];
  const onServerRequest: ServerRequestHandler = async (method) => {
    if (method === "item/commandExecution/requestApproval" || method === "item/fileChange/requestApproval") {
      const start = Date.now();
      console.log(`[approval] pending ${method}, holding ${APPROVAL_HOLD_MS}ms`);
      await new Promise((r) => setTimeout(r, APPROVAL_HOLD_MS));
      approvals.push({ method, heldMs: Date.now() - start });
      return { decision: "accept" };
    }
    if (method === "mcpServer/elicitation/request") {
      console.log("[approval] mcp elicitation, accepting");
      return { action: "accept", content: null, _meta: null };
    }
    console.log(`[server request] unhandled ${method}`);
    return {};
  };

  // Phase 1: two threads, each with its own Room MCP identity.
  const server1 = new AppServer(onServerRequest);
  await server1.initialize();
  server1.onNotification((method, params) => {
    if (method === "thread/status/changed") statuses.push(JSON.stringify(params.status));
  });
  const startThread = async (cwd: string, agentId: string): Promise<string> => {
    const r = await server1.request("thread/start", {
      cwd,
      approvalPolicy: "untrusted",
      sandbox: "workspace-write",
      config: threadConfig(agentId),
    });
    return r.thread.id as string;
  };
  const threadA = await startThread(cwdA, "codex-agent-a");
  const threadB = await startThread(cwdB, "codex-agent-b");

  const doneB = server1.waitTurn(threadB);
  await server1.request("turn/start", {
    threadId: threadB,
    input: [text("Call the room_set_status tool with phase 'agent-b' and note 'spike'. Then reply OK.")],
  });

  const doneA = server1.waitTurn(threadA);
  const turnA = await server1.request("turn/start", {
    threadId: threadA,
    input: [
      text(
        "Remember the codeword PAPAYA. Call the room_set_status tool with phase 'agent-a' and note 'spike'. " +
          "Then run the shell command `echo banyan > notes.txt`. Then reply with a one-line summary.",
      ),
    ],
  });
  // Steer while turn A is active (it is blocked on the held approval at this point or soon after).
  await new Promise((r) => setTimeout(r, 3000));
  let steerError = "";
  try {
    await server1.request("turn/steer", {
      threadId: threadA,
      expectedTurnId: turnA.turn.id,
      input: [text("Also include the word KIWI in your final reply.")],
    });
  } catch (e) {
    steerError = (e as Error).message;
  }
  const [resA, resB] = await Promise.all([doneA, doneB]);

  const phases = room.calls.map((c) => `${c.agentId}:${c.phase}`);
  check("thread A MCP bound to agent-a", phases.includes("codex-agent-a:agent-a"), JSON.stringify(phases));
  check("thread B MCP bound to agent-b", phases.includes("codex-agent-b:agent-b"), JSON.stringify(phases));
  check("no cross-thread identity leak", !phases.includes("codex-agent-a:agent-b") && !phases.includes("codex-agent-b:agent-a"), JSON.stringify(phases));
  check("approval held then accepted", approvals.some((a) => a.heldMs >= APPROVAL_HOLD_MS), JSON.stringify(approvals));
  check("waitingOnApproval status observed", statuses.some((s) => s.includes("waitingOnApproval")), statuses.join(" "));
  let fileContent = "";
  try {
    fileContent = readFileSync(join(cwdA, "notes.txt"), "utf8").trim();
  } catch {
    fileContent = "<missing>";
  }
  check("command ran after approval", fileContent === "banyan", fileContent);
  check("steer accepted", steerError === "", steerError || "ok");
  check("steer reflected in final reply", resA.text.includes("KIWI"), resA.text);
  console.log(`[thread B reply] ${resB.text}`);

  // Phase 2: kill the process, resume thread A in a fresh one.
  server1.kill();
  await server1.exited;
  const server2 = new AppServer(onServerRequest);
  await server2.initialize();
  await server2.request("thread/resume", { threadId: threadA, config: threadConfig("codex-agent-a"), excludeTurns: true });
  const recallDone = server2.waitTurn(threadA);
  await server2.request("turn/start", {
    threadId: threadA,
    input: [text("What was the codeword I asked you to remember? Reply with only the codeword.")],
  });
  const recall = await recallDone;
  check("resume after kill recalls context", recall.text.includes("PAPAYA"), recall.text);

  server2.kill();
  await server2.exited;
  await room.close();
}

await main();

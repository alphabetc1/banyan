// Spike: verify the Claude Agent SDK behaviors Banyan's runner depends on.
//   1. Per-session HTTP MCP injection with strictMcpConfig, identity bound by URL.
//   2. canUseTool can stay pending (simulating a human deciding in the web UI).
//   3. Streaming input: a follow-up user message in the same live session.
//   4. Resume by session id after the process ends, including after an abort mid-turn.
import { query, type SDKMessage, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startRoomMcp } from "./room-mcp.ts";

const APPROVAL_HOLD_MS = 20_000;
const AGENT_ID = "claude-spike-agent";

function check(name: string, ok: boolean, detail: string): void {
  console.log(`${ok ? "PASS" : "FAIL"} ${name}: ${detail}`);
  if (!ok) process.exitCode = 1;
}

function userMessage(text: string): SDKUserMessage {
  return { type: "user", message: { role: "user", content: text }, parent_tool_use_id: null };
}

// Async queue so the spike can push follow-up messages into a live session.
class Inbox implements AsyncIterable<SDKUserMessage> {
  private items: SDKUserMessage[] = [];
  private waiters: ((r: IteratorResult<SDKUserMessage>) => void)[] = [];
  private closed = false;
  push(m: SDKUserMessage): void {
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

function resultText(m: SDKMessage): string | undefined {
  return m.type === "result" && m.subtype === "success" ? m.result : undefined;
}

async function main(): Promise<void> {
  const room = await startRoomMcp();
  const cwd = mkdtempSync(join(tmpdir(), "banyan-claude-spike-"));
  const baseOptions = {
    cwd,
    settingSources: [],
    strictMcpConfig: true,
    mcpServers: { room: { type: "http" as const, url: room.url(AGENT_ID) } },
    permissionMode: "default" as const,
    stderr: (d: string) => process.stderr.write(`[claude stderr] ${d}`),
  };

  // Phase 1: live session with a held approval and a follow-up message.
  const inbox = new Inbox();
  inbox.push(
    userMessage(
      "Remember the codeword PAPAYA. First call the room_set_status tool with phase 'exploring' " +
        "and note 'spike'. Then use the Write tool to create notes.txt containing exactly: banyan",
    ),
  );
  let sessionId: string | undefined;
  let heldMs = -1;
  let results = 0;
  let followUpAnswer = "";
  const phase1 = query({
    prompt: inbox,
    options: {
      ...baseOptions,
      canUseTool: async (toolName, input) => {
        // Room tools are Banyan's own channel and never need human approval.
        if (toolName.startsWith("mcp__room__")) return { behavior: "allow", updatedInput: input };
        const start = Date.now();
        console.log(`[approval] pending ${toolName}, holding ${APPROVAL_HOLD_MS}ms`);
        await new Promise((r) => setTimeout(r, APPROVAL_HOLD_MS));
        heldMs = Date.now() - start;
        return { behavior: "allow", updatedInput: input };
      },
    },
  });
  for await (const m of phase1) {
    if (m.type === "system" && m.subtype === "init") {
      sessionId = m.session_id;
      const room = m.mcp_servers.find((s) => s.name === "room");
      check("mcp connected", room?.status === "connected", JSON.stringify(m.mcp_servers));
    }
    if (m.type === "result") {
      results += 1;
      console.log(`[result ${results}] subtype=${m.subtype} cost=${m.total_cost_usd}`);
      if (results === 1) inbox.push(userMessage("Which file did you just create? Reply with only the filename."));
      if (results === 2) {
        followUpAnswer = resultText(m) ?? "";
        inbox.close();
      }
    }
  }
  check("session id captured", sessionId !== undefined, String(sessionId));
  check("mcp tool called with bound identity", room.calls.some((c) => c.agentId === AGENT_ID && c.phase === "exploring"), JSON.stringify(room.calls));
  check("approval held then allowed", heldMs >= APPROVAL_HOLD_MS, `${heldMs}ms`);
  let fileContent = "";
  try {
    fileContent = readFileSync(join(cwd, "notes.txt"), "utf8").trim();
  } catch {
    fileContent = "<missing>";
  }
  check("write happened after approval", fileContent === "banyan", fileContent);
  check("follow-up in live session", followUpAnswer.includes("notes.txt"), followUpAnswer);

  // Phase 2: abort mid-turn to simulate a crash, then resume.
  const abort = new AbortController();
  const phase2 = query({
    prompt: "Count from 1 to 200, one number per line.",
    options: { ...baseOptions, resume: sessionId, abortController: abort },
  });
  let aborted = false;
  try {
    for await (const m of phase2) {
      if (m.type === "assistant" || m.type === "stream_event") {
        abort.abort();
      }
    }
  } catch (e) {
    aborted = true;
    console.log(`[abort] ${(e as Error).name}: ${(e as Error).message}`);
  }
  check("mid-turn abort surfaced", aborted || abort.signal.aborted, `aborted=${aborted}`);

  // Phase 3: resume after the abort and recall context from phase 1.
  let recall = "";
  for await (const m of query({
    prompt: "What was the codeword I asked you to remember? Reply with only the codeword.",
    options: { ...baseOptions, resume: sessionId },
  })) {
    recall = resultText(m) ?? recall;
  }
  check("resume recalls context", recall.includes("PAPAYA"), recall);

  await room.close();
}

await main();

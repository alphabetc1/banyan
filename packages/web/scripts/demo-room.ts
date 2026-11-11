// Starts a room server serving the built UI and fills a demo room through the real API, for
// UI development and review. Prints an invite link to open in a browser.
//   pnpm --filter @banyan/web build && pnpm --filter @banyan/web exec tsx scripts/demo-room.ts
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { draft, newId, type AppendResult, type EventDraft, type ServerMessage } from "@banyan/shared";
import { buildApp } from "@banyan/server/app";

const port = Number(process.env.PORT ?? "7701");
const webDir = fileURLToPath(new URL("../dist", import.meta.url));
const app = await buildApp({ dbPath: join(mkdtempSync(join(tmpdir(), "banyan-demo-")), "demo.sqlite"), webDir });
const base = await app.listen({ host: "127.0.0.1", port });

async function post(path: string, body: unknown, token?: string): Promise<any> {
  const res = await fetch(`${base}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${path}: ${res.status} ${await res.text()}`);
  return res.json();
}

// Opens a socket as a member or runner; runner sockets stay open so the runner shows online.
async function connect(roomId: string, token: string) {
  const ws = new WebSocket(`${base.replace("http", "ws")}/api/rooms/${roomId}/ws?token=${encodeURIComponent(token)}`);
  await new Promise((resolve) => ws.addEventListener("open", resolve, { once: true }));
  const append = (drafts: EventDraft[], asAgent?: string) =>
    new Promise<AppendResult[]>((resolve, reject) => {
      const requestId = newId();
      const onMessage = (e: MessageEvent) => {
        const msg = JSON.parse(String(e.data)) as ServerMessage;
        if (msg.type !== "append_result" || msg.requestId !== requestId) return;
        ws.removeEventListener("message", onMessage);
        const failed = msg.results.find((r) => !r.ok);
        if (failed && !failed.ok) reject(new Error(failed.error));
        else resolve(msg.results);
      };
      ws.addEventListener("message", onMessage);
      ws.send(JSON.stringify({ type: "append", requestId, drafts, ...(asAgent ? { asAgent } : {}) }));
    });
  return { ws, append };
}

const room = await post("/api/rooms", {
  name: "sglang 性能冲刺",
  repoUrl: "git@github.com:example/sglang.git",
  baseBranch: "main",
  goalTitle: "提升 sglang 推理性能",
  goalDescription: "在 H200 上把 Llama-3-70B 的端到端吞吐提升 20%，不牺牲正确性。",
  ownerName: "Rhett",
});
const mac = await post(`/api/rooms/${room.roomId}/runners`, { hostname: "rhett-mbp" }, room.memberToken);
const linux = await post(`/api/rooms/${room.roomId}/runners`, { hostname: "h200-box-3" }, room.memberToken);
const stateRes = await fetch(`${base}/api/rooms/${room.roomId}/state`, { headers: { authorization: `Bearer ${room.memberToken}` } });
const rootGoalId = ((await stateRes.json()) as any).state.room.rootGoalId as string;

const member = await connect(room.roomId, room.memberToken);
const runner = await connect(room.roomId, mac.runnerToken);

const ids = { prefill: newId(), tokenizer: newId(), decode: newId(), gRoot: newId(), gPrefill: newId(), gDecode: newId() };
const agent = (name: string, groupId: string, role: "leader" | "monitor" | "worker", goalId: string, provider: "claude" | "codex", runnerId: string) => ({
  id: newId(),
  d: draft("agent.created", { agentId: "", groupId, runnerId, name, role, provider, model: "default", goalId, instructions: "" }),
  name,
});
await member.append([
  draft("goal.created", { goalId: ids.prefill, parentId: rootGoalId, title: "提升 prefill 性能", description: "长上下文场景下 TTFT 降低 30%" }),
  draft("goal.created", { goalId: ids.tokenizer, parentId: ids.prefill, title: "提升 tokenizer 性能", description: "" }),
  draft("goal.created", { goalId: ids.decode, parentId: rootGoalId, title: "提升 decode 性能", description: "" }),
  draft("group.created", { groupId: ids.gRoot, goalId: rootGoalId, name: "总指挥" }),
  draft("group.created", { groupId: ids.gPrefill, goalId: ids.prefill, name: "prefill 小组" }),
  draft("group.created", { groupId: ids.gDecode, goalId: ids.decode, name: "decode 小组" }),
]);
const agents = [
  agent("captain", ids.gRoot, "leader", rootGoalId, "claude", mac.runnerId),
  agent("prefill-lead", ids.gPrefill, "leader", ids.prefill, "claude", mac.runnerId),
  agent("prefill-watch", ids.gPrefill, "monitor", ids.prefill, "claude", mac.runnerId),
  agent("tok-batching", ids.gPrefill, "worker", ids.tokenizer, "claude", mac.runnerId),
  agent("chunked-prefill", ids.gPrefill, "worker", ids.prefill, "codex", mac.runnerId),
  agent("radix-reuse", ids.gPrefill, "worker", ids.prefill, "claude", mac.runnerId),
  agent("spec-decode", ids.gDecode, "worker", ids.decode, "codex", linux.runnerId),
];
await member.append(agents.map((a) => ({ ...a.d, payload: { ...(a.d.payload as object), agentId: a.id } }) as EventDraft));
const [captain, lead, watch, tok, chunked, radix, spec] = agents.map((a) => a.id) as string[];
const now = Date.now();

for (const id of [captain, lead, watch, tok, chunked, radix]) {
  await runner.append([
    draft("agent.session_bound", { agentId: id!, providerSessionId: newId() }),
    draft("agent.process_changed", { agentId: id!, process: "running", detail: "started" }),
    draft("agent.activity_changed", { agentId: id!, activity: id === tok || id === chunked ? "working" : "idle" }),
  ]);
}
const wt = (agentId: string, branch: string, files: number, ins: number, del: number) => {
  const worktreeId = newId();
  return [
    draft("worktree.created", { worktreeId, agentId, branch, baseSha: "a1b2c3d" }),
    draft("worktree.updated", { worktreeId, headSha: newId().slice(0, 7).toLowerCase(), diffStat: { files, insertions: ins, deletions: del } }),
  ];
};
await runner.append([
  ...wt(tok!, "banyan/demo/tok-batching", 4, 186, 41),
  ...wt(chunked!, "banyan/demo/chunked-prefill", 7, 412, 133),
  ...wt(radix!, "banyan/demo/radix-reuse", 2, 37, 9),
]);
await runner.append([draft("agent.phase_reported", { agentId: tok!, phase: "benchmarking", note: "bench_serving 2k/8k 输入" })], tok);
await runner.append([draft("agent.phase_reported", { agentId: chunked!, phase: "waiting_gpu", note: "排队第 2 位" })], chunked);
await runner.append([draft("agent.phase_reported", { agentId: radix!, phase: "exploring" })], radix);
await runner.append(
  [draft("post.created", { postId: newId(), agentId: tok!, kind: "direction", summary: "批量化 tokenizer 调用", body: "把逐请求 encode 合并成批处理，减少 Python 往返。", evidence: [], proposeRoomVisible: false })],
  tok,
);
await runner.append(
  [draft("post.created", { postId: newId(), agentId: chunked!, kind: "direction", summary: "动态 chunk size", body: "按显存余量自适应调整 chunked prefill 的块大小。", evidence: [], proposeRoomVisible: false })],
  chunked,
);
await runner.append(
  [
    draft("post.created", {
      postId: newId(),
      agentId: tok!,
      kind: "finding",
      summary: "tokenizer 占 8k 输入 prefill 耗时的 31%",
      body: "用 py-spy 采样 200 个请求，encode 平均 41ms。",
      evidence: [{ label: "profile", detail: "py-spy record -o tok.svg --pid <scheduler>" }],
      proposeRoomVisible: true,
    }),
  ],
  tok,
);
await runner.append(
  [draft("post.created", { postId: newId(), agentId: lead!, kind: "conclusion", summary: "prefill 方向分工已定，三个 worker 不重叠", body: "", evidence: [], proposeRoomVisible: true })],
  lead,
);
await runner.append([draft("approval.requested", { approvalId: newId(), agentId: chunked!, tool: "shell", input: "python -m sglang.bench_serving --backend sglang --num-prompts 500" })]);
await runner.append([
  draft("transcript.appended", {
    agentId: tok!,
    entries: [
      { kind: "system", text: "session started by runner", ts: now - 600_000 },
      { kind: "assistant", text: "先读取 room 上下文，确认目标和已有方向。", ts: now - 590_000 },
      { kind: "tool_call", text: "mcp__room__room_get_context {}", ts: now - 589_000 },
      { kind: "assistant", text: "tokenizer 很可能是瓶颈。我先在 8k 输入下做一次 profile。", ts: now - 500_000 },
      { kind: "tool_call", text: 'Bash {"command":"py-spy record -o tok.svg --duration 30 --pid 4123"}', ts: now - 480_000 },
      { kind: "tool_result", text: "Sampling process 100 times a second for 30 seconds. Wrote flamegraph data to 'tok.svg'.", ts: now - 450_000 },
      { kind: "assistant", text: "encode 平均 41ms，占 prefill 的 31%。接下来尝试批量化。", ts: now - 300_000 },
    ],
  }),
]);
await runner.append([draft("message.sent", { messageId: newId(), toAgentId: lead!, text: "chunked-prefill 已经排队等 GPU 20 分钟，建议先让它做 CPU 侧的单测。", delivery: "fyi" })], watch);
await runner.append([draft("message.sent", { messageId: newId(), toAgentId: chunked!, text: "等 GPU 期间先补单测，别空等。", delivery: "steer" })], lead);
member.ws.close();

console.log(`demo room ready. open: ${base}/join/${room.roomId}#invite=${room.inviteToken}`);
console.log("runner rhett-mbp stays online while this process runs; h200-box-3 is offline.");

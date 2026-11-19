// Room MCP tools exercised with a real MCP client against a real server and link.
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { newId, type RoomState } from "@banyan/shared";
import { ServerLink } from "../src/link.ts";
import { LocalStore } from "../src/local-store.ts";
import { MemoryLogger } from "../src/logger.ts";
import { RoomMcp } from "../src/room-mcp.ts";
import { commitAll, createWorktree, ensureClone, git } from "../src/worktree.ts";
import { writeFileSync } from "node:fs";
import { appendAsMember, createFork, createRoom, draft, tempDir, TestServer, waitFor } from "./helpers.ts";

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

type CallResult = { content: { type: string; text: string }[]; isError?: boolean };

async function setup() {
  const server = new TestServer();
  await server.start();
  cleanups.push(() => server.stop());
  const room = await createRoom(server, createFork());
  const groupId = newId();
  const otherGroupId = newId();
  const ids = { L: newId(), M: newId(), W1: newId(), W2: newId(), X: newId(), S1: newId(), S2: newId() };
  const base = { runnerId: room.runnerId, provider: "claude" as const, model: "m", instructions: "" };
  await appendAsMember(server, room.roomId, room.memberToken, [
    draft("goal.created", { goalId: "prefill", parentId: room.rootGoalId, title: "Improve prefill", description: "" }),
    draft("group.created", { groupId, goalId: "prefill", name: "prefill" }),
    draft("group.created", { groupId: otherGroupId, goalId: room.rootGoalId, name: "other" }),
    draft("agent.created", { ...base, agentId: ids.L, groupId, name: "leader", role: "leader", goalId: "prefill" }),
    draft("agent.created", { ...base, agentId: ids.M, groupId, name: "monitor", role: "monitor", goalId: "prefill" }),
    draft("agent.created", { ...base, agentId: ids.W1, groupId, name: "w1", role: "worker", goalId: "prefill" }),
    draft("agent.created", { ...base, agentId: ids.W2, groupId, name: "w2", role: "worker", goalId: "prefill" }),
    draft("agent.created", { ...base, agentId: ids.X, groupId: otherGroupId, name: "x", role: "worker", goalId: room.rootGoalId }),
    draft("agent.created", { ...base, agentId: ids.S1, groupId: null, name: "s1", role: "worker", goalId: "prefill" }),
    draft("agent.created", { ...base, agentId: ids.S2, groupId: null, name: "s2", role: "worker", goalId: "prefill" }),
  ]);
  const store = new LocalStore(join(tempDir("runner"), "runner.sqlite"));
  cleanups.push(() => store.close());
  const log = new MemoryLogger();
  const link = new ServerLink({ serverUrl: server.base, roomId: room.roomId, token: room.runnerToken, store, log, onEvents: () => {} });
  await link.start();
  cleanups.push(() => link.close());
  // W1 gets a real worktree on a real clone so room_commit runs real git.
  const repoDir = join(tempDir("mcp-repo"), "repo");
  await ensureClone(link.state!.room!.repoUrl!, repoDir);
  const wt = await createWorktree({ repoDir, path: join(tempDir("mcp-wt"), "w1"), baseRef: "origin/main", roomShort: "t", agentName: "w1" });
  link.emit([draft("worktree.created", { worktreeId: newId(), agentId: ids.W1, branch: wt.branch, baseSha: wt.baseSha })]);
  await waitFor(() => link.state!.agents[ids.W1]?.worktreeId, "W1 worktree in projection");
  const mcp = new RoomMcp({
    state: () => link.state!,
    emit: (d, asAgent) => link.emit(d, asAgent),
    now: Date.now,
    commit: (agentId, message) => (agentId === ids.W1 ? commitAll(wt.path, "w1", message) : Promise.reject(new Error("no worktree"))),
    head: async (agentId) => {
      if (agentId !== ids.W1) throw new Error("this agent has no worktree");
      return { sha: await git(wt.path, ["rev-parse", "HEAD"]), dirty: (await git(wt.path, ["status", "--porcelain"])) !== "" };
    },
  });
  await mcp.start();
  cleanups.push(() => mcp.close());

  async function client(agentId: string) {
    const c = new Client({ name: "test", version: "0" });
    await c.connect(new StreamableHTTPClientTransport(new URL(mcp.urlFor(agentId))));
    cleanups.push(() => c.close());
    const call = async (name: string, args: Record<string, unknown> = {}) => (await c.callTool({ name, arguments: args })) as CallResult;
    const tools = async () => (await c.listTools()).tools.map((t) => t.name).sort();
    return { call, tools };
  }

  const serverState = (): Promise<RoomState> => server.state(room.roomId, room.memberToken);
  return { server, room, ids, mcp, link, log, store, client, serverState, wt };
}

const textOf = (r: CallResult) => r.content[0]?.text ?? "";

describe("Room MCP", () => {
  it("exposes tools by role", async () => {
    const { ids, client } = await setup();
    const common = ["room_declare_direction", "room_get_context", "room_leaderboard", "room_list_directions", "room_post_finding", "room_propose_learning", "room_search_memory", "room_set_status"];
    const worker = [...common, "room_commit", "room_submit_result"].sort();
    expect(await (await client(ids.W1)).tools()).toEqual(worker);
    expect(await (await client(ids.W2)).tools()).toEqual(worker);
    expect(await (await client(ids.X)).tools()).toEqual(worker);
    expect(await (await client(ids.S1)).tools()).toEqual(worker);
    expect(await (await client(ids.M)).tools()).toEqual([...common, "room_advise_leader", "room_group_digest"].sort());
    expect(await (await client(ids.L)).tools()).toEqual([...common, "room_create_goal", "room_group_digest", "room_message", "room_pending_reviews", "room_review_post"].sort());
  });

  it("commits a worker's worktree on its behalf", async () => {
    const { ids, client, wt } = await setup();
    const w1 = await client(ids.W1);
    expect(textOf(await w1.call("room_commit", { message: "nothing yet" }))).toBe("nothing to commit");
    writeFileSync(join(wt.path, "notes.md"), "# findings\n");
    const result = await w1.call("room_commit", { message: "docs: add findings" });
    expect(textOf(result)).toMatch(/^committed 1 file\(s\) as [0-9a-f]{10}$/);
    expect(await git(wt.path, ["log", "-1", "--format=%s|%an|%ae"])).toBe("docs: add findings|banyan agent w1|w1@agents.banyan.local");
    // A worker whose worktree does not exist yet gets a clear error, not a missing tool.
    const early = await (await client(ids.W2)).call("room_commit", { message: "x" });
    expect(early.isError).toBe(true);
    expect(textOf(early)).toBe("commit failed: no worktree");
  });

  it("searches the room's memory and proposes learnings that join it once approved", async () => {
    const { ids, client, server, room, link, store } = await setup();
    // Recorded apart, so the newer entries have a later timestamp.
    await appendAsMember(server, room.roomId, room.memberToken, [draft("memory.recorded", { entryId: "d1", kind: "directive", title: "Benchmark on H100 only", body: "Other GPUs mislead." })]);
    await new Promise((r) => setTimeout(r, 20));
    await appendAsMember(server, room.roomId, room.memberToken, [
      draft("memory.recorded", { entryId: "f1", kind: "fact", title: "Tokenizer is 30% of prefill", body: "Measured with py-spy on the sharegpt set." }),
      draft("memory.recorded", { entryId: "old", kind: "fact", title: "Prefill uses the old tokenizer", body: "" }),
      draft("memory.retired", { entryId: "old" }),
    ]);
    await waitFor(() => link.state!.memory.old?.retired, "memory in projection");
    const w1 = await client(ids.W1);
    const search = async (args: Record<string, unknown>) => (JSON.parse(textOf(await w1.call("room_search_memory", args))) as { kind: string; title: string }[]).map((e) => e.title);
    // Retired entries never come back; matches on more words rank first.
    expect(await search({ query: "prefill tokenizer" })).toEqual(["Tokenizer is 30% of prefill"]);
    // Equal matches come newest first.
    expect(await search({ query: "H100 py-spy" })).toEqual(["Tokenizer is 30% of prefill", "Benchmark on H100 only"]);
    expect(await search({})).toEqual(["Tokenizer is 30% of prefill", "Benchmark on H100 only"]);
    expect(await search({ kind: "directive" })).toEqual(["Benchmark on H100 only"]);
    expect(await search({ query: "nothing-like-this" })).toEqual([]);

    const proposed = JSON.parse(textOf(await w1.call("room_propose_learning", { title: "Warm up the GPU before timing", body: "First runs are 20% slower." })));
    expect(proposed.status).toBe("pending review");
    await waitFor(() => store.outboxSize() === 0, "outbox to drain");
    expect(await search({ query: "warm" })).toEqual([]);
    const leader = await client(ids.L);
    expect(textOf(await leader.call("room_review_post", { postId: proposed.postId, decision: "approved" }))).toMatch(/approved/);
    await waitFor(() => link.state!.memory[proposed.postId], "approved learning in memory");
    expect(await search({ query: "warm" })).toEqual(["Warm up the GPU before timing"]);
  });

  it("submits committed results on the goal's metric and lists them on the leaderboard", async () => {
    const { ids, client, server, room, link, store, wt } = await setup();
    const w1 = await client(ids.W1);
    const noMetric = await w1.call("room_submit_result", { value: 1 });
    expect(noMetric.isError).toBe(true);
    expect(textOf(noMetric)).toBe("no goal with a metric on your goal path");
    await appendAsMember(server, room.roomId, room.memberToken, [
      draft("goal.metric_set", { goalId: "prefill", metric: { name: "throughput", direction: "higher", unit: "tok/s", command: "sh bench.sh" } }),
    ]);
    await waitFor(() => link.state!.goals.prefill?.metric, "metric in projection");
    // Only committed work can be verified.
    writeFileSync(join(wt.path, "bench.sh"), "echo 1200\n");
    const dirty = await w1.call("room_submit_result", { value: 1200 });
    expect(dirty.isError).toBe(true);
    expect(textOf(dirty)).toMatch(/uncommitted changes; commit them with room_commit first/);
    await w1.call("room_commit", { message: "bench" });
    const head = await git(wt.path, ["rev-parse", "HEAD"]);
    const first = JSON.parse(textOf(await w1.call("room_submit_result", { value: 1200, note: "baseline" })));
    expect(first).toMatchObject({ commit: head });
    const bad = await w1.call("room_submit_result", { value: 1300, basedOn: "nope" });
    expect(textOf(bad)).toBe("unknown result nope on that goal");
    await waitFor(() => store.outboxSize() === 0, "outbox to drain");

    const board = async () => JSON.parse(textOf(await (await client(ids.W2)).call("room_leaderboard")));
    expect(await board()).toMatchObject({ goal: "Improve prefill", ranked: [], pending: [{ claimed: 1200, by: "w1", commit: head, note: "baseline" }] });
    // Once the runner verifies it, it ranks, with the branch to build on.
    link.emit([draft("result.verified", { resultId: first.resultId, value: 1180, log: "1180" })]);
    await waitFor(() => link.state!.results[first.resultId]?.status === "verified", "verified result");
    const ranked = (await board()).ranked;
    expect(ranked).toEqual([{ rank: 1, value: 1180, id: first.resultId, by: "w1", commit: head, branch: wt.branch, basedOn: null, note: "baseline" }]);
    // A leader has no worktree of its own to submit from, but can read the board.
    expect(JSON.parse(textOf(await (await client(ids.L)).call("room_leaderboard"))).ranked).toHaveLength(1);
    expect(textOf(await (await client(ids.X)).call("room_leaderboard"))).toBe("no goal with a metric on your goal path");
  });

  it("rejects requests without the agent's secret", async () => {
    const { ids, mcp } = await setup();
    const url = new URL(mcp.urlFor(ids.W1));
    url.pathname = `/mcp/${ids.W1}/wrong-secret`;
    expect((await fetch(url, { method: "POST" })).status).toBe(404);
  });

  it("records a worker's status, direction and findings as that agent", async () => {
    const { ids, client, serverState, store } = await setup();
    const w1 = await client(ids.W1);
    const context = JSON.parse(textOf(await w1.call("room_get_context")));
    expect(context.you).toEqual({ name: "w1", role: "worker", group: "prefill", goalPath: ["Make the demo better", "Improve prefill"] });

    expect(textOf(await w1.call("room_set_status", { phase: "waiting_gpu", note: "queue 2" }))).toBe("status recorded");
    expect(textOf(await w1.call("room_declare_direction", { summary: "batch tokenizer calls", hypothesis: "fewer round trips" }))).toBe("direction declared");
    const posted = JSON.parse(textOf(await w1.call("room_post_finding", { kind: "finding", summary: "tokenizer is 30% of prefill", body: "profiled", proposeRoomVisible: true })));
    expect(posted.visibility).toBe("group, pending room review");

    await waitFor(() => store.outboxSize() === 0, "outbox to drain");
    const state = await serverState();
    expect(state.agents[ids.W1]?.phase).toMatchObject({ value: "waiting_gpu", note: "queue 2" });
    const posts = Object.values(state.posts).filter((p) => p.agentId === ids.W1);
    expect(posts.map((p) => [p.kind, p.summary, p.review.state]).sort()).toEqual([
      ["direction", "batch tokenizer calls", "none"],
      ["finding", "tokenizer is 30% of prefill", "pending"],
    ]);
    const w2 = await client(ids.W2);
    const directions = await waitFor(async () => {
      const listed = JSON.parse(textOf(await w2.call("room_list_directions")));
      return listed.length === 1 ? listed : null;
    }, "direction listing");
    expect(directions[0]).toMatchObject({ by: "w1", summary: "batch tokenizer calls" });
  });

  it("lets the leader review posts, which then reach the whole room", async () => {
    const { ids, client, link } = await setup();
    const w1 = await client(ids.W1);
    const leader = await client(ids.L);
    const { postId } = JSON.parse(textOf(await w1.call("room_post_finding", { kind: "conclusion", summary: "use batch size 8", body: "", proposeRoomVisible: true })));
    await waitFor(() => link.state!.posts[postId], "post in projection");

    const pending = JSON.parse(textOf(await leader.call("room_pending_reviews")));
    expect(pending.map((p: { id: string }) => p.id)).toEqual([postId]);
    expect(textOf(await leader.call("room_review_post", { postId, decision: "approved", note: "convincing" }))).toBe("post approved");
    await waitFor(() => link.state!.posts[postId]?.review.state === "approved", "review in projection");

    const otherGroupContext = JSON.parse(textOf(await (await client(ids.X)).call("room_get_context")));
    expect(otherGroupContext.roomConclusions.map((p: { summary: string }) => p.summary)).toEqual(["use batch size 8"]);
    expect(otherGroupContext.peerFindings).toEqual([]);
  });

  it("shows a standalone agent the work of the agents on its goal", async () => {
    const { ids, client, link } = await setup();
    const s1 = await client(ids.S1);
    const s2 = await client(ids.S2);
    const w1 = await client(ids.W1);
    const x = await client(ids.X);
    await s2.call("room_declare_direction", { summary: "cache tokenizer output", hypothesis: "repeat prompts" });
    const { postId: soloPost } = JSON.parse(textOf(await s2.call("room_post_finding", { kind: "finding", summary: "solo finding", body: "", proposeRoomVisible: false })));
    await w1.call("room_post_finding", { kind: "finding", summary: "group finding", body: "", proposeRoomVisible: false });
    await x.call("room_post_finding", { kind: "finding", summary: "other goal finding", body: "", proposeRoomVisible: false });
    await waitFor(() => Object.keys(link.state!.posts).length === 4, "posts in projection");
    expect(link.state!.posts[soloPost]).toMatchObject({ groupId: null, goalId: "prefill" });

    const context = JSON.parse(textOf(await s1.call("room_get_context")));
    expect(context.you).toMatchObject({ name: "s1", group: null, goalPath: ["Make the demo better", "Improve prefill"] });
    expect(context.peers).toBe("agents on your goal");
    expect(context.peerFindings.map((p: { summary: string }) => p.summary).sort()).toEqual(["group finding", "solo finding"]);
    expect(context.peerDirections.map((p: { summary: string }) => p.summary)).toEqual(["cache tokenizer output"]);
    // Directions default to the standalone agent's own goal.
    expect(JSON.parse(textOf(await s1.call("room_list_directions"))).map((p: { summary: string }) => p.summary)).toEqual(["cache tokenizer output"]);
    // A group member's peers stay its group.
    const groupContext = JSON.parse(textOf(await w1.call("room_get_context")));
    expect(groupContext.peers).toBe("your group");
    expect(groupContext.peerFindings.map((p: { summary: string }) => p.summary)).toEqual(["group finding"]);
  });

  it("surfaces authorization failures to the calling agent", async () => {
    const { ids, client, link } = await setup();
    const leader = await client(ids.L);
    const own = JSON.parse(textOf(await leader.call("room_post_finding", { kind: "finding", summary: "mine", body: "", proposeRoomVisible: true })));
    await waitFor(() => link.state!.posts[own.postId], "leader post in projection");
    const selfReview = await leader.call("room_review_post", { postId: own.postId, decision: "approved" });
    expect(selfReview.isError).toBe(true);
    expect(textOf(selfReview)).toMatch(/parent leader/);

    const crossGroup = await leader.call("room_message", { agent: "x", text: "hi" });
    expect(crossGroup.isError).toBe(true);
    expect(textOf(crossGroup)).toMatch(/leaders may message their group/);

    const outside = await leader.call("room_create_goal", { parentGoalId: link.state!.room!.rootGoalId, title: "decode" });
    expect(outside.isError).toBe(true);
  });

  it("routes leader messages and monitor advice", async () => {
    const { ids, client, serverState, store } = await setup();
    const leader = await client(ids.L);
    const monitor = await client(ids.M);
    expect(textOf(await leader.call("room_message", { agent: "w2", text: "switch to kv cache", delivery: "steer" }))).toBe("message sent to w2");
    expect(textOf(await monitor.call("room_advise_leader", { text: "w1 looks stuck", severity: "high" }))).toBe("advice sent to leader");
    const digest = JSON.parse(textOf(await monitor.call("room_group_digest")));
    expect(digest.agents.map((a: { name: string }) => a.name).sort()).toEqual(["leader", "monitor", "w1", "w2"]);

    await waitFor(() => store.outboxSize() === 0, "outbox to drain");
    const messages = Object.values((await serverState()).messages);
    expect(messages.map((m) => [m.from, m.toAgentId, m.delivery, m.text]).sort()).toEqual(
      [
        [{ kind: "agent", id: ids.L }, ids.W2, "steer", "switch to kv cache"],
        [{ kind: "agent", id: ids.M }, ids.L, "steer", "w1 looks stuck"],
      ].sort(),
    );
  });
});

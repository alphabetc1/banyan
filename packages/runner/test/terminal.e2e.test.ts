// End to end: a real runner runs a real interactive Claude Code in a pseudo-terminal against
// a real room server and git fork, following it through hooks. Costs real API usage; run with
// `pnpm test:e2e`.
import { afterEach, describe, expect, it } from "vitest";
import { newId, type RoomState } from "@banyan/shared";
import { MemoryLogger } from "../src/logger.ts";
import { Runner } from "../src/runner.ts";
import { appendAsMember, createFork, createRoom, draft, tempDir, TestServer, waitFor } from "./helpers.ts";

const STEP_TIMEOUT_MS = 4 * 60_000;

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

const plain = (s: string) => s.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "").replace(/\x1b\][^\x07]*\x07/g, "");

describe("Claude Code in a terminal", () => {
  it("follows a real interactive session through hooks: status, permission waits, room messages and resume", { timeout: 15 * 60_000 }, async () => {
    const server = new TestServer();
    await server.start();
    cleanups.push(() => server.stop());
    const room = await createRoom(server, createFork());
    const roomDir = tempDir("terminal-room");
    const agentId = newId();
    const state = (): Promise<RoomState> => server.state(room.roomId, room.memberToken);
    const phase = async () => (await state()).agents[agentId]?.phase?.value;
    const transcript = async () => {
      const res = await fetch(`${server.base}/api/rooms/${room.roomId}/agents/${agentId}/transcript?limit=200`, { headers: { authorization: `Bearer ${room.memberToken}` } });
      const { events } = (await res.json()) as { events: { payload: { entries: { kind: string; text: string; messageId?: string }[] } }[] };
      return [...events].reverse().flatMap((e) => e.payload.entries);
    };
    const log = new MemoryLogger();
    // Default permission mode makes Claude Code ask before running shell commands.
    const startRunner = async () => {
      const runner = new Runner({ serverUrl: server.base, roomId: room.roomId, runnerId: room.runnerId, runnerToken: room.runnerToken, roomDir, claudePermissionMode: "default" }, log);
      await runner.start();
      return runner;
    };
    let runner = await startRunner();
    cleanups.push(() => runner.stop());
    await appendAsMember(server, room.roomId, room.memberToken, [
      draft("agent.created", {
        agentId,
        groupId: null,
        runnerId: room.runnerId,
        name: "term",
        role: "worker",
        provider: "claude",
        model: "default",
        goalId: room.rootGoalId,
        instructions: 'This is an automated test of Banyan. Call room_set_status with phase "terminal-ok", then reply DONE and wait for further messages.',
        terminal: true,
      }),
    ]);

    // The worktree is in a temporary folder Claude Code has never trusted: the agent waits for
    // its person, who answers the question in the terminal (the default answer is "No, exit").
    await waitFor(async () => (await state()).agents[agentId]?.activity === "awaiting_input", "the folder trust question", STEP_TIMEOUT_MS, 500);
    runner.terminal(agentId)!.write("\x1b[B");
    await new Promise((r) => setTimeout(r, 300));
    runner.terminal(agentId)!.write("\r");

    // The Room MCP given on the command line works, and the session id is known up front.
    await waitFor(async () => (await phase()) === "terminal-ok", "the terminal agent using the Room MCP", STEP_TIMEOUT_MS, 1000);
    const sessionId = (await state()).agents[agentId]!.providerSessionId;
    expect(sessionId).toMatch(/^[0-9a-f-]{36}$/);
    await waitFor(async () => (await state()).agents[agentId]?.activity === "idle", "idle after the turn", STEP_TIMEOUT_MS, 500);
    const terminal = runner.terminal(agentId)!;
    const view = terminal.attach(() => {});
    expect(plain(view.backlog)).toContain("terminal-ok");
    view.detach();
    const first = await transcript();
    expect(first.some((e) => e.kind === "user" && e.text.startsWith("Start working on your goal"))).toBe(true);
    expect(first.some((e) => e.kind === "tool_call" && e.text.startsWith("mcp__room__room_set_status"))).toBe(true);
    expect(first.some((e) => e.kind === "assistant" && e.text.includes("DONE"))).toBe(true);

    // A room message is typed in and recorded once, with its id.
    await appendAsMember(server, room.roomId, room.memberToken, [
      draft("message.sent", { messageId: newId(), toAgentId: agentId, text: 'Create an empty file named probe.txt with the Bash tool using touch, then call room_set_status with phase "file-done".', delivery: "fyi" }),
    ]);
    // Claude Code stops at its permission prompt; the agent shows as waiting for its person.
    await waitFor(async () => (await state()).agents[agentId]?.activity === "awaiting_input", "the permission wait", STEP_TIMEOUT_MS, 500);
    // The person answers in the terminal, as they would at the keyboard.
    terminal.write("1");
    await new Promise((r) => setTimeout(r, 300));
    terminal.write("\r");
    await waitFor(async () => (await phase()) === "file-done", "the agent finishing after approval", STEP_TIMEOUT_MS, 1000);
    const second = await transcript();
    const delivered = second.filter((e) => e.kind === "user" && e.text.includes("probe.txt"));
    expect(delivered).toHaveLength(1);
    expect(delivered[0]!.messageId).toEqual(expect.any(String));
    expect(Object.values((await state()).messages)[0]!.deliveredAt).toEqual(expect.any(Number));

    // After a runner restart the same session resumes and keeps its context.
    await runner.stop();
    runner = await startRunner();
    await appendAsMember(server, room.roomId, room.memberToken, [
      draft("message.sent", { messageId: newId(), toAgentId: agentId, text: 'Which phase did you report last? Call room_set_status with phase "resumed-" followed by that phase.', delivery: "fyi" }),
    ]);
    await waitFor(async () => (await phase()) === "resumed-file-done", "the resumed session remembering its last phase", STEP_TIMEOUT_MS, 1000);
    expect((await state()).agents[agentId]!.providerSessionId).toBe(sessionId);
    expect(log.lines.filter((l) => l.level === "error")).toEqual([]);
  });
});

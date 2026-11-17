// End to end: a real runner runs the real interactive Claude Code and Codex CLIs in
// pseudo-terminals against a real room server and git fork, following them through hooks.
// Costs real API usage; run with `pnpm test:e2e`.
import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
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
    // Keys go in once the whole menu is on screen, as a person would press them.
    const screenText = () => plain(runner.terminal(agentId)?.attach(() => {}).backlog ?? "").replace(/\s/g, "");
    await waitFor(() => /entertoconfirm/i.test(screenText()), "the trust menu to be ready", STEP_TIMEOUT_MS, 200);
    await new Promise((r) => setTimeout(r, 500));
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
    // The terminal shows Claude Code's own UI, with the prompt it started on.
    expect(plain(view.backlog).replace(/\s/g, "")).toContain("Startworkingonyourgoal");
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

  it("runs plain Codex in its terminal: first-time trust questions once, hooks, and resume", { timeout: 15 * 60_000 }, async () => {
    // A Codex home of its own, so the folder and hook trust this test grants stay out of the
    // person's ~/.codex; only the login is copied in.
    const codexHome = mkdtempSync(join(tmpdir(), "banyan-codex-home-"));
    cleanups.push(() => rmSync(codexHome, { recursive: true, force: true }));
    copyFileSync(join(homedir(), ".codex", "auth.json"), join(codexHome, "auth.json"));
    const previousCodexHome = process.env.CODEX_HOME;
    process.env.CODEX_HOME = codexHome;
    cleanups.push(() => {
      if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = previousCodexHome;
    });

    const server = new TestServer();
    await server.start();
    cleanups.push(() => server.stop());
    // A personal workspace: its standalone agents are plain CLI sessions.
    const room = await createRoom(server, createFork(), true);
    const roomDir = tempDir("codex-terminal-room");
    const agentId = newId();
    const state = (): Promise<RoomState> => server.state(room.roomId, room.memberToken);
    const agent = async () => (await state()).agents[agentId];
    const transcript = async () => {
      const res = await fetch(`${server.base}/api/rooms/${room.roomId}/agents/${agentId}/transcript?limit=200`, { headers: { authorization: `Bearer ${room.memberToken}` } });
      const { events } = (await res.json()) as { events: { payload: { entries: { kind: string; text: string }[] } }[] };
      return [...events].reverse().flatMap((e) => e.payload.entries);
    };
    const log = new MemoryLogger();
    const startRunner = async () => {
      const runner = new Runner({ serverUrl: server.base, roomId: room.roomId, runnerId: room.runnerId, runnerToken: room.runnerToken, roomDir }, log);
      await runner.start();
      return runner;
    };
    let runner = await startRunner();
    cleanups.push(() => runner.stop());
    await appendAsMember(server, room.roomId, room.memberToken, [
      draft("agent.created", { agentId, groupId: null, runnerId: room.runnerId, name: "codex-term", role: "worker", provider: "codex", model: "default", goalId: room.rootGoalId, instructions: "Reply with exactly the word PLAIN-OK and nothing else.", terminal: true }),
    ]);
    const screen = () => plain(runner.terminal(agentId)?.attach(() => {}).backlog ?? "").replace(/\s/g, "");
    const answer = async (...keys: string[]) => {
      for (const key of keys) {
        runner.terminal(agentId)!.write(key);
        await new Promise((r) => setTimeout(r, 400));
      }
    };

    // First time: Codex asks to trust the folder (default: trust), then to review Banyan's
    // hook; the agent waits for its person meanwhile.
    await waitFor(async () => (await agent())?.activity === "awaiting_input" && /trustthisfolder/i.test(screen()), "the folder trust question", STEP_TIMEOUT_MS, 500);
    await answer("\r");
    await waitFor(async () => (await agent())?.activity === "awaiting_input" && /hooksn?eedreview/i.test(screen()), "the hook review", STEP_TIMEOUT_MS, 500);
    await answer("\x1b[B", "\r");

    // Hooks report the turn: Codex's session id, the prompt, the reply, and idle at the end.
    await waitFor(async () => (await transcript()).some((e) => e.kind === "assistant" && e.text.includes("PLAIN-OK")), "the reply through hooks", STEP_TIMEOUT_MS, 1000);
    await waitFor(async () => (await agent())?.activity === "idle", "idle after the turn", STEP_TIMEOUT_MS, 500);
    const sessionId = (await agent())!.providerSessionId;
    expect(sessionId).toMatch(/^[0-9a-f-]{36}$/);
    const first = await transcript();
    // A plain agent gets exactly its instructions, with no Banyan coordination around them.
    expect(first.filter((e) => e.kind === "user").map((e) => e.text)).toEqual(["Reply with exactly the word PLAIN-OK and nothing else."]);
    expect(first.some((e) => e.text.includes("room_"))).toBe(false);

    // After a restart the session resumes without a second hook review. It waits for its
    // person, so a room message stays pending rather than being typed into whatever the CLI
    // shows (here possibly its update menu, which this fresh Codex home has never answered).
    await runner.stop();
    runner = await startRunner();
    await waitFor(async () => (await agent())?.process === "running", "the resumed session", STEP_TIMEOUT_MS, 500);
    const messageId = newId();
    await appendAsMember(server, room.roomId, room.memberToken, [
      draft("message.sent", { messageId, toAgentId: agentId, text: "Reply with exactly the word MESSAGE-OK and nothing else.", delivery: "fyi" }),
    ]);
    await new Promise((r) => setTimeout(r, 8000));
    expect((await state()).messages[messageId]!.deliveredAt).toBeNull();
    expect(/hooksn?eedreview/i.test(screen())).toBe(false);
    if (/updatenow/i.test(screen())) {
      expect((await agent())!.activity).toBe("awaiting_input");
      await answer("\x1b[B", "\r");
    }
    // The person types in the terminal: the same conversation continues, and once a hook shows
    // Codex at its prompt the waiting message goes in too.
    await answer("\x1b[200~Which word did you reply with first? Reply with that word followed by -AGAIN.\x1b[201~", "\r");
    await waitFor(async () => (await transcript()).some((e) => e.kind === "assistant" && e.text.includes("PLAIN-OK-AGAIN")), "the resumed conversation", STEP_TIMEOUT_MS, 1000);
    await waitFor(async () => (await transcript()).some((e) => e.kind === "assistant" && e.text.includes("MESSAGE-OK")), "the waiting message after the turn", STEP_TIMEOUT_MS, 1000);
    expect((await state()).messages[messageId]!.deliveredAt).toEqual(expect.any(Number));
    expect((await agent())!.providerSessionId).toBe(sessionId);
    expect(log.lines.filter((l) => l.level === "error")).toEqual([]);
  });
});

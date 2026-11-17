// A plain terminal agent: the person's own shell in the agent's worktree, run by a real runner.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { newId } from "@banyan/shared";
import { MemoryLogger } from "../src/logger.ts";
import { Runner } from "../src/runner.ts";
import { appendAsMember, createFork, createRoom, draft, tempDir, TestServer, waitFor } from "./helpers.ts";

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

const plain = (s: string) => s.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "").replace(/\x1b\][^\x07]*\x07/g, "");

describe("shell terminal", () => {
  // A real clone, worktree and shell, and a session without hooks counts as started only after
  // a few seconds: more than the default test budget under parallel load.
  it("opens the person's shell in the agent's worktree and takes typed input", { timeout: 30_000 }, async () => {
    const server = new TestServer();
    await server.start();
    cleanups.push(() => server.stop());
    const room = await createRoom(server, createFork(), true);
    const roomDir = tempDir("shell-room");
    const log = new MemoryLogger();
    const runner = new Runner({ serverUrl: server.base, roomId: room.roomId, runnerId: room.runnerId, runnerToken: room.runnerToken, roomDir }, log);
    await runner.start();
    cleanups.push(() => runner.stop());
    const agentId = newId();
    await appendAsMember(server, room.roomId, room.memberToken, [
      draft("agent.created", { agentId, groupId: null, runnerId: room.runnerId, name: "sh", role: "worker", provider: "shell", model: "default", goalId: room.rootGoalId, instructions: "", terminal: true }),
    ]);
    await waitFor(async () => (await server.state(room.roomId, room.memberToken)).agents[agentId]?.process === "running", "the shell running");
    const terminal = runner.terminal(agentId)!;
    let output = "";
    const view = terminal.attach((d) => (output += d));
    terminal.write("cd . && echo BANYAN-SHELL-$((40+2)) && pwd\r");
    await waitFor(() => plain(output).includes("BANYAN-SHELL-42"), "the shell's answer");
    expect(plain(output)).toContain(`worktrees/${agentId}`);
    view.detach();
    // A shell has no hooks: no session to resume and no transcript of its own.
    const agent = (await server.state(room.roomId, room.memberToken)).agents[agentId]!;
    expect(agent.providerSessionId).toBeNull();
    expect(log.lines.filter((l) => l.level === "error")).toEqual([]);
  });

  it("restarts an agent whose terminal was exited on request, and stops and forgets a removed one", { timeout: 60_000 }, async () => {
    const server = new TestServer();
    await server.start();
    cleanups.push(() => server.stop());
    const room = await createRoom(server, createFork(), true);
    const roomDir = tempDir("shell-room");
    const log = new MemoryLogger();
    const startRunner = async () => {
      const r = new Runner({ serverUrl: server.base, roomId: room.roomId, runnerId: room.runnerId, runnerToken: room.runnerToken, roomDir }, log);
      await r.start();
      return r;
    };
    let runner = await startRunner();
    cleanups.push(() => runner.stop());
    const agentId = newId();
    const agent = async () => (await server.state(room.roomId, room.memberToken)).agents[agentId]!;
    await appendAsMember(server, room.roomId, room.memberToken, [
      draft("agent.created", { agentId, groupId: null, runnerId: room.runnerId, name: "sh", role: "worker", provider: "shell", model: "default", goalId: room.rootGoalId, instructions: "", terminal: true }),
    ]);
    await waitFor(async () => (await agent())?.process === "running", "the shell running");

    // Exiting the shell ends the agent; it is not a crash, so nothing restarts it by itself.
    runner.terminal(agentId)!.write("exit\r");
    await waitFor(async () => (await agent()).process === "exited", "the shell exiting");
    await new Promise((r) => setTimeout(r, 1000));
    expect((await agent()).process).toBe("exited");
    expect(runner.terminal(agentId)).toBeNull();

    // The person restarts it: a new terminal.
    await appendAsMember(server, room.roomId, room.memberToken, [draft("agent.restart_requested", { agentId })]);
    await waitFor(async () => (await agent()).process === "running", "the shell running again");
    let output = "";
    runner.terminal(agentId)!.attach((d) => (output += d));
    runner.terminal(agentId)!.write("echo AGAIN-$((1+1))\r");
    await waitFor(() => plain(output).includes("AGAIN-2"), "the new shell answering");

    // Removing it ends its terminal for good, also across a runner restart; its worktree stays.
    await appendAsMember(server, room.roomId, room.memberToken, [draft("agent.archived", { agentId })]);
    await waitFor(async () => (await agent()).process === "exited", "the removed shell ending");
    expect(runner.terminal(agentId)).toBeNull();
    await runner.stop();
    runner = await startRunner();
    await new Promise((r) => setTimeout(r, 4000));
    expect(await agent()).toMatchObject({ archived: true, process: "exited" });
    expect(runner.terminal(agentId)).toBeNull();
    expect(existsSync(join(roomDir, "worktrees", agentId))).toBe(true);
    expect(log.lines.filter((l) => l.level === "error")).toEqual([]);
  });
});

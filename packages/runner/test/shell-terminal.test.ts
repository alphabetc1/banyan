// A plain terminal agent: the person's own shell in the agent's worktree, run by a real runner.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { newId } from "@banyan/shared";
import { MemoryLogger } from "../src/logger.ts";
import { Runner } from "../src/runner.ts";
import { TerminalScreen } from "../src/terminal-screen.ts";
import { appendAsMember, createFork, createRoom, draft, endProcessesUnder, tempDir, TestServer, waitFor } from "./helpers.ts";

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

  it("gives a view attaching mid-stream the screen so far, then exactly the output after it", { timeout: 60_000 }, async () => {
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
    const [cols, rows] = [80, 24];
    terminal.resize(cols, rows);
    // A second view attaches while the output streams, from an event of its own as a page does,
    // so more output is on its way and not yet on the screen.
    let early = "";
    let later = "";
    let attaching = false;
    let view: ReturnType<typeof terminal.attach> | null = null;
    terminal.attach((d) => {
      early += d;
      if (attaching || !early.includes("line 11000")) return;
      attaching = true;
      setImmediate(() => (view = terminal.attach((d2) => (later += d2))));
    });
    // Far more 24-bit colored output than the screen holds, then a status line redrawn in place
    // through relative cursor moves, as the CLIs draw their spinners.
    terminal.write(
      "for i in $(seq 1 12000); do printf '\\033[38;2;215;134;102mline %d\\033[0m\\r\\n' $i; done; " +
        "printf 'Composing 1s\\r\\n'; for s in $(seq 2 50); do printf '\\033[1A\\033[2KComposing %ds\\r\\n' $s; done; echo FINISHED-$((1+1))\r",
    );
    await waitFor(() => plain(early).includes("FINISHED-2"), "the output and the redraws", 30_000, 200);
    // Wait for the shell's prompt after the command, so no output is still on its way.
    await new Promise((r) => setTimeout(r, 500));
    view!.detach();

    // A terminal the size of the view, after drawing the given output.
    const drawn = async (output: string) => {
      const screen = new TerminalScreen(cols, rows);
      screen.write(output);
      await new Promise<void>((resolve) => screen.afterPending(resolve));
      return screen;
    };
    const final = await drawn(terminal.attach(() => {}).screen);
    expect(final.text()).toContain("line 12000\nComposing 50s\nFINISHED-2");
    expect(final.text()).not.toContain("134;102m");
    // The same screen and history, line 11000 onwards included.
    expect((await drawn(view!.screen + later)).serialize()).toBe(final.serialize());
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

  it("starts Claude Code and Codex with the person's extra arguments, and new ones apply to the next start", { timeout: 60_000 }, async () => {
    // Codex gets a throwaway home, so nothing is written to the person's ~/.codex.
    const codexHome = tempDir("codex-home");
    cleanups.push(() => endProcessesUnder(codexHome));
    const previousCodexHome = process.env.CODEX_HOME;
    process.env.CODEX_HOME = codexHome;
    cleanups.push(() => {
      if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = previousCodexHome;
    });
    const server = new TestServer();
    await server.start();
    cleanups.push(() => server.stop());
    const room = await createRoom(server, createFork(), true);
    const roomDir = tempDir("args-room");
    const terminalArgs = { claude: ["--dangerously-skip-permissions"], codex: ["--yolo", "--sandbox", "danger-full-access"] };
    const runner = new Runner({ serverUrl: server.base, roomId: room.roomId, runnerId: room.runnerId, runnerToken: room.runnerToken, roomDir, terminalArgs }, new MemoryLogger());
    await runner.start();
    cleanups.push(() => runner.stop());
    const ids = { claude: newId(), codex: newId() };
    // Plain agents with no first message: neither CLI sends anything to a model.
    await appendAsMember(server, room.roomId, room.memberToken, (["claude", "codex"] as const).map((provider) =>
      draft("agent.created", { agentId: ids[provider], groupId: null, runnerId: room.runnerId, name: provider, role: "worker", provider, model: "default", goalId: room.rootGoalId, instructions: "", terminal: true }),
    ));
    const state = () => server.state(room.roomId, room.memberToken);
    await waitFor(async () => {
      const s = await state();
      return s.agents[ids.claude]?.process === "running" && s.agents[ids.codex]?.process === "running";
    }, "both terminals running", 30_000);
    // The arguments as the operating system shows them for each recorded terminal process.
    const commandLines = () =>
      readFileSync(join(roomDir, "agent-processes"), "utf8")
        .split("\n")
        .filter(Boolean)
        .map((l) => execFileSync("ps", ["-o", "args=", "-p", String((JSON.parse(l) as { pid: number }).pid)], { encoding: "utf8" }).trim());
    const claudeLine = () => commandLines().find((c) => c.includes("claude --settings"))!;
    const codexLine = () => commandLines().find((c) => c.includes("codex -c"))!;
    expect(claudeLine()).toContain("--dangerously-skip-permissions --session-id");
    expect(codexLine()).toContain("--yolo --sandbox danger-full-access");

    // New arguments reach terminals started afterwards.
    runner.setTerminalArgs({ claude: ["--permission-mode", "plan"], codex: [] });
    await appendAsMember(server, room.roomId, room.memberToken, [draft("agent.archived", { agentId: ids.codex })]);
    // Claude Code shows its folder trust question here; its default answer, "No, exit", ends it,
    // and as the person's answer that is not a crash to restart from.
    await waitFor(() => /entertoconfirm/i.test(plain(runner.terminal(ids.claude)!.attach(() => {}).screen).replace(/\s/g, "")), "the trust question's menu");
    await new Promise((r) => setTimeout(r, 500));
    runner.terminal(ids.claude)!.write("\r");
    await waitFor(async () => (await state()).agents[ids.claude]?.process === "exited", "claude exiting");
    await new Promise((r) => setTimeout(r, 6000));
    expect((await state()).agents[ids.claude]?.process).toBe("exited");
    await appendAsMember(server, room.roomId, room.memberToken, [draft("agent.restart_requested", { agentId: ids.claude })]);
    await waitFor(async () => (await state()).agents[ids.claude]?.process === "running" && claudeLine()?.includes("--permission-mode plan"), "claude restarted with the new arguments", 30_000);
    expect(claudeLine()).not.toContain("--dangerously-skip-permissions");
  });
});

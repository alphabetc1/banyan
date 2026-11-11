import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { AgentProcesses, killLeftoverAgentProcesses } from "../src/agent-processes.ts";
import { MemoryLogger } from "../src/logger.ts";
import { Runner } from "../src/runner.ts";
import { createFork, createRoom, tempDir, TestServer, waitFor } from "./helpers.ts";

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

// Members of a process group, from `ps`.
const groupMembers = (pgid: number) =>
  execFileSync("ps", ["-A", "-o", "pid=,pgid="], { encoding: "utf8" })
    .trim()
    .split("\n")
    .map((line) => line.trim().split(/\s+/).map(Number))
    .filter(([, g]) => g === pgid)
    .map(([pid]) => pid!);

const recorded = (roomDir: string) =>
  readFileSync(join(roomDir, "agent-processes"), "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as { pid: number; signature: string });

describe("agent processes", () => {
  it("records each process and forgets it when it exits", async () => {
    const roomDir = tempDir("procs");
    const child = new AgentProcesses(roomDir).spawn("sh", ["-c", "exit 0"]);
    const exited = new Promise((resolve) => child.once("exit", resolve));
    expect(recorded(roomDir)).toEqual([{ pid: child.pid, signature: "sh -c" }]);
    await exited;
    expect(recorded(roomDir)).toEqual([]);
  });

  it("ends the whole process group of a process left by a runner that died", async () => {
    const roomDir = tempDir("procs");
    // The shell's background sleep stands in for a tool command the agent started.
    const child = new AgentProcesses(roomDir).spawn("sh", ["-c", "sleep 60 & sleep 60"]);
    const pid = child.pid!;
    const members = await waitFor(() => (groupMembers(pid).length >= 3 ? groupMembers(pid) : null), "the group's sleeps to start");
    expect(await killLeftoverAgentProcesses(roomDir)).toEqual([pid]);
    await waitFor(() => members.every((m) => !alive(m)), "the whole group to end");
    expect(recorded(roomDir)).toEqual([]);
  });

  it("lets a process end the tool commands it started in a process group of their own", async () => {
    const roomDir = tempDir("procs");
    // Like the agent CLIs: the tool command gets its own group (job control), and the CLI
    // ends it on SIGTERM.
    const child = new AgentProcesses(roomDir).spawn("sh", ["-c", 'set -m; sleep 60 & tool=$!; echo $tool; trap "kill $tool; exit 0" TERM; wait']);
    const tool = Number(await new Promise<string>((resolve) => child.stdout.once("data", (d: Buffer) => resolve(d.toString().trim()))));
    expect(groupMembers(child.pid!)).not.toContain(tool);
    expect(await killLeftoverAgentProcesses(roomDir)).toEqual([child.pid]);
    await waitFor(() => !alive(tool), "the tool command to end");
  });

  it("is cleaned up by the next runner start", async () => {
    const server = new TestServer();
    await server.start();
    const room = await createRoom(server, createFork());
    const roomDir = tempDir("procs");
    // The trailing command keeps sh from exec-ing into sleep, so the recorded signature still matches.
    const leftover = new AgentProcesses(roomDir).spawn("sh", ["-c", "sleep 60; true"]);
    const log = new MemoryLogger();
    const runner = new Runner({ serverUrl: server.base, roomId: room.roomId, runnerId: room.runnerId, runnerToken: room.runnerToken, roomDir }, log);
    await runner.start();
    await waitFor(() => !alive(leftover.pid!), "the leftover process to end");
    expect(log.lines).toEqual([{ level: "warn", msg: `ended agent process(es) left by a previous runner: ${leftover.pid}` }]);
    await runner.stop();
    await server.stop();
  });

  it("leaves alone a recorded pid that now belongs to another program", async () => {
    const roomDir = tempDir("procs");
    writeFileSync(join(roomDir, "agent-processes"), `${JSON.stringify({ pid: process.pid, signature: "claude --output-format" })}\n`);
    expect(await killLeftoverAgentProcesses(roomDir)).toEqual([]);
    expect(alive(process.pid)).toBe(true);
    expect(recorded(roomDir)).toEqual([]);
  });

  it("does nothing when nothing was recorded", async () => {
    expect(await killLeftoverAgentProcesses(tempDir("procs"))).toEqual([]);
  });
});

import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { newId, type RoomEvent } from "@banyan/shared";
import { ServerLink } from "../src/link.ts";
import { LocalStore } from "../src/local-store.ts";
import { MemoryLogger } from "../src/logger.ts";
import { appendAsMember, createFork, createRoom, draft, tempDir, TestServer, waitFor, type RoomFixture } from "./helpers.ts";

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

async function setup() {
  const server = new TestServer();
  await server.start();
  const room = await createRoom(server, createFork());
  const groupId = newId();
  const agentId = newId();
  await appendAsMember(server, room.roomId, room.memberToken, [
    draft("group.created", { groupId, goalId: room.rootGoalId, name: "g" }),
    draft("agent.created", { agentId, groupId, runnerId: room.runnerId, name: "w", role: "worker", provider: "claude", model: "m", goalId: room.rootGoalId, instructions: "" }),
  ]);
  const store = new LocalStore(join(tempDir("runner"), "runner.sqlite"));
  const log = new MemoryLogger();
  const received: RoomEvent[] = [];
  const link = new ServerLink({ serverUrl: server.base, roomId: room.roomId, token: room.runnerToken, store, log, onEvents: (e) => received.push(...e) });
  await link.start();
  cleanups.push(() => store.close());
  cleanups.push(() => link.close());
  cleanups.push(async () => {
    if (server.app.server.listening) await server.stop();
  });
  return { server, room, store, log, link, received, agentId };
}

// A disconnect logs the loss and the recovery; failed reconnect attempts in between may add
// connection warnings depending on timing, and nothing else may appear.
function expectDisconnectLogs(log: MemoryLogger): void {
  expect(log.lines[0]).toEqual({ level: "warn", msg: "room server connection lost; reconnecting" });
  expect(log.lines.at(-1)).toEqual({ level: "info", msg: "reconnected to room server" });
  for (const line of log.lines.slice(1, -1)) {
    expect(line.level).toBe("warn");
    expect(line.msg).toMatch(/^room server (unreachable|connection error)/);
  }
}

function serverAgent(server: TestServer, room: RoomFixture, agentId: string) {
  return server.state(room.roomId, room.memberToken).then((s) => s.agents[agentId]);
}

describe("ServerLink", () => {
  it("loads the room state and applies live events", async () => {
    const { server, room, link, received, agentId } = await setup();
    expect(link.state?.agents[agentId]?.name).toBe("w");
    await appendAsMember(server, room.roomId, room.memberToken, [draft("goal.created", { goalId: "sub", parentId: room.rootGoalId, title: "sub", description: "" })]);
    await waitFor(() => link.state?.goals.sub, "live goal event");
    expect(received.map((e) => e.type)).toEqual(["goal.created"]);
  });

  it("delivers events emitted while the server is down once it is back", async () => {
    const { server, room, store, log, link, agentId } = await setup();
    const port = server.port();
    await server.stop();
    await waitFor(() => !link.isConnected(), "link to notice the disconnect");

    link.emit([draft("agent.process_changed", { agentId, process: "running" })]);
    link.emit([draft("agent.phase_reported", { agentId, phase: "offline work" })], agentId);
    expect(store.outboxSize()).toBe(2);

    await server.start(port);
    await waitFor(() => store.outboxSize() === 0, "outbox to drain", 15_000);
    const agent = await serverAgent(server, room, agentId);
    expect(agent?.process).toBe("running");
    expect(agent?.phase?.value).toBe("offline work");
    expectDisconnectLogs(log);
  });

  it("catches up on events appended while it was disconnected", async () => {
    const { server, room, log, link } = await setup();
    const port = server.port();
    await server.stop();
    await waitFor(() => !link.isConnected(), "link to notice the disconnect");
    await server.start(port);
    // Appended before the link reconnects, so it must arrive through the resumed subscription.
    await appendAsMember(server, room.roomId, room.memberToken, [draft("goal.created", { goalId: "missed", parentId: room.rootGoalId, title: "missed", description: "" })]);
    await waitFor(() => link.state?.goals.missed, "missed event after reconnect", 15_000);
    expectDisconnectLogs(log);
  });

  it("drops events the server rejects and logs why", async () => {
    const { store, log, link } = await setup();
    link.emit([draft("agent.process_changed", { agentId: "no-such-agent", process: "running" })]);
    await waitFor(() => store.outboxSize() === 0, "rejected event to leave the outbox");
    expect(log.lines).toEqual([{ level: "warn", msg: expect.stringMatching(/rejected by server: unknown agent no-such-agent$/) }]);
  });
});

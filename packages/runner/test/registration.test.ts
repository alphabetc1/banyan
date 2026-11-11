import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { acquireRunnerLock, readSavedRunner, registerRunner, roomDir } from "../src/registration.ts";
import { createFork, createRoom, tempDir, TestServer } from "./helpers.ts";

describe("runner registration", () => {
  let server: TestServer;
  const previousHome = process.env.BANYAN_HOME;

  beforeEach(async () => {
    process.env.BANYAN_HOME = tempDir("home");
    server = new TestServer();
    await server.start();
  });

  afterEach(async () => {
    await server.stop();
    if (previousHome === undefined) delete process.env.BANYAN_HOME;
    else process.env.BANYAN_HOME = previousHome;
  });

  it("registers a runner, saves its credentials privately and reads them back", async () => {
    const room = await createRoom(server, createFork());
    const saved = await registerRunner({ serverUrl: server.base, roomId: room.roomId, memberToken: room.memberToken, hostname: "laptop" });
    expect(readSavedRunner(room.roomId)).toEqual(saved);
    expect(statSync(join(roomDir(room.roomId), "runner.json")).mode & 0o777).toBe(0o600);
    const state = await server.state(room.roomId, room.memberToken);
    expect(state.runners[saved.runnerId]).toMatchObject({ memberId: room.memberId, hostname: "laptop" });
  });

  it("rejects registration with a bad member token", async () => {
    const room = await createRoom(server, createFork());
    await expect(registerRunner({ serverUrl: server.base, roomId: room.roomId, memberToken: "wrong", hostname: "laptop" })).rejects.toThrow(
      /registration failed with 401/,
    );
    expect(readSavedRunner(room.roomId)).toBeNull();
  });
});

describe("runner lock", () => {
  it("allows one runner per room and frees the lock on release", () => {
    const dir = tempDir("lock");
    const release = acquireRunnerLock(dir);
    expect(readFileSync(join(dir, "runner.lock"), "utf8")).toBe(String(process.pid));
    expect(() => acquireRunnerLock(dir)).toThrow(`another runner (pid ${process.pid}) is already running for this room`);
    release();
    expect(existsSync(join(dir, "runner.lock"))).toBe(false);
    acquireRunnerLock(dir)();
  });

  it("takes over a lock left by a process that has exited", () => {
    const dir = tempDir("lock");
    const exited = spawnSync(process.execPath, ["-e", "process.exit(0)"]);
    writeFileSync(join(dir, "runner.lock"), String(exited.pid));
    const release = acquireRunnerLock(dir);
    expect(readFileSync(join(dir, "runner.lock"), "utf8")).toBe(String(process.pid));
    release();
  });

  it("does not remove a lock that another process has taken over", () => {
    const dir = tempDir("lock");
    const release = acquireRunnerLock(dir);
    writeFileSync(join(dir, "runner.lock"), "1");
    release();
    expect(readFileSync(join(dir, "runner.lock"), "utf8")).toBe("1");
  });
});

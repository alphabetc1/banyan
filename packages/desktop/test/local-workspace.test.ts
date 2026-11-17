import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ensureLocalWorkspace, startLocalServer, type LocalServer } from "../src/local-workspace.ts";

const names = { room: "Local", goal: "Local work", owner: "rhett" };
let server: LocalServer;

afterEach(async () => {
  await server.close();
});

async function start(): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), "banyan-local-"));
  server = await startLocalServer({ dataDir: dir, webDir: dir, port: 0 });
  return server.url;
}

async function room(url: string, roomId: string, token: string) {
  const res = await fetch(`${url}/api/rooms/${roomId}/state`, { headers: { authorization: `Bearer ${token}` } });
  return ((await res.json()) as { state: { room: { name: string; personal: boolean } } }).state.room;
}

describe("local workspace", () => {
  it("creates a personal workspace once and reuses it", async () => {
    const url = await start();
    const created = await ensureLocalWorkspace(url, null, names);
    expect(await room(url, created.roomId, created.memberToken)).toMatchObject({ name: "Local", personal: true });
    expect(await ensureLocalWorkspace(url, created, names)).toEqual(created);
  });

  it("replaces a saved workspace that is not personal or whose credentials no longer work", async () => {
    const url = await start();
    const res = await fetch(`${url}/api/rooms`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "Local", goalTitle: "g", ownerName: "rhett" }) });
    const old = (await res.json()) as { roomId: string; memberId: string; memberToken: string };
    const replaced = await ensureLocalWorkspace(url, { ...old, roomName: "Local" }, names);
    expect(replaced.roomId).not.toBe(old.roomId);
    expect((await room(url, replaced.roomId, replaced.memberToken)).personal).toBe(true);
    const stale = await ensureLocalWorkspace(url, { ...replaced, memberToken: "revoked" }, names);
    expect(stale.roomId).not.toBe(replaced.roomId);
  });
});

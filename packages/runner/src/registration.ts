// Runner registration and the per-room runner lock, shared by the CLI and the desktop client.
// Runner credentials are stored in $BANYAN_HOME/rooms/<roomId>/runner.json (default ~/.banyan).
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface SavedRunner {
  serverUrl: string;
  roomId: string;
  runnerId: string;
  runnerToken: string;
}

export function roomDir(roomId: string): string {
  return join(process.env.BANYAN_HOME ?? join(homedir(), ".banyan"), "rooms", roomId);
}

export async function registerRunner(opts: { serverUrl: string; roomId: string; memberToken: string; hostname: string }): Promise<SavedRunner> {
  const res = await fetch(`${opts.serverUrl}/api/rooms/${opts.roomId}/runners`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${opts.memberToken}` },
    body: JSON.stringify({ hostname: opts.hostname }),
  });
  if (!res.ok) throw new Error(`registration failed with ${res.status}: ${await res.text()}`);
  const { runnerId, runnerToken } = (await res.json()) as { runnerId: string; runnerToken: string };
  const dir = roomDir(opts.roomId);
  mkdirSync(dir, { recursive: true });
  const saved: SavedRunner = { serverUrl: opts.serverUrl, roomId: opts.roomId, runnerId, runnerToken };
  writeFileSync(join(dir, "runner.json"), JSON.stringify(saved, null, 2), { mode: 0o600 });
  return saved;
}

export function readSavedRunner(roomId: string): SavedRunner | null {
  const path = join(roomDir(roomId), "runner.json");
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, "utf8")) as SavedRunner;
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // EPERM means the process exists but belongs to someone else.
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

// Ensures one runner per room on this machine, whichever way it was started. A lock whose
// pid is gone is stale and taken over. Returns a function that releases the lock.
export function acquireRunnerLock(dir: string): () => void {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "runner.lock");
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      writeFileSync(path, String(process.pid), { flag: "wx" });
      return () => {
        if (existsSync(path) && readFileSync(path, "utf8") === String(process.pid)) unlinkSync(path);
      };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      const holder = Number(readFileSync(path, "utf8"));
      if (holder && pidAlive(holder)) throw new Error(`another runner (pid ${holder}) is already running for this room`);
      unlinkSync(path);
    }
  }
  throw new Error(`cannot acquire runner lock at ${path}`);
}

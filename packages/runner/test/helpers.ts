// Shared fixtures: a real room server on a temp SQLite file and a real local git "fork".
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { newId, type AppendResult, type EventDraft, type RoomState, type ServerMessage } from "@banyan/shared";
import { buildApp } from "@banyan/server/app";

export function tempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), `banyan-${prefix}-`));
}

export { draft } from "@banyan/shared";

// A bare repository with one commit on main, standing in for the room's fork. `files` maps
// extra paths in the repository to their contents.
export function createFork(files: Record<string, string> = {}): string {
  const root = tempDir("fork");
  const bare = join(root, "fork.git");
  const seed = join(root, "seed");
  execFileSync("git", ["init", "--bare", "-b", "main", bare], { stdio: "pipe" });
  mkdirSync(seed);
  execFileSync("git", ["init", "-b", "main"], { cwd: seed, stdio: "pipe" });
  writeFileSync(join(seed, "README.md"), "seed\n");
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(seed, path)), { recursive: true });
    writeFileSync(join(seed, path), content);
  }
  execFileSync("git", ["add", "."], { cwd: seed, stdio: "pipe" });
  execFileSync("git", ["-c", "user.name=banyan", "-c", "user.email=banyan@example.com", "commit", "-m", "seed"], { cwd: seed, stdio: "pipe" });
  execFileSync("git", ["push", bare, "main"], { cwd: seed, stdio: "pipe" });
  return bare;
}

export class TestServer {
  app!: Awaited<ReturnType<typeof buildApp>>;
  base = "";
  constructor(
    readonly dbPath = join(tempDir("server"), "banyan.sqlite"),
    // Built web UI to serve, for tests that drive the UI.
    readonly webDir?: string,
  ) {}

  async start(port = 0): Promise<void> {
    this.app = await buildApp({ dbPath: this.dbPath, ...(this.webDir ? { webDir: this.webDir } : {}) });
    this.base = await this.app.listen({ host: "127.0.0.1", port });
  }

  port(): number {
    return Number(new URL(this.base).port);
  }

  async stop(): Promise<void> {
    await this.app.close();
  }

  async post(path: string, body: unknown, token?: string): Promise<any> {
    const res = await fetch(`${this.base}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`${path} failed: ${res.status} ${await res.text()}`);
    return res.json();
  }

  async state(roomId: string, token: string): Promise<RoomState> {
    const res = await fetch(`${this.base}/api/rooms/${roomId}/state`, { headers: { authorization: `Bearer ${token}` } });
    return ((await res.json()) as { state: RoomState }).state;
  }
}

export interface RoomFixture {
  roomId: string;
  memberId: string;
  memberToken: string;
  runnerId: string;
  runnerToken: string;
  rootGoalId: string;
}

// A null repoUrl makes a room without a shared fork, like a local workspace.
export async function createRoom(server: TestServer, repoUrl: string | null): Promise<RoomFixture> {
  const repo = repoUrl === null ? {} : { repoUrl, baseBranch: "main" };
  const room = await server.post("/api/rooms", { name: "test room", ...repo, goalTitle: "Make the demo better", ownerName: "Rhett" });
  const runner = await server.post(`/api/rooms/${room.roomId}/runners`, { hostname: "test" }, room.memberToken);
  const state = await server.state(room.roomId, room.memberToken);
  return { roomId: room.roomId, memberId: room.memberId, memberToken: room.memberToken, runnerId: runner.runnerId, runnerToken: runner.runnerToken, rootGoalId: state.room!.rootGoalId };
}

// Appends drafts as a member over a short-lived WebSocket connection.
export async function appendAsMember(server: TestServer, roomId: string, token: string, drafts: EventDraft[]): Promise<AppendResult[]> {
  const ws = new WebSocket(`${server.base.replace("http", "ws")}/api/rooms/${roomId}/ws?token=${encodeURIComponent(token)}`);
  await new Promise<void>((resolve, reject) => {
    ws.addEventListener("open", () => resolve(), { once: true });
    ws.addEventListener("error", () => reject(new Error("websocket error")), { once: true });
  });
  const requestId = newId();
  const results = await new Promise<AppendResult[]>((resolve) => {
    ws.addEventListener("message", (e) => {
      const msg = JSON.parse(String(e.data)) as ServerMessage;
      if (msg.type === "append_result" && msg.requestId === requestId) resolve(msg.results);
    });
    ws.send(JSON.stringify({ type: "append", requestId, drafts }));
  });
  ws.close();
  return results;
}

export async function waitFor<T>(probe: () => T | Promise<T>, what: string, timeoutMs = 10_000, intervalMs = 50): Promise<NonNullable<T>> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value) return value as NonNullable<T>;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

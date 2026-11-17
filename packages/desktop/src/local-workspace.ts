// The local workspace: a room server inside the client, listening on this machine only, with
// one room created on first launch. It lets the client work like a single-user tool, with
// team rooms on a shared server as an extra.
import { buildApp } from "@banyan/server/app";
import { join } from "node:path";

export interface LocalWorkspace {
  roomId: string;
  roomName: string;
  memberId: string;
  memberToken: string;
}

export interface LocalServer {
  url: string;
  close(): Promise<void>;
}

// The port stays the same across launches because the UI keeps its credentials per origin.
export async function startLocalServer(opts: { dataDir: string; webDir: string; port: number }): Promise<LocalServer> {
  const app = await buildApp({ dbPath: join(opts.dataDir, "local.sqlite"), webDir: opts.webDir });
  const url = await app.listen({ host: "127.0.0.1", port: opts.port });
  return { url, close: () => app.close() };
}

// Reuses the saved workspace while its credentials still work, and creates it otherwise.
export async function ensureLocalWorkspace(serverUrl: string, saved: LocalWorkspace | null, names: { room: string; goal: string; owner: string }): Promise<LocalWorkspace> {
  if (saved) {
    const res = await fetch(`${serverUrl}/api/rooms/${saved.roomId}/state`, { headers: { authorization: `Bearer ${saved.memberToken}` } });
    if (res.ok) return saved;
  }
  const res = await fetch(`${serverUrl}/api/rooms`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: names.room, goalTitle: names.goal, ownerName: names.owner }),
  });
  if (!res.ok) throw new Error(`cannot create the local workspace: ${res.status} ${await res.text()}`);
  const created = (await res.json()) as { roomId: string; memberId: string; memberToken: string };
  return { roomId: created.roomId, roomName: names.room, memberId: created.memberId, memberToken: created.memberToken };
}

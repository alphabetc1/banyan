// HTTP calls to the room server. `base` is empty in the browser (same origin) and set in tests.
import type { RoomEvent, RoomState } from "@banyan/shared";

export class ApiError extends Error {}

async function request<T>(base: string, path: string, init: RequestInit & { token?: string } = {}): Promise<T> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (init.token) headers.authorization = `Bearer ${init.token}`;
  const res = await fetch(`${base}${path}`, { ...init, headers });
  const body = (await res.json().catch(() => ({}))) as { error?: string };
  if (!res.ok) throw new ApiError(body.error ?? `request failed with ${res.status}`);
  return body as T;
}

export interface CreateRoomInput {
  name: string;
  repoUrl: string;
  baseBranch: string;
  goalTitle: string;
  goalDescription: string;
  ownerName: string;
}

export function createRoom(base: string, input: CreateRoomInput) {
  return request<{ roomId: string; memberId: string; memberToken: string; inviteToken: string }>(base, "/api/rooms", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export function joinRoom(base: string, roomId: string, inviteToken: string, displayName: string) {
  return request<{ memberId: string; memberToken: string }>(base, `/api/rooms/${roomId}/join`, {
    method: "POST",
    body: JSON.stringify({ inviteToken, displayName }),
  });
}

export function createInvite(base: string, roomId: string, token: string) {
  return request<{ inviteToken: string }>(base, `/api/rooms/${roomId}/invites`, { method: "POST", body: "{}", token });
}

export function fetchState(base: string, roomId: string, token: string) {
  return request<{ state: RoomState }>(base, `/api/rooms/${roomId}/state`, { token });
}

export const TRANSCRIPT_PAGE_SIZE = 100;

// Newest-first page of transcript events older than beforeSeq.
export function fetchTranscript(base: string, roomId: string, agentId: string, token: string, beforeSeq?: number) {
  const query = new URLSearchParams({ limit: String(TRANSCRIPT_PAGE_SIZE), ...(beforeSeq ? { beforeSeq: String(beforeSeq) } : {}) });
  return request<{ events: RoomEvent[] }>(base, `/api/rooms/${roomId}/agents/${agentId}/transcript?${query}`, { token });
}

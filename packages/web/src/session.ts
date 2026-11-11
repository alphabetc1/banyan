// Member credentials per room, kept in this browser only (the server is reachable only on
// the intranet). Storage can be unavailable, in which case the in-memory copy is used.
export interface RoomCredentials {
  roomId: string;
  roomName: string;
  memberId: string;
  memberToken: string;
  // Present only for the member who created the room, so they can share it right away.
  inviteToken?: string;
}

const KEY = "banyan.rooms";
let memory: RoomCredentials[] = [];

function read(): RoomCredentials[] {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) memory = JSON.parse(raw) as RoomCredentials[];
  } catch {
    // Fall back to the in-memory list.
  }
  return memory;
}

function write(list: RoomCredentials[]): void {
  memory = list;
  try {
    localStorage.setItem(KEY, JSON.stringify(list));
  } catch {
    // Kept for this page view only.
  }
}

export function savedRooms(): RoomCredentials[] {
  return read();
}

export function roomCredentials(roomId: string): RoomCredentials | undefined {
  return read().find((r) => r.roomId === roomId);
}

export function saveRoom(creds: RoomCredentials): void {
  write([creds, ...read().filter((r) => r.roomId !== creds.roomId)]);
}

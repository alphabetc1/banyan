// SQLite persistence: the append-only event log and hashed access tokens.
import Database from "better-sqlite3";
import { createHash, randomBytes } from "node:crypto";
import type { Actor, EventDraft, RoomEvent } from "@banyan/shared";

export type TokenKind = "invite" | "member" | "runner";

export interface TokenGrant {
  kind: TokenKind;
  roomId: string;
  // Member id for member tokens, runner id for runner tokens, inviter's member id for invites.
  subjectId: string;
}

interface EventRow {
  seq: number;
  event_id: string;
  room_id: string;
  ts: number;
  actor: string;
  type: string;
  payload: string;
}

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function rowToEvent(row: EventRow): RoomEvent {
  return {
    seq: row.seq,
    eventId: row.event_id,
    roomId: row.room_id,
    ts: row.ts,
    actor: JSON.parse(row.actor) as Actor,
    type: row.type,
    payload: JSON.parse(row.payload),
  } as RoomEvent;
}

export class Store {
  private db: Database.Database;

  constructor(path: string) {
    this.db = new Database(path);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("synchronous = NORMAL");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS events (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        event_id TEXT NOT NULL UNIQUE,
        room_id TEXT NOT NULL,
        ts INTEGER NOT NULL,
        actor TEXT NOT NULL,
        type TEXT NOT NULL,
        agent_id TEXT,
        payload TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS events_room_seq ON events (room_id, seq);
      CREATE INDEX IF NOT EXISTS events_transcript ON events (room_id, agent_id, seq) WHERE type = 'transcript.appended';
      CREATE TABLE IF NOT EXISTS tokens (
        token_hash TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        room_id TEXT NOT NULL,
        subject_id TEXT NOT NULL,
        expires_at INTEGER
      );
    `);
  }

  close(): void {
    this.db.close();
  }

  findEventSeq(eventId: string): { seq: number; roomId: string } | null {
    const row = this.db.prepare("SELECT seq, room_id FROM events WHERE event_id = ?").get(eventId) as { seq: number; room_id: string } | undefined;
    return row ? { seq: row.seq, roomId: row.room_id } : null;
  }

  append(roomId: string, actor: Actor, draft: EventDraft, ts: number): RoomEvent {
    const agentId = draft.type === "transcript.appended" ? draft.payload.agentId : null;
    const info = this.db
      .prepare("INSERT INTO events (event_id, room_id, ts, actor, type, agent_id, payload) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(draft.eventId, roomId, ts, JSON.stringify(actor), draft.type, agentId, JSON.stringify(draft.payload));
    return { ...draft, seq: Number(info.lastInsertRowid), roomId, ts, actor } as RoomEvent;
  }

  eventsAfter(roomId: string, afterSeq: number, opts: { includeTranscript: boolean; limit: number }): RoomEvent[] {
    const sql = opts.includeTranscript
      ? "SELECT * FROM events WHERE room_id = ? AND seq > ? ORDER BY seq LIMIT ?"
      : "SELECT * FROM events WHERE room_id = ? AND seq > ? AND type != 'transcript.appended' ORDER BY seq LIMIT ?";
    return (this.db.prepare(sql).all(roomId, afterSeq, opts.limit) as EventRow[]).map(rowToEvent);
  }

  // Newest-first page of transcript events for one agent, strictly older than beforeSeq.
  transcriptBefore(roomId: string, agentId: string, beforeSeq: number, limit: number): RoomEvent[] {
    const rows = this.db
      .prepare(
        "SELECT * FROM events WHERE room_id = ? AND agent_id = ? AND type = 'transcript.appended' AND seq < ? ORDER BY seq DESC LIMIT ?",
      )
      .all(roomId, agentId, beforeSeq, limit) as EventRow[];
    return rows.map(rowToEvent);
  }

  issueToken(grant: TokenGrant, expiresAt: number | null): string {
    const token = randomBytes(32).toString("base64url");
    this.db
      .prepare("INSERT INTO tokens (token_hash, kind, room_id, subject_id, expires_at) VALUES (?, ?, ?, ?, ?)")
      .run(hashToken(token), grant.kind, grant.roomId, grant.subjectId, expiresAt);
    return token;
  }

  verifyToken(token: string, now: number): TokenGrant | null {
    const row = this.db.prepare("SELECT kind, room_id, subject_id, expires_at FROM tokens WHERE token_hash = ?").get(hashToken(token)) as
      | { kind: TokenKind; room_id: string; subject_id: string; expires_at: number | null }
      | undefined;
    if (!row) return null;
    if (row.expires_at !== null && row.expires_at <= now) return null;
    return { kind: row.kind, roomId: row.room_id, subjectId: row.subject_id };
  }
}

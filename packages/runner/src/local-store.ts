// Runner-local SQLite: the outbox of events not yet acknowledged by the server, plus
// bookkeeping that must survive a restart even while the server is unreachable.
import Database from "better-sqlite3";
import type { EventDraft } from "@banyan/shared";

export interface OutboxItem {
  id: number;
  asAgent: string | null;
  draft: EventDraft;
}

export interface LocalWorktree {
  agentId: string;
  path: string;
  branch: string;
  baseSha: string;
}

export class LocalStore {
  private db: Database.Database;

  constructor(path: string) {
    this.db = new Database(path);
    this.db.pragma("journal_mode = WAL");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS outbox (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        event_id TEXT NOT NULL UNIQUE,
        as_agent TEXT,
        draft TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS delivered_messages (message_id TEXT PRIMARY KEY);
      CREATE TABLE IF NOT EXISTS worktrees (
        agent_id TEXT PRIMARY KEY,
        path TEXT NOT NULL,
        branch TEXT NOT NULL,
        base_sha TEXT NOT NULL
      );
    `);
  }

  close(): void {
    this.db.close();
  }

  enqueue(drafts: EventDraft[], asAgent: string | null): void {
    const insert = this.db.prepare("INSERT INTO outbox (event_id, as_agent, draft) VALUES (?, ?, ?)");
    this.db.transaction(() => {
      for (const d of drafts) insert.run(d.eventId, asAgent, JSON.stringify(d));
    })();
  }

  peekOutbox(limit: number): OutboxItem[] {
    const rows = this.db.prepare("SELECT id, as_agent, draft FROM outbox ORDER BY id LIMIT ?").all(limit) as { id: number; as_agent: string | null; draft: string }[];
    return rows.map((r) => ({ id: r.id, asAgent: r.as_agent, draft: JSON.parse(r.draft) as EventDraft }));
  }

  removeFromOutbox(eventIds: string[]): void {
    const del = this.db.prepare("DELETE FROM outbox WHERE event_id = ?");
    this.db.transaction(() => {
      for (const id of eventIds) del.run(id);
    })();
  }

  // Approval requests not yet acknowledged by the server, so absent from the projection.
  unsentApprovalRequests(): { approvalId: string; agentId: string }[] {
    return this.peekOutbox(Number.MAX_SAFE_INTEGER)
      .map((i) => i.draft)
      .filter((d) => d.type === "approval.requested")
      .map((d) => ({ approvalId: d.payload.approvalId, agentId: d.payload.agentId }));
  }

  outboxSize(): number {
    return this.db.prepare("SELECT COUNT(*) FROM outbox").pluck().get() as number;
  }

  markDelivered(messageId: string): void {
    this.db.prepare("INSERT OR IGNORE INTO delivered_messages (message_id) VALUES (?)").run(messageId);
  }

  isDelivered(messageId: string): boolean {
    return this.db.prepare("SELECT 1 FROM delivered_messages WHERE message_id = ?").get(messageId) !== undefined;
  }

  saveWorktree(wt: LocalWorktree): void {
    this.db.prepare("INSERT OR REPLACE INTO worktrees (agent_id, path, branch, base_sha) VALUES (?, ?, ?, ?)").run(wt.agentId, wt.path, wt.branch, wt.baseSha);
  }

  worktree(agentId: string): LocalWorktree | null {
    const row = this.db.prepare("SELECT agent_id, path, branch, base_sha FROM worktrees WHERE agent_id = ?").get(agentId) as
      | { agent_id: string; path: string; branch: string; base_sha: string }
      | undefined;
    return row ? { agentId: row.agent_id, path: row.path, branch: row.branch, baseSha: row.base_sha } : null;
  }
}

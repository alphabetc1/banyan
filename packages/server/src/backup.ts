// Online backups of the event log. Uses SQLite's backup API, so it is safe to run while the
// server is writing; old backups beyond `keep` are removed, newest kept.
import Database from "better-sqlite3";
import { mkdirSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";

const PREFIX = "banyan-";
const SUFFIX = ".sqlite";

export async function backupDatabase(dbPath: string, backupDir: string, keep: number, now: Date = new Date()): Promise<{ path: string; removed: string[] }> {
  // Pruning with keep < 1 would delete the backup just written.
  if (!Number.isInteger(keep) || keep < 1) throw new Error(`keep must be an integer of at least 1, got ${keep}`);
  // Open read-only and require the file, so a wrong path fails instead of creating an empty
  // database whose empty copies would gradually replace every real backup.
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  mkdirSync(backupDir, { recursive: true });
  const stamp = now.toISOString().replace(/[:.]/g, "-");
  const path = join(backupDir, `${PREFIX}${stamp}${SUFFIX}`);
  try {
    await db.backup(path);
  } finally {
    db.close();
  }
  // ISO timestamps sort chronologically as strings.
  const backups = readdirSync(backupDir)
    .filter((f) => f.startsWith(PREFIX) && f.endsWith(SUFFIX))
    .sort();
  const removed = backups.slice(0, Math.max(0, backups.length - keep)).map((f) => join(backupDir, f));
  for (const f of removed) rmSync(f);
  return { path, removed };
}

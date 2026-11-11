// Daily backup of the room server database: an online SQLite copy plus pruning of old copies.
//   BANYAN_DB=<db> BANYAN_BACKUP_DIR=<dir> [BANYAN_BACKUP_KEEP=14] tsx scripts/backup.ts
import { backupDatabase } from "../src/backup.ts";

const db = process.env.BANYAN_DB;
const dir = process.env.BANYAN_BACKUP_DIR;
if (!db || !dir) {
  console.error("BANYAN_DB and BANYAN_BACKUP_DIR are required");
  process.exit(2);
}
const keep = Number(process.env.BANYAN_BACKUP_KEEP ?? "14");
const result = await backupDatabase(db, dir, keep);
console.log(`backup written to ${result.path}; removed ${result.removed.length} old backup(s)`);

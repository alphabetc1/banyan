import { existsSync, readdirSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { draft, newId } from "@banyan/shared";
import { backupDatabase } from "../src/backup.ts";
import { Rooms } from "../src/rooms.ts";
import { Store } from "../src/store.ts";

describe("backupDatabase", () => {
  it("copies the live database and keeps only the newest backups", async () => {
    const dir = mkdtempSync(join(tmpdir(), "banyan-backup-test-"));
    const dbPath = join(dir, "banyan.sqlite");
    const backupDir = join(dir, "backups");
    // The server keeps its connection open while backups run.
    const live = new Store(dbPath);
    const roomId = newId();
    new Rooms(live).append(roomId, { kind: "system" }, [
      draft("room.created", { name: "r", repoUrl: "u", baseBranch: "main", rootGoalId: "g", rootGoalTitle: "t", rootGoalDescription: "" }),
    ]);

    const paths: string[] = [];
    for (let day = 1; day <= 4; day++) {
      const { path, removed } = await backupDatabase(dbPath, backupDir, 3, new Date(`2026-11-0${day}T03:30:00Z`));
      paths.push(path);
      expect(removed).toEqual(day === 4 ? [paths[0]] : []);
    }
    expect(readdirSync(backupDir).sort()).toEqual(paths.slice(1).map((p) => p.split("/").pop()).sort());

    const restored = new Store(paths[3]!);
    expect(restored.eventsAfter(roomId, 0, { includeTranscript: true, limit: 10 }).map((e) => e.type)).toEqual(["room.created"]);
    restored.close();
    live.close();
  });

  it("fails on a missing database instead of creating an empty one", async () => {
    const dir = mkdtempSync(join(tmpdir(), "banyan-backup-test-"));
    const missing = join(dir, "typo.sqlite");
    await expect(backupDatabase(missing, join(dir, "backups"), 3)).rejects.toThrow();
    expect(existsSync(missing)).toBe(false);
    expect(existsSync(join(dir, "backups"))).toBe(false);
  });

  it("rejects a keep count that would delete the new backup or never prune", async () => {
    const dir = mkdtempSync(join(tmpdir(), "banyan-backup-test-"));
    const dbPath = join(dir, "banyan.sqlite");
    new Store(dbPath).close();
    for (const keep of [0, -1, Number.NaN, 2.5]) {
      await expect(backupDatabase(dbPath, join(dir, "backups"), keep)).rejects.toThrow(`keep must be an integer of at least 1, got ${keep}`);
    }
    expect(existsSync(join(dir, "backups"))).toBe(false);
  });
});

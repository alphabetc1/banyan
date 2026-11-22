import { execFileSync } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { metricValue, verifyResult } from "../src/verify.ts";
import { createWorktree, ensureClone, git } from "../src/worktree.ts";
import { createFork, tempDir } from "./helpers.ts";

const COMMIT = ["-c", "user.name=agent", "-c", "user.email=agent@example.com", "commit", "-q"];

// A worktree with a committed benchmark script that prints its result last.
async function setup() {
  const repoDir = join(tempDir("verify-room"), "repo");
  await ensureClone(createFork(), repoDir);
  const wt = await createWorktree({ repoDir, path: join(tempDir("verify-wt"), "w"), baseRef: "origin/main", roomShort: "v", agentName: "w" });
  writeFileSync(join(wt.path, "bench.sh"), "echo warming up\necho 'throughput: 1234.5 tok/s'\n");
  execFileSync("git", ["add", "."], { cwd: wt.path });
  execFileSync("git", [...COMMIT, "-m", "bench"], { cwd: wt.path });
  return { wt, sha: await git(wt.path, ["rev-parse", "HEAD"]) };
}

describe("result verification", () => {
  it("reads the last number on the last line", () => {
    expect(metricValue("warming up\nthroughput: 1234.5 tok/s\n\n")).toBe(1234.5);
    expect(metricValue("p50 3 ms, p99 -1.5e2")).toBe(-150);
    expect(metricValue("12 runs\nno numbers here")).toBeNull();
    expect(metricValue("")).toBeNull();
  });

  it("runs the command on the submitted commit in a clean checkout, ignoring uncommitted changes", async () => {
    const { wt, sha } = await setup();
    // Uncommitted edits in the agent's worktree do not count.
    writeFileSync(join(wt.path, "bench.sh"), "echo 'throughput: 999999 tok/s'\n");
    const result = (await verifyResult({ repoDir: wt.path, commitSha: sha, command: "sh bench.sh && pwd >&2" }))!;
    expect(result).toMatchObject({ ok: true, value: 1234.5 });
    expect(result.log).toContain("warming up");
    // The checkout is gone afterwards.
    const checkoutDir = result.log.trim().split("\n").at(-1)!;
    expect(checkoutDir).toMatch(/banyan-verify-[^/]+\/checkout$/);
    expect(existsSync(checkoutDir)).toBe(false);
    expect(await git(wt.path, ["worktree", "list"])).not.toContain(checkoutDir);
  });

  it("explains failures: a missing commit, a failing command, no number, a timeout", async () => {
    const { wt, sha } = await setup();
    expect(await verifyResult({ repoDir: wt.path, commitSha: "0000000000000000000000000000000000000000", command: "true" })).toMatchObject({ ok: false, reason: expect.stringContaining("cannot check out 0000000") });
    expect(await verifyResult({ repoDir: wt.path, commitSha: sha, command: "echo broken >&2; exit 3" })).toEqual({ ok: false, reason: "the command exited with code 3", log: "broken\n" });
    expect(await verifyResult({ repoDir: wt.path, commitSha: sha, command: "echo done" })).toMatchObject({ ok: false, reason: "the last line of the output has no number" });
    const started = Date.now();
    expect(await verifyResult({ repoDir: wt.path, commitSha: sha, command: "sleep 30; echo 1", timeoutMs: 500 })).toMatchObject({ ok: false, reason: "the command did not finish within 0 min" });
    expect(Date.now() - started).toBeLessThan(10_000);
  });

  // A clone and a worktree, then four seconds of waiting: more than the default test budget
  // under parallel load.
  it("ends the command when aborted, with no verdict", { timeout: 15_000 }, async () => {
    const { wt, sha } = await setup();
    const marker = join(tempDir("verify-abort"), "finished");
    const abort = new AbortController();
    setTimeout(() => abort.abort(), 500);
    const started = Date.now();
    expect(await verifyResult({ repoDir: wt.path, commitSha: sha, command: `sleep 3 && touch ${marker}; echo 1`, signal: abort.signal })).toBeNull();
    expect(Date.now() - started).toBeLessThan(2500);
    await new Promise((r) => setTimeout(r, 3500));
    expect(existsSync(marker)).toBe(false);
  });
});

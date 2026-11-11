import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createWorktree, ensureClone, git, pushBranch, worktreeStatus } from "../src/worktree.ts";
import { createFork, tempDir } from "./helpers.ts";

const COMMIT = ["-c", "user.name=agent", "-c", "user.email=agent@example.com", "commit"];

async function setup() {
  const fork = createFork();
  const roomDir = tempDir("room");
  const repoDir = join(roomDir, "repo");
  await ensureClone(fork, repoDir);
  return { fork, roomDir, repoDir };
}

describe("worktrees", () => {
  it("creates worktrees on new branches and suffixes colliding names instead of reusing them", async () => {
    const { roomDir, repoDir } = await setup();
    const a = await createWorktree({ repoDir, path: join(roomDir, "wt", "a"), baseBranch: "main", roomShort: "abc123", agentName: "Prefill Worker" });
    const b = await createWorktree({ repoDir, path: join(roomDir, "wt", "b"), baseBranch: "main", roomShort: "abc123", agentName: "Prefill Worker" });
    expect(a.branch).toBe("banyan/abc123/prefill-worker");
    expect(b.branch).toBe("banyan/abc123/prefill-worker-2");
    expect(a.baseSha).toBe(await git(repoDir, ["rev-parse", "origin/main"]));
    expect(await git(a.path, ["branch", "--show-current"])).toBe(a.branch);
  });

  it("fetches instead of cloning again", async () => {
    const { fork, repoDir } = await setup();
    await ensureClone(fork, repoDir);
    expect(await git(repoDir, ["remote", "get-url", "origin"])).toBe(fork);
  });

  it("reports committed, modified and untracked changes without touching the index", async () => {
    const { roomDir, repoDir } = await setup();
    const wt = await createWorktree({ repoDir, path: join(roomDir, "wt", "a"), baseBranch: "main", roomShort: "r", agentName: "w" });
    writeFileSync(join(wt.path, "README.md"), "seed\nline two\n");
    execFileSync("git", ["add", "README.md"], { cwd: wt.path, stdio: "pipe" });
    execFileSync("git", [...COMMIT, "-m", "edit readme"], { cwd: wt.path, stdio: "pipe" });
    writeFileSync(join(wt.path, "README.md"), "changed\nline two\n");
    mkdirSync(join(wt.path, "src"));
    writeFileSync(join(wt.path, "src", "new.py"), "a\nb\nc\n");
    writeFileSync(join(wt.path, "blob.bin"), Buffer.from([0, 1, 2, 0]));

    const status = await worktreeStatus(wt.path, wt.baseSha);
    expect(status.headSha).toBe(await git(wt.path, ["rev-parse", "HEAD"]));
    expect(status.diffStat).toEqual({ files: 3, insertions: 5, deletions: 1 });
    // Untracked files stay untracked for the agent.
    expect(await git(wt.path, ["status", "--porcelain"])).toContain("?? src/");
  });

  it("pushes the branch to the fork only when it has new commits", async () => {
    const { fork, roomDir, repoDir } = await setup();
    const wt = await createWorktree({ repoDir, path: join(roomDir, "wt", "a"), baseBranch: "main", roomShort: "r", agentName: "w" });
    expect(await pushBranch(wt.path, wt.branch, wt.baseSha)).toBe("nothing_to_push");
    writeFileSync(join(wt.path, "x.txt"), "x\n");
    execFileSync("git", ["add", "x.txt"], { cwd: wt.path, stdio: "pipe" });
    execFileSync("git", [...COMMIT, "-m", "add x"], { cwd: wt.path, stdio: "pipe" });
    expect(await pushBranch(wt.path, wt.branch, wt.baseSha)).toBe("pushed");
    expect(await git(fork, ["rev-parse", wt.branch])).toBe(await git(wt.path, ["rev-parse", "HEAD"]));
  });
});

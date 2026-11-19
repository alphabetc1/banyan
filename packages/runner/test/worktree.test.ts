import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { commitAll, copyUncommittedChanges, createWorktree, ensureClone, git, pushBranch, worktreeStatus } from "../src/worktree.ts";
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
    const a = await createWorktree({ repoDir, path: join(roomDir, "wt", "a"), baseRef: "origin/main", roomShort: "abc123", agentName: "Prefill Worker" });
    const b = await createWorktree({ repoDir, path: join(roomDir, "wt", "b"), baseRef: "origin/main", roomShort: "abc123", agentName: "Prefill Worker" });
    expect(a.branch).toBe("banyan/abc123/prefill-worker");
    expect(b.branch).toBe("banyan/abc123/prefill-worker-2");
    expect(a.baseSha).toBe(await git(repoDir, ["rev-parse", "origin/main"]));
    expect(await git(a.path, ["branch", "--show-current"])).toBe(a.branch);
  });

  it("copies a worktree's uncommitted changes onto a new worktree at the same commit", async () => {
    const { roomDir, repoDir } = await setup();
    const source = await createWorktree({ repoDir, path: join(roomDir, "wt", "source"), baseRef: "origin/main", roomShort: "r", agentName: "source" });
    // Committed work, then staged, unstaged, deleted and untracked changes on top.
    writeFileSync(join(source.path, "kept.txt"), "committed\n");
    writeFileSync(join(source.path, "gone.txt"), "to delete\n");
    execFileSync("git", ["add", "-A"], { cwd: source.path, stdio: "pipe" });
    execFileSync("git", [...COMMIT, "-m", "work"], { cwd: source.path, stdio: "pipe" });
    writeFileSync(join(source.path, "kept.txt"), "committed\nstaged\n");
    execFileSync("git", ["add", "kept.txt"], { cwd: source.path, stdio: "pipe" });
    writeFileSync(join(source.path, "kept.txt"), "committed\nstaged\nunstaged\n");
    execFileSync("git", ["rm", "-q", "gone.txt"], { cwd: source.path, stdio: "pipe" });
    mkdirSync(join(source.path, "new", "deep"), { recursive: true });
    writeFileSync(join(source.path, "new", "deep", "script.sh"), "#!/bin/sh\necho hi\n", { mode: 0o755 });
    writeFileSync(join(source.path, "blob.bin"), Buffer.from([0, 1, 2, 255]));

    const head = await git(source.path, ["rev-parse", "HEAD"]);
    const fork = await createWorktree({ repoDir, path: join(roomDir, "wt", "fork"), baseRef: head, roomShort: "r", agentName: "source fork" });
    await copyUncommittedChanges(source.path, fork.path);
    expect(readFileSync(join(fork.path, "kept.txt"), "utf8")).toBe("committed\nstaged\nunstaged\n");
    expect(existsSync(join(fork.path, "gone.txt"))).toBe(false);
    expect(readFileSync(join(fork.path, "new", "deep", "script.sh"), "utf8")).toBe("#!/bin/sh\necho hi\n");
    expect(statSync(join(fork.path, "new", "deep", "script.sh")).mode & 0o777).toBe(0o755);
    expect([...readFileSync(join(fork.path, "blob.bin"))]).toEqual([0, 1, 2, 255]);
    // The source is left as it was.
    expect(readFileSync(join(source.path, "kept.txt"), "utf8")).toBe("committed\nstaged\nunstaged\n");
    expect(await git(source.path, ["diff", "--cached", "--name-only"])).toContain("kept.txt");
    // Nothing to copy is fine.
    const clean = await createWorktree({ repoDir, path: join(roomDir, "wt", "clean"), baseRef: head, roomShort: "r", agentName: "clean" });
    const again = await createWorktree({ repoDir, path: join(roomDir, "wt", "again"), baseRef: head, roomShort: "r", agentName: "again" });
    await copyUncommittedChanges(clean.path, again.path);
    expect(await git(again.path, ["status", "--porcelain"])).toBe("");
  });

  it("fetches instead of cloning again", async () => {
    const { fork, repoDir } = await setup();
    await ensureClone(fork, repoDir);
    expect(await git(repoDir, ["remote", "get-url", "origin"])).toBe(fork);
  });

  it("reports committed, modified and untracked changes without touching the index", async () => {
    const { roomDir, repoDir } = await setup();
    const wt = await createWorktree({ repoDir, path: join(roomDir, "wt", "a"), baseRef: "origin/main", roomShort: "r", agentName: "w" });
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

  it("commits all changes under the agent's identity, or reports nothing to commit", async () => {
    const { roomDir, repoDir } = await setup();
    const wt = await createWorktree({ repoDir, path: join(roomDir, "wt", "a"), baseRef: "origin/main", roomShort: "r", agentName: "Tok Worker" });
    expect(await commitAll(wt.path, "Tok Worker", "empty")).toBeNull();
    writeFileSync(join(wt.path, "a.txt"), "a\n");
    writeFileSync(join(wt.path, "README.md"), "changed\n");
    const result = await commitAll(wt.path, "Tok Worker", "feat: two files");
    expect(result).toEqual({ sha: await git(wt.path, ["rev-parse", "HEAD"]), files: 2 });
    expect(await git(wt.path, ["log", "-1", "--format=%an <%ae>"])).toBe("banyan agent Tok Worker <tok-worker@agents.banyan.local>");
    expect(await git(wt.path, ["status", "--porcelain"])).toBe("");
  });

  it("pushes the branch to the fork only when it has new commits", async () => {
    const { fork, roomDir, repoDir } = await setup();
    const wt = await createWorktree({ repoDir, path: join(roomDir, "wt", "a"), baseRef: "origin/main", roomShort: "r", agentName: "w" });
    expect(await pushBranch(wt.path, wt.branch, wt.baseSha)).toBe("nothing_to_push");
    writeFileSync(join(wt.path, "x.txt"), "x\n");
    execFileSync("git", ["add", "x.txt"], { cwd: wt.path, stdio: "pipe" });
    execFileSync("git", [...COMMIT, "-m", "add x"], { cwd: wt.path, stdio: "pipe" });
    expect(await pushBranch(wt.path, wt.branch, wt.baseSha)).toBe("pushed");
    expect(await git(fork, ["rev-parse", wt.branch])).toBe(await git(wt.path, ["rev-parse", "HEAD"]));
  });
});

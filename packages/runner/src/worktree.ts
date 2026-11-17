// Git operations for agent worktrees. Branches are never deleted or overwritten:
// name collisions get a suffix instead, so unmerged agent work is never lost.
import { execFile } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import type { DiffStat } from "@banyan/shared";

const exec = promisify(execFile);
const UNTRACKED_LINE_COUNT_MAX_BYTES = 1_000_000;

export async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await exec("git", args, { cwd, maxBuffer: 64 * 1024 * 1024 });
  return stdout.trim();
}

async function branchExists(repoDir: string, branch: string): Promise<boolean> {
  const local = await git(repoDir, ["branch", "--list", branch]);
  const remote = await git(repoDir, ["branch", "-r", "--list", `origin/${branch}`]);
  return local !== "" || remote !== "";
}

function slug(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "agent";
}

// Clones the room's repo once per runner, or fetches if it is already there.
export async function ensureClone(repoUrl: string, repoDir: string): Promise<void> {
  if (existsSync(join(repoDir, ".git"))) {
    await git(repoDir, ["fetch", "origin"]);
    return;
  }
  await exec("git", ["clone", repoUrl, repoDir]);
}

// Whether the folder is in a git repository whose HEAD has a commit to branch from.
export async function hasCommit(dir: string): Promise<boolean> {
  try {
    await git(dir, ["rev-parse", "--verify", "--quiet", "HEAD^{commit}"]);
    return true;
  } catch {
    return false;
  }
}

export interface CreatedWorktree {
  path: string;
  branch: string;
  baseSha: string;
}

export async function createWorktree(opts: {
  repoDir: string;
  path: string;
  // Commit the new branch starts from, e.g. origin/main or HEAD.
  baseRef: string;
  roomShort: string;
  agentName: string;
}): Promise<CreatedWorktree> {
  const baseSha = await git(opts.repoDir, ["rev-parse", `${opts.baseRef}^{commit}`]);
  const stem = `banyan/${opts.roomShort}/${slug(opts.agentName)}`;
  let branch = stem;
  for (let n = 2; await branchExists(opts.repoDir, branch); n++) branch = `${stem}-${n}`;
  await git(opts.repoDir, ["worktree", "add", "-b", branch, opts.path, baseSha]);
  return { path: opts.path, branch, baseSha };
}

function countLines(path: string): number {
  try {
    if (statSync(path).size > UNTRACKED_LINE_COUNT_MAX_BYTES) return 0;
    const content = readFileSync(path, "utf8");
    if (content.includes("\0")) return 0;
    return content === "" ? 0 : content.split("\n").length - (content.endsWith("\n") ? 1 : 0);
  } catch {
    return 0;
  }
}

// Diff of the working tree against the base commit, including untracked files.
// It does not touch the index, so the agent's own `git status` is unaffected.
export async function worktreeStatus(path: string, baseSha: string): Promise<{ headSha: string; diffStat: DiffStat }> {
  const headSha = await git(path, ["rev-parse", "HEAD"]);
  const numstat = await git(path, ["diff", "--numstat", baseSha]);
  const stat: DiffStat = { files: 0, insertions: 0, deletions: 0 };
  for (const line of numstat.split("\n").filter(Boolean)) {
    const [ins, del] = line.split("\t");
    stat.files += 1;
    // Binary files report "-" for both counts.
    if (ins !== "-") stat.insertions += Number(ins);
    if (del !== "-") stat.deletions += Number(del);
  }
  const untracked = await git(path, ["ls-files", "--others", "--exclude-standard"]);
  for (const file of untracked.split("\n").filter(Boolean)) {
    stat.files += 1;
    stat.insertions += countLines(join(path, file));
  }
  return { headSha, diffStat: stat };
}

// Commits everything in the worktree under the agent's name. Runs in the runner process,
// outside any agent sandbox (Codex never lets agents write .git).
export async function commitAll(path: string, agentName: string, message: string): Promise<{ sha: string; files: number } | null> {
  await git(path, ["add", "-A"]);
  const staged = await git(path, ["diff", "--cached", "--name-only"]);
  if (staged === "") return null;
  await git(path, ["-c", `user.name=banyan agent ${agentName}`, "-c", `user.email=${slug(agentName)}@agents.banyan.local`, "commit", "-q", "-m", message]);
  return { sha: await git(path, ["rev-parse", "HEAD"]), files: staged.split("\n").length };
}

// Pushes the agent branch to the fork when it has commits beyond the base.
export async function pushBranch(path: string, branch: string, baseSha: string): Promise<"pushed" | "nothing_to_push"> {
  const headSha = await git(path, ["rev-parse", "HEAD"]);
  if (headSha === baseSha) return "nothing_to_push";
  await git(path, ["push", "--set-upstream", "origin", branch]);
  return "pushed";
}

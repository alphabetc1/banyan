// Verifies a submitted result: checks out the submitted commit in a clean worktree of its own,
// runs the goal's metric command there in the person's login shell, and reads the value from
// the last number on the output's last line. Nothing the agent left uncommitted counts.
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { agentEnv } from "./agent-env.ts";
import { git } from "./worktree.ts";

const LOG_MAX_CHARS = 20_000;
export const VERIFY_TIMEOUT_MS = 60 * 60_000;

export type Verification = { ok: true; value: number; log: string } | { ok: false; reason: string; log: string };

// The last number on the last non-empty line, e.g. "throughput: 1234.5 tok/s" gives 1234.5.
export function metricValue(stdout: string): number | null {
  const line = stdout.split("\n").map((l) => l.trim()).filter(Boolean).at(-1) ?? "";
  const numbers = line.match(/[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?/g);
  const value = numbers ? Number(numbers.at(-1)) : NaN;
  return Number.isFinite(value) ? value : null;
}

function run(command: string, cwd: string, timeoutMs: number, signal: AbortSignal | undefined): Promise<{ code: number | null; timedOut: boolean; stdout: string; log: string }> {
  return new Promise((resolve) => {
    const shell = process.env.SHELL ?? "/bin/sh";
    // Its own process group, so a timeout ends everything the command started.
    const child = spawn(shell, ["-lc", command], { cwd, env: agentEnv(process.env), detached: true, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let log = "";
    const keep = (chunk: Buffer, toStdout: boolean) => {
      const text = chunk.toString("utf8");
      if (toStdout) stdout = (stdout + text).slice(-LOG_MAX_CHARS);
      log = (log + text).slice(-LOG_MAX_CHARS);
    };
    child.stdout.on("data", (c: Buffer) => keep(c, true));
    child.stderr.on("data", (c: Buffer) => keep(c, false));
    let timedOut = false;
    const end = () => {
      try {
        process.kill(-child.pid!, "SIGKILL");
      } catch {
        // Already gone.
      }
    };
    const timer = setTimeout(() => {
      timedOut = true;
      end();
    }, timeoutMs);
    signal?.addEventListener("abort", end);
    const finish = (code: number | null) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", end);
      resolve({ code, timedOut, stdout, log });
    };
    child.on("error", (e) => {
      log += `\n${e.message}`;
      finish(null);
    });
    child.on("close", (code) => finish(code));
  });
}

// An aborted verification ends its command and resolves to null: it neither passed nor failed.
export async function verifyResult(opts: { repoDir: string; commitSha: string; command: string; timeoutMs?: number; signal?: AbortSignal }): Promise<Verification | null> {
  const dir = mkdtempSync(join(tmpdir(), "banyan-verify-"));
  const checkout = join(dir, "checkout");
  try {
    try {
      await git(opts.repoDir, ["worktree", "add", "--detach", checkout, opts.commitSha]);
    } catch (e) {
      return { ok: false, reason: `cannot check out ${opts.commitSha}: ${(e as Error).message.trim()}`, log: "" };
    }
    const timeoutMs = opts.timeoutMs ?? VERIFY_TIMEOUT_MS;
    const { code, timedOut, stdout, log } = await run(opts.command, checkout, timeoutMs, opts.signal);
    if (opts.signal?.aborted) return null;
    if (timedOut) return { ok: false, reason: `the command did not finish within ${Math.round(timeoutMs / 60_000)} min`, log };
    if (code !== 0) return { ok: false, reason: `the command exited with code ${code}`, log };
    const value = metricValue(stdout);
    if (value === null) return { ok: false, reason: "the last line of the output has no number", log };
    return { ok: true, value, log };
  } finally {
    await git(opts.repoDir, ["worktree", "remove", "--force", checkout]).catch(() => {});
    rmSync(dir, { recursive: true, force: true });
  }
}

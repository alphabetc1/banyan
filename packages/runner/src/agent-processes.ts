// Agent CLI processes (claude, codex app-server) outlive a runner that is killed outright, and
// would keep working unsupervised. Each one is started in its own process group and recorded
// in <roomDir>/agent-processes, so whoever notices the runner is gone can end them: the
// desktop client right away, and the next runner start in any case.
import { execFileSync, spawn, type ChildProcessWithoutNullStreams, type SpawnOptions } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";

interface Recorded {
  pid: number;
  // Part of the command line that identifies the process, e.g. "claude --output-format".
  signature: string;
}

const TERM_GRACE_MS = 3000;

function registryPath(roomDir: string): string {
  return join(roomDir, "agent-processes");
}

function read(roomDir: string): Recorded[] {
  const path = registryPath(roomDir);
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Recorded);
}

function write(roomDir: string, list: Recorded[]): void {
  writeFileSync(registryPath(roomDir), list.map((r) => `${JSON.stringify(r)}\n`).join(""));
}

// The command line of a live process, or null if there is none with this pid.
function commandOf(pid: number): string | null {
  try {
    return execFileSync("ps", ["-o", "args=", "-p", String(pid)], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim() || null;
  } catch {
    return null;
  }
}

export class AgentProcesses {
  constructor(private readonly roomDir: string) {}

  spawn(command: string, args: string[], opts: Pick<SpawnOptions, "cwd" | "env" | "signal"> = {}): ChildProcessWithoutNullStreams {
    const child = spawn(command, args, { ...opts, stdio: "pipe", detached: true });
    const pid = child.pid;
    if (pid !== undefined) {
      write(this.roomDir, [...read(this.roomDir), { pid, signature: `${basename(command)} ${args[0] ?? ""}`.trim() }]);
      child.once("exit", () => write(this.roomDir, read(this.roomDir).filter((r) => r.pid !== pid)));
    }
    return child;
  }
}

// Ends every recorded process group whose leader still matches its record (a pid the system
// has since reused for something else is left alone), then clears the record.
export async function killLeftoverAgentProcesses(roomDir: string): Promise<number[]> {
  const groups = read(roomDir).filter((r) => commandOf(r.pid)?.includes(r.signature)).map((r) => r.pid);
  signalGroups(groups, "SIGTERM");
  // Lets the CLIs end the tool commands they started in process groups of their own.
  const deadline = Date.now() + TERM_GRACE_MS;
  while (Date.now() < deadline && groups.some((pid) => commandOf(pid) !== null)) await new Promise((r) => setTimeout(r, 100));
  signalGroups(groups, "SIGKILL");
  if (existsSync(registryPath(roomDir))) write(roomDir, []);
  return groups;
}

function signalGroups(groups: number[], signal: NodeJS.Signals): void {
  for (const pid of groups) {
    try {
      process.kill(-pid, signal);
    } catch {
      // Already gone.
    }
  }
}

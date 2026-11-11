// Owns one runner host utility process per enabled room: starts them, reports crashes without
// restarting, stops them gracefully, and keeps their output in a per-room log file.
import { createWriteStream, mkdirSync, type WriteStream } from "node:fs";
import { join } from "node:path";
import { killLeftoverAgentProcesses } from "@banyan/runner/agent-processes";
import { roomDir } from "@banyan/runner/registration";
import type { LocalRunnerState, LocalRunnerStatus } from "@banyan/shared";
import { utilityProcess, type UtilityProcess } from "electron";
import type { HostMessage, MainMessage } from "./host-protocol.ts";

// Longer than the runner's own outbox drain so a graceful stop is not cut short.
const STOP_TIMEOUT_MS = 15_000;

interface Hosted {
  proc: UtilityProcess | null;
  status: LocalRunnerStatus;
  log: WriteStream;
  logPath: string;
  stopping: boolean;
}

export class RunnerManager {
  private hosted = new Map<string, Hosted>();

  constructor(
    private readonly opts: { hostScript: string; logDir: string; env: NodeJS.ProcessEnv; onChange(runners: LocalRunnerStatus[]): void },
  ) {
    mkdirSync(opts.logDir, { recursive: true });
  }

  list(): LocalRunnerStatus[] {
    return [...this.hosted.values()].map((h) => h.status);
  }

  isRunning(roomId: string): boolean {
    return this.hosted.has(roomId);
  }

  start(roomId: string): void {
    const existing = this.hosted.get(roomId);
    if (existing && existing.status.state !== "error") return;
    existing?.log.end();
    const logPath = join(this.opts.logDir, `runner-${roomId}.log`);
    const h: Hosted = { proc: null, status: { roomId, state: "starting" }, log: createWriteStream(logPath, { flags: "a" }), logPath, stopping: false };
    this.hosted.set(roomId, h);
    this.spawn(h);
  }

  async stop(roomId: string): Promise<void> {
    const h = this.hosted.get(roomId);
    if (!h) return;
    h.stopping = true;
    const proc = h.proc;
    if (proc) {
      const exited = new Promise<void>((resolve) => proc.once("exit", () => resolve()));
      proc.postMessage({ type: "stop" } satisfies MainMessage);
      const timer = setTimeout(() => proc.kill(), STOP_TIMEOUT_MS);
      await exited;
      clearTimeout(timer);
    }
    h.log.end();
    this.hosted.delete(roomId);
    this.changed();
  }

  async stopAll(): Promise<void> {
    await Promise.all([...this.hosted.keys()].map((roomId) => this.stop(roomId)));
  }

  private spawn(h: Hosted): void {
    const { roomId } = h.status;
    const proc = utilityProcess.fork(this.opts.hostScript, [roomId], { env: this.opts.env, stdio: "pipe", serviceName: `Banyan runner ${roomId}` });
    h.proc = proc;
    proc.stdout?.pipe(h.log, { end: false });
    proc.stderr?.pipe(h.log, { end: false });
    proc.on("message", (msg: HostMessage) => {
      this.setState(h, msg.type === "running" ? "running" : "error", msg.type === "failed" ? msg.error : undefined);
    });
    proc.once("exit", (code) => {
      h.proc = null;
      if (h.stopping || h.status.state === "error") return;
      const error = `runner exited unexpectedly (code ${code}); log: ${h.logPath}`;
      this.setState(h, "error", error);
      // Its agents must not keep working unsupervised. The runner stays stopped; starting it
      // again resumes them with their history.
      void killLeftoverAgentProcesses(roomDir(roomId)).then((ended) => h.log.write(`[banyan-desktop] ${error}; ended agent process(es): ${ended.join(", ") || "none"}\n`));
    });
  }

  private setState(h: Hosted, state: LocalRunnerState, error?: string): void {
    h.status = { roomId: h.status.roomId, state, ...(error ? { error } : {}) };
    this.changed();
  }

  private changed(): void {
    this.opts.onChange(this.list());
  }
}

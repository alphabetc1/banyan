// Wires the runner together: local store, server link, Room MCP, providers and supervisor.
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { PermissionMode } from "@anthropic-ai/claude-agent-sdk";
import type { EventDraft } from "@banyan/shared";
import { AgentProcesses, killLeftoverAgentProcesses } from "./agent-processes.ts";
import { ServerLink } from "./link.ts";
import { LocalStore } from "./local-store.ts";
import type { Logger } from "./logger.ts";
import { TerminalProvider } from "./providers/terminal.ts";
import type { TerminalHandle } from "./providers/types.ts";
import { ClaudeProvider } from "./providers/claude.ts";
import { CodexProvider } from "./providers/codex.ts";
import { RoomMcp } from "./room-mcp.ts";
import { Supervisor } from "./supervisor.ts";

const STOP_DRAIN_MS = 5000;

export interface RunnerConfig {
  serverUrl: string;
  roomId: string;
  runnerId: string;
  runnerToken: string;
  // Per-room directory holding the local store, the repo clone and worktrees.
  roomDir: string;
  claudePermissionMode?: PermissionMode;
  monitorIntervalMs?: number;
  // Extra command-line arguments for terminal sessions, per CLI.
  terminalArgs?: TerminalArgs;
}

export interface TerminalArgs {
  claude: string[];
  codex: string[];
}

export class Runner {
  readonly store: LocalStore;
  readonly link: ServerLink;
  readonly mcp: RoomMcp;
  readonly supervisor: Supervisor;
  private providers: { claude: ClaudeProvider; codex: CodexProvider };
  private terminals: { claude: TerminalProvider; codex: TerminalProvider; shell: TerminalProvider };

  constructor(
    private readonly config: RunnerConfig,
    private readonly log: Logger,
  ) {
    mkdirSync(config.roomDir, { recursive: true });
    this.store = new LocalStore(join(config.roomDir, "runner.sqlite"));
    let supervisor: Supervisor | null = null;
    this.link = new ServerLink({
      serverUrl: config.serverUrl,
      roomId: config.roomId,
      token: config.runnerToken,
      store: this.store,
      log,
      onEvents: (events) => supervisor?.onEvents(events),
    });
    const state = () => {
      if (!this.link.state) throw new Error("room state not loaded");
      return this.link.state;
    };
    const emit = (drafts: EventDraft[], asAgent: string | null = null) => this.link.emit(drafts, asAgent);
    this.mcp = new RoomMcp({ state, emit, now: Date.now, commit: (agentId, message) => this.supervisor.commitFor(agentId, message), head: (agentId) => this.supervisor.headFor(agentId) });
    const processes = new AgentProcesses(config.roomDir);
    this.providers = { claude: new ClaudeProvider(processes, config.claudePermissionMode), codex: new CodexProvider(log, processes) };
    this.terminals = { claude: TerminalProvider.claude(processes, config.claudePermissionMode), codex: TerminalProvider.codex(processes), shell: TerminalProvider.shell(processes) };
    if (config.terminalArgs) this.setTerminalArgs(config.terminalArgs);
    supervisor = new Supervisor({
      runnerId: config.runnerId,
      roomDir: config.roomDir,
      store: this.store,
      mcp: this.mcp,
      providers: this.providers,
      terminals: this.terminals,
      log,
      state,
      emit,
      ...(config.monitorIntervalMs ? { monitorIntervalMs: config.monitorIntervalMs } : {}),
    });
    this.supervisor = supervisor;
  }

  async start(): Promise<void> {
    // Agents of a previous runner process that was killed outright must not keep working.
    const leftovers = await killLeftoverAgentProcesses(this.config.roomDir);
    if (leftovers.length > 0) this.log.warn(`ended agent process(es) left by a previous runner: ${leftovers.join(", ")}`);
    await this.mcp.start();
    await this.terminals.claude.open();
    await this.terminals.codex.open();
    await this.terminals.shell.open();
    await this.link.start();
    await this.supervisor.start();
  }

  // Applies to terminal sessions started from now on; running ones keep theirs.
  setTerminalArgs(args: TerminalArgs): void {
    this.terminals.claude.setExtraArgs(args.claude);
    this.terminals.codex.setExtraArgs(args.codex);
  }

  // The live terminal of a terminal-mode agent this runner hosts.
  terminal(agentId: string): TerminalHandle | null {
    return this.supervisor.terminal(agentId);
  }

  async stop(): Promise<void> {
    await this.supervisor.close();
    // Let the final lifecycle events (exited, expired approvals) reach the server.
    await this.link.drain(STOP_DRAIN_MS);
    await this.providers.claude.close();
    await this.providers.codex.close();
    await this.terminals.claude.close();
    await this.terminals.codex.close();
    await this.terminals.shell.close();
    await this.mcp.close();
    this.link.close();
    this.store.close();
  }
}

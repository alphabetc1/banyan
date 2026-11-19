// Supervisor: starts, resumes and watches the agents assigned to this runner, translating
// provider callbacks into room events and room events into agent input.
import { join } from "node:path";
import { existsSync, mkdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { agentGroup, draft, isPlainAgent, newId, postReviewers, type Agent, type EventDraft, type RoomEvent, type RoomState, type TranscriptEntry } from "@banyan/shared";
import type { LocalStore } from "./local-store.ts";
import type { Logger } from "./logger.ts";
import { directiveChangedMessage, freshAfterLossMessage, kickoffMessage, MONITOR_CHECK_MESSAGE, plainFirstMessage, RESUMED_MESSAGE, reviewRequestMessage, roomMessage, systemPrompt, workerPhaseMessage } from "./prompts.ts";
import type { AgentProvider, AgentSession, TerminalHandle } from "./providers/types.ts";
import type { RoomMcp } from "./room-mcp.ts";
import { commitAll, copyUncommittedChanges, createWorktree, ensureClone, git, hasCommit, pushBranch, worktreeStatus } from "./worktree.ts";

const TRANSCRIPT_BATCH_MAX = 200;
const CRASH_RESTART_DELAY_MS = 5000;
const CRASH_RESTARTS_MAX = 3;
// Self-reported phases that should wake the group leader.
const LEADER_ALERT_PHASES = new Set(["done", "blocked"]);

export interface SupervisorOptions {
  runnerId: string;
  // Directory for the room's clone and worktrees.
  roomDir: string;
  store: LocalStore;
  mcp: RoomMcp;
  // Managed sessions; a shell only ever runs in a terminal.
  providers: Record<Exclude<Agent["provider"], "shell">, AgentProvider>;
  // Run agents created in terminal mode, per provider, when this runner has them.
  terminals?: Partial<Record<Agent["provider"], AgentProvider>>;
  log: Logger;
  state(): RoomState;
  emit(drafts: EventDraft[], asAgent?: string | null): void;
  monitorIntervalMs?: number;
}

interface Running {
  session: AgentSession;
  // False until the provider confirmed the session; failures before that are handled by launch().
  ready: boolean;
  // Resolves when the provider reports the session has ended.
  exited: Promise<void>;
  // An exit reported after `ready` resolved but before launch() registered the session.
  earlyExit: { crashed: boolean; detail: string } | null;
  activity: "working" | "idle" | "awaiting_input" | null;
  sessionId: string | null;
}

// Paths people type often start with ~ for their home directory.
function expandHome(path: string): string {
  return path === "~" || path.startsWith("~/") ? join(homedir(), path.slice(1)) : path;
}

export class Supervisor {
  private running = new Map<string, Running>();
  // Sessions whose provider has not confirmed them yet; a terminal can already need its person.
  private launching = new Map<string, Running>();
  private starting = new Map<string, Promise<void>>();
  // Approvals this process asked for that are still undecided, including ones not yet
  // echoed by the server.
  private openApprovals = new Map<string, string>();
  private approvalWaiters = new Map<string, (decision: "allowed" | "denied") => void>();
  private crashCounts = new Map<string, number>();
  private timers: NodeJS.Timeout[] = [];
  private repoReady: Promise<string> | null = null;
  private closed = false;
  // Until start() runs, it is the one that brings agents up; live creation events are ignored.
  private started = false;

  constructor(private opts: SupervisorOptions) {}

  // This runner's agents that are still in use.
  private mine(state: RoomState): Agent[] {
    return Object.values(state.agents).filter((a) => a.runnerId === this.opts.runnerId && !a.archived);
  }

  // Brings every agent of this runner up, resuming sessions recorded by a previous process.
  async start(): Promise<void> {
    const state = this.opts.state();
    // Approvals left pending by a previous process can never be answered by it, including
    // requests still sitting in the outbox.
    const stale = new Set(
      Object.values(state.approvals)
        .filter((a) => a.state === "pending" && state.agents[a.agentId]?.runnerId === this.opts.runnerId)
        .map((a) => a.id),
    );
    for (const r of this.opts.store.unsentApprovalRequests()) stale.add(r.approvalId);
    this.started = true;
    this.opts.emit([...stale].map((approvalId) => draft("approval.expired", { approvalId, reason: "runner restarted" })));
    // Agents resume in the background, each reporting its own progress, so the runner counts
    // as up once it is connected; close() waits for any that are still starting.
    for (const a of this.mine(state)) void this.ensureRunning(a.id);
    if (this.opts.monitorIntervalMs) this.timers.push(setInterval(() => this.nudgeMonitors(), this.opts.monitorIntervalMs));
  }

  // Stops every session and waits until each has reported its exit, so no callback
  // fires after the caller tears down the store and link.
  async close(): Promise<void> {
    this.closed = true;
    for (const t of this.timers) clearInterval(t);
    await Promise.all(this.starting.values());
    const runs = [...this.running.values()];
    await Promise.all(runs.map((r) => r.session.stop()));
    await Promise.all(runs.map((r) => r.exited));
  }

  onEvents(events: RoomEvent[]): void {
    const state = this.opts.state();
    for (const e of events) {
      if (e.type === "agent.created" && e.payload.runnerId === this.opts.runnerId && this.started) {
        void this.ensureRunning(e.payload.agentId);
      } else if (e.type === "agent.archived" && state.agents[e.payload.agentId]?.runnerId === this.opts.runnerId) {
        void this.running.get(e.payload.agentId)?.session.stop();
      } else if (e.type === "agent.restart_requested" && state.agents[e.payload.agentId]?.runnerId === this.opts.runnerId && this.started) {
        // A person asked, so earlier crashes no longer count against it.
        this.crashCounts.set(e.payload.agentId, 0);
        void this.ensureRunning(e.payload.agentId);
      } else if (e.type === "message.sent") {
        this.deliverMessage(state, e.payload.messageId);
      } else if (e.type === "approval.decided") {
        this.approvalWaiters.get(e.payload.approvalId)?.(e.payload.decision);
        this.approvalWaiters.delete(e.payload.approvalId);
        this.openApprovals.delete(e.payload.approvalId);
      } else if (e.type === "post.created" && e.payload.proposeRoomVisible) {
        this.notifyReviewers(state, e.payload.postId);
      } else if (e.type === "memory.recorded" || e.type === "memory.updated" || e.type === "memory.retired") {
        this.notifyDirectiveChange(state, e.payload.entryId, e.type === "memory.recorded" ? "added" : e.type === "memory.updated" ? "changed" : "retired");
      } else if (e.type === "agent.phase_reported" && LEADER_ALERT_PHASES.has(e.payload.phase)) {
        this.notifyLeader(state, e.payload.agentId, e.payload.phase, e.payload.note ?? null);
      }
    }
  }

  private repo(): Promise<string> {
    if (!this.repoReady) {
      const room = this.opts.state().room;
      if (!room) throw new Error("room state not loaded");
      if (!room.repoUrl) throw new Error("this room has no shared repository; give the agent a repository on its runner's machine");
      const repoUrl = room.repoUrl;
      const repoDir = join(this.opts.roomDir, "repo");
      mkdirSync(this.opts.roomDir, { recursive: true });
      this.repoReady = ensureClone(repoUrl, repoDir).then(() => repoDir);
      this.repoReady.catch(() => {
        this.repoReady = null;
      });
    }
    return this.repoReady;
  }

  // Workers get their own worktree, in their local repository if they have one and in the
  // room's fork otherwise; leaders and monitors read the repository itself.
  // A local folder that is not a git repository with a commit to branch from is used as it
  // is, without a worktree of its own.
  private async workingDirectory(agent: Agent): Promise<string> {
    const repoDir = agent.repoPath ? expandHome(agent.repoPath) : await this.repo();
    if (agent.repoPath) {
      if (!existsSync(repoDir) || !statSync(repoDir).isDirectory()) throw new Error(`no such folder: ${repoDir}`);
      if (!(await hasCommit(repoDir))) return repoDir;
    }
    if (agent.role !== "worker") return repoDir;
    const known = this.opts.store.worktree(agent.id);
    if (known) return known.path;
    const room = this.opts.state().room!;
    // A fork starts where its agent is now, uncommitted changes included.
    const source = agent.forkOf ? this.opts.store.worktree(agent.forkOf) : undefined;
    const wt = await createWorktree({
      repoDir,
      path: join(this.opts.roomDir, "worktrees", agent.id),
      // A local repository starts from whatever is checked out there.
      baseRef: source ? await git(source.path, ["rev-parse", "HEAD"]) : agent.repoPath ? "HEAD" : `origin/${room.baseBranch}`,
      roomShort: room.id.slice(-6).toLowerCase(),
      agentName: agent.name,
    });
    if (source) await copyUncommittedChanges(source.path, wt.path);
    this.opts.store.saveWorktree({ agentId: agent.id, ...wt });
    this.opts.emit([draft("worktree.created", { worktreeId: newId(), agentId: agent.id, branch: wt.branch, baseSha: wt.baseSha })]);
    return wt.path;
  }

  private providerFor(agent: Agent): AgentProvider {
    if (!agent.terminal && agent.provider !== "shell") return this.opts.providers[agent.provider];
    const terminal = this.opts.terminals?.[agent.provider];
    if (!terminal) throw new Error(`terminal mode is not available for ${agent.provider} agents on this runner`);
    return terminal;
  }

  // The live terminal of a running terminal-mode agent.
  terminal(agentId: string): TerminalHandle | null {
    return (this.running.get(agentId) ?? this.launching.get(agentId))?.session.terminal ?? null;
  }

  private ensureRunning(agentId: string): Promise<void> {
    if (this.closed || this.running.has(agentId)) return Promise.resolve();
    const inFlight = this.starting.get(agentId);
    if (inFlight) return inFlight;
    const started = this.startAgent(agentId).finally(() => this.starting.delete(agentId));
    this.starting.set(agentId, started);
    return started;
  }

  private async startAgent(agentId: string): Promise<void> {
    try {
      const agent = this.opts.state().agents[agentId];
      if (!agent || agent.archived) return;
      this.opts.emit([draft("agent.process_changed", { agentId, process: "starting", detail: "preparing workspace" })]);
      const cwd = await this.workingDirectory(agent);
      const resumeId = agent.providerSessionId;
      const state = this.opts.state();
      const plain = isPlainAgent(state, agent);
      // A fork's first session starts as a copy of its agent's, and waits for its person.
      const forkId = resumeId === null && agent.forkOf ? (state.agents[agent.forkOf]?.providerSessionId ?? null) : null;
      try {
        if (forkId) await this.launch(agent, cwd, null, null, forkId);
        else await this.launch(agent, cwd, resumeId, plain ? plainFirstMessage(agent, resumeId !== null) : resumeId ? RESUMED_MESSAGE : kickoffMessage(state, agent));
      } catch (e) {
        if (!resumeId) throw e;
        const reason = (e as Error).message;
        this.opts.log.warn(`agent ${agent.name}: resume failed (${reason}); starting a fresh session`);
        this.opts.emit([draft("agent.resumability_changed", { agentId, resumability: "lost", detail: reason })]);
        await this.launch(agent, cwd, null, plain ? plainFirstMessage(agent, false) : freshAfterLossMessage(this.opts.state(), agent, reason));
      }
    } catch (e) {
      if (this.closed) {
        // Leave no stale "starting" state behind when shutdown interrupts preparation.
        this.opts.emit([draft("agent.process_changed", { agentId, process: "exited", detail: "runner stopped while starting" })]);
        return;
      }
      const detail = (e as Error).message;
      this.opts.log.error(`agent ${agentId} failed to start: ${detail}`);
      this.opts.emit([draft("agent.process_changed", { agentId, process: "crashed", detail: `failed to start: ${detail}` })]);
    }
  }

  private async launch(agent: Agent, cwd: string, resumeSessionId: string | null, firstMessage: string | null, forkSessionId: string | null = null): Promise<void> {
    const agentId = agent.id;
    const state = this.opts.state();
    let markExited!: () => void;
    const exited = new Promise<void>((resolve) => (markExited = resolve));
    const run: Running = { session: null as unknown as AgentSession, ready: false, exited, earlyExit: null, activity: null, sessionId: null };
    const forkedFrom = agent.forkOf ? state.agents[agent.forkOf]?.name : undefined;
    const opening = resumeSessionId ? "resuming session" : forkSessionId ? `forked from ${forkedFrom ?? "another agent"}` : "starting session";
    this.appendTranscript(agentId, [{ kind: "system", text: opening, ts: Date.now() }]);
    if (firstMessage === null && !agent.terminal) throw new Error("a managed agent needs instructions to start with; add instructions or run it in a terminal");
    const provider = this.providerFor(agent);
    run.session = provider.start(
      {
        agentId,
        cwd,
        model: agent.model,
        // A plain agent is the CLI as the person would use it, without Banyan's coordination.
        systemPrompt: isPlainAgent(state, agent) ? null : systemPrompt(state, agent),
        roomMcpUrl: isPlainAgent(state, agent) ? null : this.opts.mcp.urlFor(agentId),
        resumeSessionId,
        forkSessionId,
      },
      {
        onSessionId: (id) => {
          run.sessionId = id;
          if (this.opts.state().agents[agentId]?.providerSessionId !== id) {
            this.opts.emit([draft("agent.session_bound", { agentId, providerSessionId: id })]);
          }
        },
        onActivity: (activity) => {
          if (run.activity === activity) return;
          run.activity = activity;
          this.opts.emit([draft("agent.activity_changed", { agentId, activity })]);
        },
        onTranscript: (entries) => this.appendTranscript(agentId, entries),
        requestApproval: ({ tool, input }) => {
          const approvalId = newId();
          this.openApprovals.set(approvalId, agentId);
          this.opts.emit([draft("approval.requested", { approvalId, agentId, tool, input })]);
          return new Promise((resolve) => this.approvalWaiters.set(approvalId, resolve));
        },
        onAcceptsInput: () => this.deliverPendingMessages(agentId),
        onTurnEnd: () => {
          this.crashCounts.set(agentId, 0);
          void this.syncWorktree(agentId);
        },
        onExit: ({ crashed, detail }) => {
          if (run.ready) this.onExit(agentId, run, crashed, detail);
          else run.earlyExit = { crashed, detail };
          markExited();
        },
      },
    );
    // Claude only confirms a managed session after its first user message, so queue it before
    // waiting. A terminal may start without one and wait for its person.
    if (firstMessage !== null) run.session.send(firstMessage, "steer");
    this.launching.set(agentId, run);
    try {
      await run.session.ready;
    } finally {
      this.launching.delete(agentId);
    }
    run.ready = true;
    if (this.closed) {
      // The runner began shutting down while this session was starting.
      await run.session.stop();
      return;
    }
    this.running.set(agentId, run);
    this.opts.emit([
      draft("agent.process_changed", { agentId, process: "running", detail: resumeSessionId ? "resumed" : "started" }),
      draft("agent.resumability_changed", { agentId, resumability: "live" }),
    ]);
    if (run.earlyExit) {
      this.onExit(agentId, run, run.earlyExit.crashed, run.earlyExit.detail);
      return;
    }
    this.deliverPendingMessages(agentId);
  }

  private onExit(agentId: string, run: Running, crashed: boolean, detail: string): void {
    if (this.running.get(agentId) === run) this.running.delete(agentId);
    // Pending approvals of the exited session can never be applied.
    const stale = new Set(Object.values(this.opts.state().approvals).filter((a) => a.agentId === agentId && a.state === "pending").map((a) => a.id));
    for (const [approvalId, owner] of this.openApprovals) if (owner === agentId) stale.add(approvalId);
    for (const approvalId of stale) {
      this.approvalWaiters.delete(approvalId);
      this.openApprovals.delete(approvalId);
      this.opts.emit([draft("approval.expired", { approvalId, reason: "agent session ended" })]);
    }
    this.opts.emit([
      draft("agent.process_changed", { agentId, process: crashed ? "crashed" : "exited", detail }),
      draft("agent.activity_changed", { agentId, activity: "idle" }),
      draft("agent.resumability_changed", { agentId, resumability: "resumable" }),
    ]);
    if (!crashed || this.closed) return;
    const restarts = (this.crashCounts.get(agentId) ?? 0) + 1;
    this.crashCounts.set(agentId, restarts);
    if (restarts > CRASH_RESTARTS_MAX) {
      this.opts.log.error(`agent ${agentId} crashed ${restarts} times in a row; leaving it stopped`);
      return;
    }
    this.opts.log.warn(`agent ${agentId} crashed (${detail}); restarting in ${CRASH_RESTART_DELAY_MS} ms`);
    setTimeout(() => void this.ensureRunning(agentId), CRASH_RESTART_DELAY_MS);
  }

  // Commits on behalf of an agent (Room MCP room_commit), then syncs and pushes its branch.
  async commitFor(agentId: string, message: string): Promise<{ sha: string; files: number } | null> {
    const wt = this.opts.store.worktree(agentId);
    const agent = this.opts.state().agents[agentId];
    if (!wt || !agent) throw new Error("this agent has no worktree");
    const result = await commitAll(wt.path, agent.name, message);
    if (result) void this.syncWorktree(agentId);
    return result;
  }

  private async syncWorktree(agentId: string): Promise<void> {
    const wt = this.opts.store.worktree(agentId);
    const agent = this.opts.state().agents[agentId];
    if (!wt || !agent?.worktreeId) return;
    try {
      const status = await worktreeStatus(wt.path, wt.baseSha);
      const current = this.opts.state().worktrees[agent.worktreeId];
      if (!current || current.headSha !== status.headSha || JSON.stringify(current.diffStat) !== JSON.stringify(status.diffStat)) {
        this.opts.emit([draft("worktree.updated", { worktreeId: agent.worktreeId, headSha: status.headSha, diffStat: status.diffStat })]);
      }
      // Branches in the user's own repository are theirs to push.
      if (!agent.repoPath) await pushBranch(wt.path, wt.branch, wt.baseSha);
    } catch (e) {
      const detail = (e as Error).message;
      this.opts.log.warn(`agent ${agentId}: worktree sync failed: ${detail}`);
      this.appendTranscript(agentId, [{ kind: "system", text: `worktree sync failed: ${detail}`, ts: Date.now() }]);
    }
  }

  // Written to the outbox right away, so a runner killed mid-turn loses no history.
  private appendTranscript(agentId: string, entries: TranscriptEntry[]): void {
    for (let i = 0; i < entries.length; i += TRANSCRIPT_BATCH_MAX) {
      this.opts.emit([draft("transcript.appended", { agentId, entries: entries.slice(i, i + TRANSCRIPT_BATCH_MAX) })]);
    }
  }

  private deliverMessage(state: RoomState, messageId: string): void {
    const msg = state.messages[messageId];
    if (!msg || this.opts.store.isDelivered(messageId)) return;
    const run = this.running.get(msg.toAgentId);
    // Left pending, and delivered once the session takes input again.
    if (!run || run.session.acceptsInput?.(msg.delivery) === false) return;
    const target = state.agents[msg.toAgentId];
    let text = msg.text;
    if (msg.from.kind === "agent") {
      const sender = state.agents[msg.from.id];
      text = roomMessage(`${sender?.role ?? "agent"} "${sender?.name ?? msg.from.id}"`, msg.text);
    } else if (msg.from.kind === "member" && msg.from.id !== target?.memberId) {
      text = `[Message from room member ${state.members[msg.from.id]?.displayName ?? msg.from.id}]\n${msg.text}`;
    }
    run.session.send(text, msg.delivery, true);
    this.opts.store.markDelivered(messageId);
    // Providers do not echo input back, so the transcript records what the agent was sent.
    this.appendTranscript(msg.toAgentId, [{ kind: "user", text: msg.text, ts: Date.now(), messageId }]);
  }

  private deliverPendingMessages(agentId: string): void {
    const state = this.opts.state();
    const pending = Object.values(state.messages)
      .filter((m) => m.toAgentId === agentId)
      .sort((a, b) => a.sentAt - b.sentAt);
    for (const m of pending) this.deliverMessage(state, m.id);
  }

  private notifyReviewers(state: RoomState, postId: string): void {
    const post = state.posts[postId];
    if (!post) return;
    const author = state.agents[post.agentId]?.name ?? post.agentId;
    for (const reviewerId of postReviewers(state, post)) {
      this.running.get(reviewerId)?.session.send(reviewRequestMessage(author, post.summary), "fyi");
    }
  }

  // A worker finishing or getting blocked needs its leader's attention, which no review or
  // message would otherwise trigger.
  private notifyLeader(state: RoomState, agentId: string, phase: string, note: string | null): void {
    const agent = state.agents[agentId];
    const leaderId = agent ? agentGroup(state, agent)?.leaderAgentId : null;
    if (!agent || agent.role !== "worker" || !leaderId) return;
    this.running.get(leaderId)?.session.send(workerPhaseMessage(agent.name, phase, note), "fyi");
  }

  // Running agents started with the directives of that moment; later changes reach them as a
  // note. Plain agents know nothing of the room.
  private notifyDirectiveChange(state: RoomState, entryId: string, change: "added" | "changed" | "retired"): void {
    const entry = state.memory[entryId];
    if (entry?.kind !== "directive") return;
    for (const agent of this.mine(state)) {
      if (!isPlainAgent(state, agent)) this.running.get(agent.id)?.session.send(directiveChangedMessage(change, entry), "fyi");
    }
  }

  private nudgeMonitors(): void {
    for (const agent of this.mine(this.opts.state())) {
      const run = this.running.get(agent.id);
      if (agent.role === "monitor" && run && run.activity !== "working") run.session.send(MONITOR_CHECK_MESSAGE, "fyi");
    }
  }
}

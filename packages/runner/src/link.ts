// Connection to the room server: keeps a local projection in sync over WebSocket,
// reconnects with backoff, and drains the outbox so events survive disconnects.
import WebSocket from "ws";
import { applyEvent, newId, type EventDraft, type RoomEvent, type RoomState, type ServerMessage } from "@banyan/shared";
import type { LocalStore } from "./local-store.ts";
import type { Logger } from "./logger.ts";

const OUTBOX_BATCH = 100;
const RETRY_MIN_MS = 500;
const RETRY_MAX_MS = 30_000;

export interface LinkOptions {
  serverUrl: string;
  roomId: string;
  token: string;
  store: LocalStore;
  log: Logger;
  onEvents: (events: RoomEvent[]) => void;
}

// A rejection caused by server storage is transient; every other rejection is final.
function isTransient(error: string): boolean {
  return error.startsWith("storage error");
}

export class ServerLink {
  private ws: WebSocket | null = null;
  private connected = false;
  private inflight: { requestId: string; eventIds: string[] } | null = null;
  private retryMs = RETRY_MIN_MS;
  private closed = false;
  private retryTimer: NodeJS.Timeout | null = null;
  private connectedWaiters: (() => void)[] = [];
  private everConnected = false;
  state: RoomState | null = null;

  constructor(private opts: LinkOptions) {}

  async start(): Promise<void> {
    this.connect();
    await new Promise<void>((resolve) => this.connectedWaiters.push(resolve));
  }

  close(): void {
    this.closed = true;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.ws?.close();
  }

  isConnected(): boolean {
    return this.connected;
  }

  // Persists drafts locally first, so they are delivered even if the server is down.
  emit(drafts: EventDraft[], asAgent: string | null = null): void {
    if (drafts.length === 0) return;
    this.opts.store.enqueue(drafts, asAgent);
    this.flush();
  }

  private async fetchState(): Promise<RoomState> {
    const res = await fetch(`${this.opts.serverUrl}/api/rooms/${this.opts.roomId}/state`, {
      headers: { authorization: `Bearer ${this.opts.token}` },
    });
    if (!res.ok) throw new Error(`state request failed with ${res.status}`);
    return ((await res.json()) as { state: RoomState }).state;
  }

  private scheduleReconnect(): void {
    if (this.closed) return;
    const delay = this.retryMs;
    this.retryMs = Math.min(this.retryMs * 2, RETRY_MAX_MS);
    this.retryTimer = setTimeout(() => this.connect(), delay);
  }

  private connect(): void {
    if (this.closed) return;
    void (async () => {
      try {
        // The initial snapshot avoids replaying the whole log; later reconnects resume by seq.
        if (this.state === null) this.state = await this.fetchState();
      } catch (e) {
        this.opts.log.warn(`room server unreachable: ${(e as Error).message}`);
        this.scheduleReconnect();
        return;
      }
      const url = `${this.opts.serverUrl.replace(/^http/, "ws")}/api/rooms/${this.opts.roomId}/ws?token=${encodeURIComponent(this.opts.token)}`;
      const ws = new WebSocket(url);
      this.ws = ws;
      ws.on("open", () => {
        if (this.everConnected) this.opts.log.info("reconnected to room server");
        this.everConnected = true;
        this.connected = true;
        this.retryMs = RETRY_MIN_MS;
        ws.send(JSON.stringify({ type: "subscribe", afterSeq: this.state!.lastSeq }));
        for (const w of this.connectedWaiters.splice(0)) w();
        this.flush();
      });
      ws.on("message", (raw) => this.onMessage(JSON.parse(raw.toString()) as ServerMessage));
      ws.on("error", (e) => this.opts.log.warn(`room server connection error: ${e.message}`));
      ws.on("close", () => {
        if (this.connected && !this.closed) this.opts.log.warn("room server connection lost; reconnecting");
        if (this.ws === ws) {
          this.ws = null;
          this.connected = false;
          this.inflight = null;
        }
        this.scheduleReconnect();
      });
    })();
  }

  private onMessage(msg: ServerMessage): void {
    // Messages can still arrive during the closing handshake; unacknowledged events stay
    // in the outbox and are re-sent on the next start.
    if (this.closed) return;
    if (msg.type === "events") {
      const fresh = msg.events.filter((e) => e.seq > this.state!.lastSeq);
      for (const e of fresh) applyEvent(this.state!, e);
      if (fresh.length > 0) this.opts.onEvents(fresh);
      return;
    }
    if (msg.type === "error") {
      this.opts.log.error(`room server error: ${msg.error}`);
      return;
    }
    if (!this.inflight || msg.requestId !== this.inflight.requestId) return;
    const done: string[] = [];
    let transientFailure = false;
    for (const r of msg.results) {
      if (r.ok) done.push(r.eventId);
      else if (isTransient(r.error)) transientFailure = true;
      else {
        this.opts.log.warn(`event ${r.eventId} rejected by server: ${r.error}`);
        done.push(r.eventId);
      }
    }
    this.opts.store.removeFromOutbox(done);
    this.inflight = null;
    if (transientFailure) {
      this.retryTimer = setTimeout(() => this.flush(), this.retryMs);
      return;
    }
    this.flush();
  }

  // Sends the oldest run of outbox items that share the same acting agent.
  private flush(): void {
    if (!this.connected || this.inflight || !this.ws) return;
    const items = this.opts.store.peekOutbox(OUTBOX_BATCH);
    const first = items[0];
    if (!first) return;
    const run = [];
    for (const item of items) {
      if (item.asAgent !== first.asAgent) break;
      run.push(item);
    }
    const requestId = newId();
    this.inflight = { requestId, eventIds: run.map((i) => i.draft.eventId) };
    this.ws.send(
      JSON.stringify({
        type: "append",
        requestId,
        ...(first.asAgent ? { asAgent: first.asAgent } : {}),
        drafts: run.map((i) => i.draft),
      }),
    );
  }
}

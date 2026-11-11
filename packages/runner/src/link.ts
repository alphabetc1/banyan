// Runner side of the room connection: drains the outbox in order so events emitted while
// the server is unreachable are delivered once it is back.
import { newId, RoomConnection, type AppendResult, type EventDraft, type RoomEvent, type RoomState } from "@banyan/shared";
import type { LocalStore } from "./local-store.ts";
import type { Logger } from "./logger.ts";

const OUTBOX_BATCH = 100;
const TRANSIENT_RETRY_MS = 1000;

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
  private connection: RoomConnection;
  private inflight: string | null = null;
  private closed = false;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private opts: LinkOptions) {
    this.connection = new RoomConnection({
      serverUrl: opts.serverUrl,
      roomId: opts.roomId,
      token: opts.token,
      log: opts.log,
      onEvents: opts.onEvents,
      onAppendResult: (requestId, results) => this.onAppendResult(requestId, results),
      onConnectedChange: (connected) => {
        // An unacknowledged batch is re-sent after reconnecting; the server dedupes by eventId.
        this.inflight = null;
        if (connected) this.flush();
      },
    });
  }

  get state(): RoomState | null {
    return this.connection.state;
  }

  start(): Promise<void> {
    return this.connection.start();
  }

  close(): void {
    this.closed = true;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.connection.close();
  }

  isConnected(): boolean {
    return this.connection.isConnected();
  }

  // Waits until every queued event is acknowledged, or the timeout passes; events still
  // queued afterwards are delivered on the next start.
  async drain(timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (this.opts.store.outboxSize() > 0 && this.connection.isConnected() && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 50));
    }
  }

  // Persists drafts locally first, so they are delivered even if the server is down.
  emit(drafts: EventDraft[], asAgent: string | null = null): void {
    if (drafts.length === 0) return;
    this.opts.store.enqueue(drafts, asAgent);
    this.flush();
  }

  private onAppendResult(requestId: string, results: AppendResult[]): void {
    if (this.closed || requestId !== this.inflight) return;
    const done: string[] = [];
    let transientFailure = false;
    for (const r of results) {
      if (r.ok) done.push(r.eventId);
      else if (isTransient(r.error)) transientFailure = true;
      else {
        this.opts.log.warn(`event ${r.eventId} rejected by server: ${r.error}`);
        done.push(r.eventId);
      }
    }
    this.opts.store.removeFromOutbox(done);
    this.inflight = null;
    if (transientFailure) this.retryTimer = setTimeout(() => this.flush(), TRANSIENT_RETRY_MS);
    else this.flush();
  }

  // Sends the oldest run of outbox items that share the same acting agent.
  private flush(): void {
    if (this.closed || this.inflight || !this.connection.isConnected()) return;
    const items = this.opts.store.peekOutbox(OUTBOX_BATCH);
    const first = items[0];
    if (!first) return;
    const run = [];
    for (const item of items) {
      if (item.asAgent !== first.asAgent) break;
      run.push(item);
    }
    const requestId = newId();
    const sent = this.connection.send({
      type: "append",
      requestId,
      ...(first.asAgent ? { asAgent: first.asAgent } : {}),
      drafts: run.map((i) => i.draft),
    });
    if (sent) this.inflight = requestId;
  }
}

// Live connection to a room, shared by the runner and the web UI: loads a snapshot, follows
// the event stream over WebSocket, and reconnects with backoff, resuming from the last seq.
// Uses the global WebSocket available in browsers and Node 22+.
import { applyEvent, type RoomState } from "./state.ts";
import type { RoomEvent } from "./events.ts";
import type { AppendResult, ClientMessage, ServerMessage } from "./protocol.ts";

const RETRY_MIN_MS = 500;
const RETRY_MAX_MS = 30_000;
// Close code the server uses when it rejects the token on the WebSocket.
const CLOSE_UNAUTHORIZED = 4401;

// Raised when retrying cannot help: the token was rejected or the room does not exist.
export class FatalConnectionError extends Error {}

export interface ConnectionLog {
  info(msg: string): void;
  warn(msg: string): void;
  error(msg: string): void;
}

export interface ConnectionOptions {
  // Origin of the room server, e.g. http://banyan.internal:7700 (window.location.origin in a browser).
  serverUrl: string;
  roomId: string;
  token: string;
  log: ConnectionLog;
  onEvents?(events: RoomEvent[]): void;
  onPresence?(onlineRunnerIds: string[]): void;
  onAppendResult?(requestId: string, results: AppendResult[]): void;
  onConnectedChange?(connected: boolean): void;
}

function wsUrl(serverUrl: string, roomId: string, token: string): string {
  return `${serverUrl.replace(/^http/, "ws")}/api/rooms/${roomId}/ws?token=${encodeURIComponent(token)}`;
}

export class RoomConnection {
  state: RoomState | null = null;
  private ws: WebSocket | null = null;
  private connected = false;
  private everConnected = false;
  private closed = false;
  private retryMs = RETRY_MIN_MS;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private startWaiters: { resolve: () => void; reject: (e: Error) => void }[] = [];

  constructor(private opts: ConnectionOptions) {}

  // Resolves once the first connection is established; rejects with FatalConnectionError
  // if the server refuses the token or the room, since retrying cannot fix that.
  start(): Promise<void> {
    this.connect();
    return new Promise((resolve, reject) => this.startWaiters.push({ resolve, reject }));
  }

  private fail(message: string): void {
    this.opts.log.error(message);
    this.close();
    for (const w of this.startWaiters.splice(0)) w.reject(new FatalConnectionError(message));
  }

  close(): void {
    this.closed = true;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.ws?.close();
  }

  isConnected(): boolean {
    return this.connected;
  }

  // Returns false when not connected; callers decide whether to retry later.
  send(msg: ClientMessage): boolean {
    if (!this.connected || !this.ws) return false;
    this.ws.send(JSON.stringify(msg));
    return true;
  }

  private async fetchState(): Promise<RoomState> {
    const res = await fetch(`${this.opts.serverUrl}/api/rooms/${this.opts.roomId}/state`, {
      headers: { authorization: `Bearer ${this.opts.token}` },
    });
    if (res.status === 401 || res.status === 404) throw new FatalConnectionError(`room server refused access to room ${this.opts.roomId} (${res.status})`);
    if (!res.ok) throw new Error(`state request failed with ${res.status}`);
    return ((await res.json()) as { state: RoomState }).state;
  }

  private scheduleReconnect(): void {
    if (this.closed) return;
    const delay = this.retryMs;
    this.retryMs = Math.min(this.retryMs * 2, RETRY_MAX_MS);
    this.retryTimer = setTimeout(() => this.connect(), delay);
  }

  private setConnected(connected: boolean): void {
    if (this.connected === connected) return;
    this.connected = connected;
    this.opts.onConnectedChange?.(connected);
  }

  private connect(): void {
    if (this.closed) return;
    void (async () => {
      try {
        // The initial snapshot avoids replaying the whole log; reconnects resume by seq.
        if (this.state === null) this.state = await this.fetchState();
      } catch (e) {
        if (e instanceof FatalConnectionError) {
          this.fail(e.message);
          return;
        }
        this.opts.log.warn(`room server unreachable: ${(e as Error).message}`);
        this.scheduleReconnect();
        return;
      }
      if (this.closed) return;
      const ws = new WebSocket(wsUrl(this.opts.serverUrl, this.opts.roomId, this.opts.token));
      this.ws = ws;
      ws.addEventListener("open", () => {
        if (this.everConnected) this.opts.log.info("reconnected to room server");
        this.everConnected = true;
        this.retryMs = RETRY_MIN_MS;
        ws.send(JSON.stringify({ type: "subscribe", afterSeq: this.state!.lastSeq } satisfies ClientMessage));
        this.setConnected(true);
        for (const w of this.startWaiters.splice(0)) w.resolve();
      });
      ws.addEventListener("message", (e) => this.onMessage(JSON.parse(String(e.data)) as ServerMessage));
      ws.addEventListener("close", (e) => {
        if (this.ws !== ws) return;
        if (e.code === CLOSE_UNAUTHORIZED) {
          this.fail(`room server rejected the token for room ${this.opts.roomId}`);
          return;
        }
        if (this.connected && !this.closed) this.opts.log.warn("room server connection lost; reconnecting");
        else if (!this.closed) this.opts.log.warn(`room server connection failed (code ${e.code}); retrying`);
        this.ws = null;
        this.setConnected(false);
        this.scheduleReconnect();
      });
    })();
  }

  private onMessage(msg: ServerMessage): void {
    // Messages can still arrive during the closing handshake.
    if (this.closed) return;
    switch (msg.type) {
      case "events": {
        const fresh = msg.events.filter((e) => e.seq > this.state!.lastSeq);
        for (const e of fresh) applyEvent(this.state!, e);
        if (fresh.length > 0) this.opts.onEvents?.(fresh);
        break;
      }
      case "presence":
        this.opts.onPresence?.(msg.onlineRunnerIds);
        break;
      case "append_result":
        this.opts.onAppendResult?.(msg.requestId, msg.results);
        break;
      case "error":
        this.opts.log.error(`room server error: ${msg.error}`);
        break;
    }
  }
}

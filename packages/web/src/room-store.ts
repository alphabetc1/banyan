// Browser-side room store: a RoomConnection plus request/response for member writes and
// render notifications coalesced to at most 10 per second.
import { useSyncExternalStore } from "react";
import { newId, RoomConnection, type AppendResult, type ConnectionLog, type EventDraft, type RoomEvent, type RoomState } from "@banyan/shared";

const NOTIFY_INTERVAL_MS = 100;

const consoleLog: ConnectionLog = {
  info: (m) => console.info(`[banyan] ${m}`),
  warn: (m) => console.warn(`[banyan] ${m}`),
  error: (m) => console.error(`[banyan] ${m}`),
};

export class RoomStore {
  private connection: RoomConnection;
  private listeners = new Set<() => void>();
  private transcriptListeners = new Set<(e: RoomEvent) => void>();
  private pending = new Map<string, { resolve: (r: AppendResult[]) => void; reject: (e: Error) => void }>();
  private notifyTimer: ReturnType<typeof setTimeout> | null = null;
  private version = 0;
  onlineRunnerIds: string[] = [];
  connected = false;

  constructor(
    serverUrl: string,
    readonly roomId: string,
    readonly memberId: string,
    readonly token: string,
    log: ConnectionLog = consoleLog,
  ) {
    this.connection = new RoomConnection({
      serverUrl,
      roomId,
      token,
      log,
      onEvents: (events) => {
        for (const e of events) if (e.type === "transcript.appended") for (const l of this.transcriptListeners) l(e);
        this.scheduleNotify();
      },
      onPresence: (ids) => {
        this.onlineRunnerIds = ids;
        this.scheduleNotify();
      },
      onAppendResult: (requestId, results) => {
        this.pending.get(requestId)?.resolve(results);
        this.pending.delete(requestId);
      },
      onConnectedChange: (connected) => {
        // Pending writes cannot be acknowledged once the connection is gone.
        this.connected = connected;
        if (!connected) {
          for (const p of this.pending.values()) p.reject(new Error("disconnected from the room server"));
          this.pending.clear();
        }
        this.scheduleNotify();
      },
    });
  }

  start(): Promise<void> {
    return this.connection.start();
  }

  close(): void {
    this.connection.close();
    if (this.notifyTimer) clearTimeout(this.notifyTimer);
  }

  get state(): RoomState | null {
    return this.connection.state;
  }

  // Appends drafts as this member; rejects with the server's reason if any draft is refused.
  async append(drafts: EventDraft[]): Promise<void> {
    const requestId = newId();
    const results = await new Promise<AppendResult[]>((resolve, reject) => {
      if (!this.connection.send({ type: "append", requestId, drafts })) {
        reject(new Error("disconnected from the room server"));
        return;
      }
      this.pending.set(requestId, { resolve, reject });
    });
    const failed = results.find((r) => !r.ok);
    if (failed && !failed.ok) throw new Error(failed.error);
  }

  onTranscript(listener: (e: RoomEvent) => void): () => void {
    this.transcriptListeners.add(listener);
    return () => this.transcriptListeners.delete(listener);
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getVersion = (): number => this.version;

  private scheduleNotify(): void {
    if (this.notifyTimer) return;
    this.notifyTimer = setTimeout(() => {
      this.notifyTimer = null;
      this.version += 1;
      for (const l of this.listeners) l();
    }, NOTIFY_INTERVAL_MS);
  }
}

// Re-renders the caller whenever the room changes (at most 10 times per second).
export function useRoomVersion(store: RoomStore): number {
  return useSyncExternalStore(store.subscribe, store.getVersion);
}

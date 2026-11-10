// In-memory room projections backed by the event log, plus live subscriber fan-out.
import { applyEvent, authorize, emptyRoomState, type Actor, type AppendResult, type EventDraft, type RoomEvent, type RoomState } from "@banyan/shared";
import type { Store } from "./store.ts";

const REPLAY_PAGE = 1000;

export type Subscriber = (events: RoomEvent[]) => void;

interface LiveRoom {
  state: RoomState;
  subscribers: Set<Subscriber>;
}

export class Rooms {
  private rooms = new Map<string, LiveRoom>();

  constructor(
    private store: Store,
    private now: () => number = Date.now,
  ) {}

  // Projection for a room, rebuilt from the log on first access.
  private live(roomId: string): LiveRoom {
    let room = this.rooms.get(roomId);
    if (room) return room;
    const state = emptyRoomState();
    for (let page = this.store.eventsAfter(roomId, 0, { includeTranscript: true, limit: REPLAY_PAGE }); page.length > 0; ) {
      for (const e of page) applyEvent(state, e);
      page = this.store.eventsAfter(roomId, state.lastSeq, { includeTranscript: true, limit: REPLAY_PAGE });
    }
    room = { state, subscribers: new Set() };
    this.rooms.set(roomId, room);
    return room;
  }

  state(roomId: string): RoomState {
    return this.live(roomId).state;
  }

  exists(roomId: string): boolean {
    return this.live(roomId).state.room !== null;
  }

  // Validates and appends drafts one by one so a rejected draft never blocks the rest.
  // Re-submitting an already stored eventId is acknowledged with its original seq, which
  // makes runner outbox replay idempotent.
  append(roomId: string, actor: Actor, drafts: EventDraft[]): AppendResult[] {
    const room = this.live(roomId);
    const results: AppendResult[] = [];
    const appended: RoomEvent[] = [];
    for (const draft of drafts) {
      // A storage failure rejects only this draft; events already stored in the batch
      // are still acknowledged and fanned out below.
      try {
        const existing = this.store.findEventSeq(draft.eventId);
        if (existing) {
          results.push(existing.roomId === roomId ? { eventId: draft.eventId, ok: true, seq: existing.seq } : { eventId: draft.eventId, ok: false, error: "eventId already used" });
          continue;
        }
        const error = authorize(room.state, actor, draft);
        if (error !== null) {
          results.push({ eventId: draft.eventId, ok: false, error });
          continue;
        }
        const event = this.store.append(roomId, actor, draft, this.now());
        applyEvent(room.state, event);
        appended.push(event);
        results.push({ eventId: draft.eventId, ok: true, seq: event.seq });
      } catch (e) {
        results.push({ eventId: draft.eventId, ok: false, error: `storage error: ${(e as Error).message}` });
      }
    }
    if (appended.length > 0) for (const s of room.subscribers) s(appended);
    return results;
  }

  // Sends the backlog after `afterSeq` synchronously, then registers for live events.
  // better-sqlite3 is synchronous, so no event can slip in between backlog and registration.
  subscribe(roomId: string, afterSeq: number, subscriber: Subscriber): () => void {
    const room = this.live(roomId);
    let cursor = afterSeq;
    for (;;) {
      const page = this.store.eventsAfter(roomId, cursor, { includeTranscript: false, limit: REPLAY_PAGE });
      if (page.length === 0) break;
      subscriber(page);
      cursor = page[page.length - 1]!.seq;
    }
    room.subscribers.add(subscriber);
    return () => room.subscribers.delete(subscriber);
  }
}

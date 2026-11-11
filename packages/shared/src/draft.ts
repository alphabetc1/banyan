// Builds an event draft with a fresh, globally unique event id.
import { ulid } from "ulid";
import type { EventDraft } from "./events.ts";

export function draft<T extends EventDraft["type"]>(type: T, payload: Extract<EventDraft, { type: T }>["payload"]): EventDraft {
  return { eventId: ulid(), type, payload } as EventDraft;
}

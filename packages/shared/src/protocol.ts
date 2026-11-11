// WebSocket protocol between the room server and its clients (web UI and runners).
import { z } from "zod";
import { EventDraft, type RoomEvent } from "./events.ts";

export const ClientMessage = z.discriminatedUnion("type", [
  // Stream every event with seq > afterSeq, then live events. Transcript events are
  // only sent live; history is paged over HTTP to keep reconnects fast.
  z.object({ type: z.literal("subscribe"), afterSeq: z.number().int().nonnegative() }),
  z.object({
    type: z.literal("append"),
    requestId: z.string().min(1),
    // Runners set asAgent when submitting on behalf of an agent they host.
    asAgent: z.string().min(1).optional(),
    drafts: z.array(EventDraft).min(1).max(500),
  }),
]);
export type ClientMessage = z.infer<typeof ClientMessage>;

export type AppendResult = { eventId: string; ok: true; seq: number } | { eventId: string; ok: false; error: string };

export type ServerMessage =
  | { type: "events"; events: RoomEvent[] }
  // Runners currently connected to the room; sent on subscribe and whenever it changes.
  | { type: "presence"; onlineRunnerIds: string[] }
  | { type: "append_result"; requestId: string; results: AppendResult[] }
  | { type: "error"; error: string };

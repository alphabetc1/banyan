import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { newId, type EventDraft, type RoomEvent } from "@banyan/shared";
import { Rooms } from "../src/rooms.ts";
import { Store } from "../src/store.ts";

function draft<T extends EventDraft["type"]>(type: T, payload: Extract<EventDraft, { type: T }>["payload"]): EventDraft {
  return { eventId: newId(), type, payload } as EventDraft;
}

describe("Rooms.append", () => {
  it("turns storage failures into per-draft errors instead of throwing", () => {
    const store = new Store(join(mkdtempSync(join(tmpdir(), "banyan-rooms-test-")), "banyan.sqlite"));
    const rooms = new Rooms(store);
    const roomId = newId();
    const seen: RoomEvent[] = [];
    rooms.subscribe(roomId, 0, (events) => seen.push(...events));
    const created = draft("room.created", { name: "r", repoUrl: "u", baseBranch: "main", rootGoalId: "g", rootGoalTitle: "t", rootGoalDescription: "" });
    expect(rooms.append(roomId, { kind: "system" }, [created])[0]).toMatchObject({ ok: true });
    expect(seen.map((e) => e.type)).toEqual(["room.created"]);

    store.close();
    const results = rooms.append(roomId, { kind: "system" }, [draft("member.joined", { memberId: "m", displayName: "M", role: "owner" })]);
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ ok: false });
    expect(results[0]!.ok === false && results[0]!.error).toMatch(/^storage error: /);
    expect(seen).toHaveLength(1);
  });
});

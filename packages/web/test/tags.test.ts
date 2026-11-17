import { afterEach, describe, expect, it, vi } from "vitest";
import { addTag, EMPTY_BOARD, loadBoard, nextColor, placeNear, removeTag, saveBoard, setAgentTag, tagOfAgent, tagSections, TAG_COLORS, updateTag, type Tag, type TagBoard } from "../src/tags.ts";

const tag = (id: string, color: Tag["color"] = "sage"): Tag => ({ id, name: id, color, collapsed: false });
const agents = ["a", "b", "c", "d"].map((id) => ({ id }));

describe("tags", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("puts each agent in at most one tag and moves it between tags", () => {
    let board = addTag(addTag(EMPTY_BOARD, tag("day0")), tag("review"));
    board = setAgentTag(board, "a", "day0");
    board = setAgentTag(board, "a", "review");
    expect(board.tagOf).toEqual({ a: "review" });
    expect(tagOfAgent(board, "a")?.id).toBe("review");
    board = setAgentTag(board, "a", null);
    expect(board.tagOf).toEqual({});
    expect(tagOfAgent(board, "a")).toBeNull();
  });

  it("lists every tag in order, empty ones too, then the untagged agents, keeping the agents' order", () => {
    let board = addTag(addTag(EMPTY_BOARD, tag("day0")), tag("empty"));
    board = setAgentTag(setAgentTag(board, "c", "day0"), "a", "day0");
    expect(tagSections(agents, board).map((s) => [s.tag?.id ?? null, s.agents.map((a) => a.id)])).toEqual([
      ["day0", ["a", "c"]],
      ["empty", []],
      [null, ["b", "d"]],
    ]);
    // Without tags, every agent is untagged.
    expect(tagSections(agents, EMPTY_BOARD)).toEqual([{ tag: null, agents }]);
  });

  it("returns a deleted tag's agents to the untagged ones and ignores tags that no longer exist", () => {
    let board = setAgentTag(setAgentTag(addTag(addTag(EMPTY_BOARD, tag("day0")), tag("keep")), "a", "day0"), "b", "keep");
    board = removeTag(board, "day0");
    expect(board.tags.map((t) => t.id)).toEqual(["keep"]);
    expect(board.tagOf).toEqual({ b: "keep" });
    const stale: TagBoard = { tags: [], tagOf: { a: "gone" } };
    expect(tagOfAgent(stale, "a")).toBeNull();
    expect(tagSections(agents, stale)[0]!.agents).toEqual(agents);
  });

  it("renames, recolours and collapses a tag", () => {
    const board = updateTag(addTag(EMPTY_BOARD, tag("day0")), "day0", { name: "day1", color: "plum", collapsed: true });
    expect(board.tags).toEqual([{ id: "day0", name: "day1", color: "plum", collapsed: true }]);
  });

  it("suggests the first unused colour, then goes round the palette", () => {
    expect(nextColor(EMPTY_BOARD)).toBe(TAG_COLORS[0]);
    expect(nextColor(addTag(EMPTY_BOARD, tag("x", TAG_COLORS[0])))).toBe(TAG_COLORS[1]);
    const full = TAG_COLORS.reduce((b, c, i) => addTag(b, tag(`t${i}`, c)), EMPTY_BOARD);
    expect(nextColor(full)).toBe(TAG_COLORS[0]);
  });

  it("moves an id just before or after another one", () => {
    expect(placeNear(["a", "b", "c", "d"], "d", "b", false)).toEqual(["a", "d", "b", "c"]);
    expect(placeNear(["a", "b", "c", "d"], "a", "c", true)).toEqual(["b", "c", "a", "d"]);
    expect(placeNear(["a", "b"], "a", "gone", true)).toEqual(["b", "a"]);
  });

  it("keeps the board per room in this browser and survives broken storage", () => {
    const store = new Map<string, string>();
    vi.stubGlobal("localStorage", { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => store.set(k, v) });
    const board = setAgentTag(addTag(EMPTY_BOARD, tag("day0")), "a", "day0");
    saveBoard("room-1", board);
    expect(loadBoard("room-1")).toEqual(board);
    expect(loadBoard("room-2")).toEqual(EMPTY_BOARD);
    // Malformed tags are dropped; unreadable data starts empty.
    store.set("banyan.agentTags.room-3", JSON.stringify({ tags: [tag("ok"), { id: "bad" }], tagOf: {} }));
    expect(loadBoard("room-3").tags.map((t) => t.id)).toEqual(["ok"]);
    store.set("banyan.agentTags.room-4", "{not json");
    expect(loadBoard("room-4")).toEqual(EMPTY_BOARD);
  });
});

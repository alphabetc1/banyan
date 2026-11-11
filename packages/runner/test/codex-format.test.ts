import { describe, expect, it } from "vitest";
import { describeFileChange } from "../src/providers/codex.ts";

describe("describeFileChange", () => {
  it("names the action and path for every change kind", () => {
    expect(describeFileChange({ path: "a.py", kind: { type: "add" }, diff: "+x" })).toBe("add a.py\n+x");
    expect(describeFileChange({ path: "b.py", kind: { type: "delete" }, diff: "-y" })).toBe("delete b.py\n-y");
    expect(describeFileChange({ path: "c.py", kind: { type: "update", move_path: null }, diff: "@@" })).toBe("update c.py\n@@");
    expect(describeFileChange({ path: "d.py", kind: { type: "update", move_path: "e.py" }, diff: "" })).toBe("move to e.py d.py\n");
  });
});

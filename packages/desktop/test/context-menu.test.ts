import type { ContextMenuParams } from "electron";
import { describe, expect, it } from "vitest";
import { contextMenuTemplate } from "../src/context-menu.ts";

const flags = { canUndo: false, canRedo: false, canCut: true, canCopy: true, canPaste: true, canDelete: false, canSelectAll: true, canEditRichly: false };
const params = (p: Partial<Pick<ContextMenuParams, "isEditable" | "selectionText" | "linkURL" | "editFlags">>) => ({ isEditable: false, selectionText: "", linkURL: "", editFlags: flags, ...p });
const describeItems = (items: ReturnType<typeof contextMenuTemplate>) => items.map((i) => (i.type === "separator" ? "-" : `${i.role ?? "action"}:${i.label}${i.enabled === false ? " (disabled)" : ""}`));

describe("context menu", () => {
  const noActions = { openExternal: () => {}, copyText: () => {} };

  it("offers cut, copy, paste and select all in a text field or the terminal", () => {
    expect(describeItems(contextMenuTemplate(params({ isEditable: true, editFlags: { ...flags, canCut: false } }), false, noActions))).toEqual(["cut:Cut (disabled)", "copy:Copy", "paste:Paste", "-", "selectAll:Select All"]);
    expect(describeItems(contextMenuTemplate(params({ isEditable: true }), true, noActions))).toEqual(["cut:剪切", "copy:复制", "paste:粘贴", "-", "selectAll:全选"]);
  });

  it("offers copy for selected text and nothing when there is nothing to act on", () => {
    expect(describeItems(contextMenuTemplate(params({ selectionText: "some text" }), false, noActions))).toEqual(["copy:Copy"]);
    expect(contextMenuTemplate(params({ selectionText: "  " }), false, noActions)).toEqual([]);
    expect(contextMenuTemplate(params({}), false, noActions)).toEqual([]);
  });

  it("opens web links in the browser or copies them, and ignores other links", () => {
    const opened: string[] = [];
    const copied: string[] = [];
    const items = contextMenuTemplate(params({ linkURL: "https://github.com/x/y/pull/1", selectionText: "pull/1" }), false, { openExternal: (u) => opened.push(u), copyText: (t) => copied.push(t) });
    expect(describeItems(items)).toEqual(["action:Open Link in Browser", "action:Copy Link", "-", "copy:Copy"]);
    (items[0]!.click as () => void)();
    (items[1]!.click as () => void)();
    expect(opened).toEqual(["https://github.com/x/y/pull/1"]);
    expect(copied).toEqual(["https://github.com/x/y/pull/1"]);
    expect(contextMenuTemplate(params({ linkURL: "file:///etc/passwd" }), false, noActions)).toEqual([]);
  });
});

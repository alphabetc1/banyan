import { describe, expect, it } from "vitest";
import { TerminalScreen } from "../src/terminal-screen.ts";

// Resolves once everything written to the screen so far is on it.
const settled = (screen: TerminalScreen) => new Promise<void>((resolve) => screen.afterPending(resolve));

// What an empty terminal of the given size shows after drawing the screen's serialized form.
async function redrawn(screen: TerminalScreen, cols: number, rows: number): Promise<string> {
  const view = new TerminalScreen(cols, rows);
  view.write(screen.serialize());
  await settled(view);
  return view.text();
}

describe("TerminalScreen", () => {
  it("redraws a long, colored, relatively redrawn session exactly on an empty terminal", async () => {
    const screen = new TerminalScreen(40, 6);
    // Far more output than the screen and its history, in 24-bit color, with a status line
    // the program keeps redrawing in place through relative cursor moves.
    for (let i = 0; i < 20_000; i++) screen.write(`\x1b[38;2;215;134;102mline ${i}\x1b[0m\r\n`);
    screen.write("Composing… 1s\r\n");
    for (let s = 2; s <= 50; s++) screen.write(`\x1b[1A\x1b[2KComposing… ${s}s\r\n`);
    await settled(screen);

    const text = await redrawn(screen, 40, 6);
    expect(text).toBe(screen.text());
    expect(text.split("\n").slice(-3)).toEqual(["line 19999", "Composing… 50s", ""]);
    expect(text).not.toContain("134;102m");
    expect(screen.serialize().startsWith("\x1b")).toBe(true);
  });

  it("restores the alternate screen and the mouse reporting the program turned on, as Claude Code does at start", async () => {
    const screen = new TerminalScreen(40, 5);
    // The sequences Claude Code 2.1 sends once at start, before drawing its own UI.
    screen.write("shell prompt\r\n\x1b[?2004h\x1b[?1004h\x1b[?1049h\x1b[?1000h\x1b[?1002h\x1b[?1003h\x1b[?1006h\x1b[2J\x1b[Hconversation");
    await settled(screen);
    const serialized = screen.serialize();
    for (const mode of ["?1049h", "?1003h", "?1006h", "?2004h", "?1004h"]) expect(serialized).toContain(`\x1b[${mode}`);

    const view = new TerminalScreen(40, 5);
    view.write(serialized);
    await settled(view);
    expect(view.text()).toBe(screen.text());
    expect(view.serialize()).toBe(serialized);
  });

  it("forgets a mouse encoding the program turned off", async () => {
    const screen = new TerminalScreen(40, 5);
    screen.write("\x1b[?1003h\x1b[?1006h");
    await settled(screen);
    expect(screen.serialize()).toContain("\x1b[?1006h");
    screen.write("\x1b[?1006l");
    await settled(screen);
    expect(screen.serialize()).not.toContain("\x1b[?1006h");
    // Several modes in one sequence count too.
    screen.write("\x1b[?1002;1006h");
    await settled(screen);
    expect(screen.serialize()).toContain("\x1b[?1006h");
  });

  it("shows only the visible rows as text", async () => {
    const screen = new TerminalScreen(20, 3);
    screen.write("one\r\ntwo\r\nthree\r\nfour");
    await settled(screen);
    expect(screen.text()).toBe("two\nthree\nfour");
  });

  it("calls back once a chunk is on the screen, in the order written", async () => {
    const screen = new TerminalScreen(20, 3);
    const seen: string[] = [];
    screen.write("first", () => seen.push(screen.text().trim()));
    screen.write(" second", () => seen.push(screen.text().trim()));
    await settled(screen);
    expect(seen).toEqual(["first", "first second"]);
  });

  it("lays out output written before a resize at the size it was written for", async () => {
    const screen = new TerminalScreen(10, 3);
    // Column 25 exists only after the resize; at 10 columns the cursor stops at column 10.
    screen.write("\x1b[25GX");
    screen.resize(30, 3);
    await settled(screen);
    expect(screen.text().split("\n")[0]).toBe(`${" ".repeat(9)}X`);
    expect(await redrawn(screen, 30, 3)).toBe(screen.text());
  });
});

// What a terminal shows, kept by a terminal emulator without a display. A view that attaches
// later starts from this screen rather than a replay of raw output: a replay cut at an
// arbitrary point starts inside escape sequences and lacks the cursor position the CLIs'
// relative redraws depend on.
import serialize from "@xterm/addon-serialize";
import headless from "@xterm/headless";

// As much history as the view itself keeps.
const SCROLLBACK_LINES = 10_000;
// Mouse report encodings a program can turn on (DECSET), which the serializer does not restore.
// Claude Code and Codex turn on SGR; a view left on the default encoding sends wheel events
// they do not read, so scrolling up does nothing.
const MOUSE_ENCODINGS = [1006, 1016];

export class TerminalScreen {
  private term: headless.Terminal;
  private serializer = new serialize.SerializeAddon();
  private mouseEncoding: number | null = null;

  constructor(cols: number, rows: number) {
    this.term = new headless.Terminal({ cols, rows, scrollback: SCROLLBACK_LINES, allowProposedApi: true });
    this.term.loadAddon(this.serializer);
    // Returning false leaves the sequence to the terminal's own handling as well.
    const trackMouseEncoding = (set: boolean) => (params: (number | number[])[]) => {
      for (const p of params) {
        if (typeof p !== "number" || !MOUSE_ENCODINGS.includes(p)) continue;
        if (set) this.mouseEncoding = p;
        else if (this.mouseEncoding === p) this.mouseEncoding = null;
      }
      return false;
    };
    this.term.parser.registerCsiHandler({ prefix: "?", final: "h" }, trackMouseEncoding(true));
    this.term.parser.registerCsiHandler({ prefix: "?", final: "l" }, trackMouseEncoding(false));
  }

  // Output is parsed asynchronously and in order; onParsed runs once the screen shows it.
  write(data: string, onParsed?: () => void): void {
    this.term.write(data, onParsed);
  }

  // Runs fn once all output written so far is on the screen.
  afterPending(fn: () => void): void {
    this.term.write("", fn);
  }

  // Output already written was laid out for the old size, so the size changes after it.
  resize(cols: number, rows: number): void {
    this.afterPending(() => this.term.resize(cols, rows));
  }

  // Escape sequences that redraw this screen, with its history and the modes the program
  // set, on an empty terminal.
  serialize(): string {
    return this.serializer.serialize() + (this.mouseEncoding ? `\x1b[?${this.mouseEncoding}h` : "");
  }

  // The visible rows as plain text, one line per row.
  text(): string {
    const buffer = this.term.buffer.active;
    const rows: string[] = [];
    for (let y = buffer.viewportY; y < buffer.viewportY + this.term.rows; y++) rows.push(buffer.getLine(y)?.translateToString(true) ?? "");
    return rows.join("\n");
  }
}

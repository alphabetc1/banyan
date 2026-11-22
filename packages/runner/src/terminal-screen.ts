// What a terminal shows, kept by a terminal emulator without a display. A view that attaches
// later starts from this screen rather than a replay of raw output: a replay cut at an
// arbitrary point starts inside escape sequences and lacks the cursor position the CLIs'
// relative redraws depend on.
import serialize from "@xterm/addon-serialize";
import headless from "@xterm/headless";

// As much history as the view itself keeps.
const SCROLLBACK_LINES = 10_000;

export class TerminalScreen {
  private term: headless.Terminal;
  private serializer = new serialize.SerializeAddon();

  constructor(cols: number, rows: number) {
    this.term = new headless.Terminal({ cols, rows, scrollback: SCROLLBACK_LINES, allowProposedApi: true });
    this.term.loadAddon(this.serializer);
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

  // Escape sequences that redraw this screen, with its history, on an empty terminal.
  serialize(): string {
    return this.serializer.serialize();
  }

  // The visible rows as plain text, one line per row.
  text(): string {
    const buffer = this.term.buffer.active;
    const rows: string[] = [];
    for (let y = buffer.viewportY; y < buffer.viewportY + this.term.rows; y++) rows.push(buffer.getLine(y)?.translateToString(true) ?? "");
    return rows.join("\n");
  }
}

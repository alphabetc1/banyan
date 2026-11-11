// Minimal injectable logger so tests can capture and assert on runner output.
export interface Logger {
  info(msg: string): void;
  warn(msg: string): void;
  error(msg: string): void;
}

export const consoleLogger: Logger = {
  info: (msg) => console.log(`[banyan] ${msg}`),
  warn: (msg) => console.warn(`[banyan] WARN ${msg}`),
  error: (msg) => console.error(`[banyan] ERROR ${msg}`),
};

export class MemoryLogger implements Logger {
  lines: { level: "info" | "warn" | "error"; msg: string }[] = [];
  info(msg: string): void {
    this.lines.push({ level: "info", msg });
  }
  warn(msg: string): void {
    this.lines.push({ level: "warn", msg });
  }
  error(msg: string): void {
    this.lines.push({ level: "error", msg });
  }
}

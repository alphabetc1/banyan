// The server entry point as a real process: it serves, then exits cleanly on SIGTERM.
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const s = createServer().listen(0, "127.0.0.1", () => {
      const port = (s.address() as { port: number }).port;
      s.close(() => resolve(port));
    });
  });
}

describe("server process", () => {
  it("serves health checks and shuts down cleanly on SIGTERM", async () => {
    const port = await freePort();
    const dir = mkdtempSync(join(tmpdir(), "banyan-main-test-"));
    const tsx = fileURLToPath(new URL("../../../node_modules/.bin/tsx", import.meta.url));
    const child = spawn(tsx, [fileURLToPath(new URL("../src/main.ts", import.meta.url))], {
      env: { ...process.env, BANYAN_PORT: String(port), BANYAN_DB: join(dir, "banyan.sqlite"), BANYAN_WEB_DIR: join(dir, "no-web") },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.on("data", (d) => (output += d));
    child.stderr.on("data", (d) => (output += d));
    const exited = new Promise<number | null>((resolve) => child.on("exit", (code) => resolve(code)));

    let healthy = false;
    for (let i = 0; i < 100 && !healthy; i++) {
      healthy = await fetch(`http://127.0.0.1:${port}/api/health`).then((r) => r.ok, () => false);
      if (!healthy) await new Promise((r) => setTimeout(r, 100));
    }
    expect(healthy).toBe(true);

    child.kill("SIGTERM");
    expect(await exited).toBe(0);
    expect(output).toContain("received SIGTERM, shutting down");
  }, 30_000);
});

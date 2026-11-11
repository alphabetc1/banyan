import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loginShellPath } from "../src/shell-env.ts";

describe("login shell PATH", () => {
  it("reads PATH from a real login shell, ignoring what its rc files print", () => {
    const home = mkdtempSync(join(tmpdir(), "banyan-shell-"));
    writeFileSync(join(home, ".bashrc"), 'echo "welcome banner"\nexport PATH="/opt/banyan-test/bin:$PATH"\n');
    writeFileSync(join(home, ".bash_profile"), "source ~/.bashrc\n");
    const original = process.env.HOME;
    process.env.HOME = home;
    try {
      const path = loginShellPath("/bin/bash");
      expect(path?.split(":")[0]).toBe("/opt/banyan-test/bin");
      expect(path).not.toContain("welcome banner");
    } finally {
      process.env.HOME = original;
    }
  });

  it("returns null when the shell cannot run", () => {
    expect(loginShellPath("/nonexistent/shell")).toBeNull();
  });
});

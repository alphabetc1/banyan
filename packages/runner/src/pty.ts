// node-pty, made usable: its prebuilt spawn-helper is installed without the execute bit by
// both npm and pnpm, and every spawn then fails with "posix_spawnp failed".
import { chmodSync, existsSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import type * as NodePty from "node-pty";

const require = createRequire(import.meta.url);
let helperChecked = false;

function ensureSpawnHelperExecutable(): void {
  if (helperChecked || process.platform === "win32") return;
  helperChecked = true;
  const root = dirname(require.resolve("node-pty/package.json"));
  for (const helper of [join(root, "prebuilds", `${process.platform}-${process.arch}`, "spawn-helper"), join(root, "build", "Release", "spawn-helper")]) {
    if (existsSync(helper) && (statSync(helper).mode & 0o111) === 0) chmodSync(helper, 0o755);
  }
}

export function spawnPty(file: string, args: string[], options: NodePty.IPtyForkOptions): NodePty.IPty {
  ensureSpawnHelperExecutable();
  const pty = require("node-pty") as typeof NodePty;
  return pty.spawn(file, args, options);
}

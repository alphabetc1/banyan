// Apps started from the Dock or a desktop launcher get a minimal PATH, so codex, git and gh
// installed by the user are not found. Reads PATH from the user's login shell instead.
import { spawnSync } from "node:child_process";

const MARKER = "__BANYAN_PATH__";

// Returns null when the shell cannot be run or prints nothing usable.
export function loginShellPath(shell: string): string | null {
  // Interactive so rc files that extend PATH are read; the marker separates PATH from
  // anything those files print.
  const result = spawnSync(shell, ["-ilc", `printf '${MARKER}%s${MARKER}' "$PATH"`], { encoding: "utf8", timeout: 5000, stdio: ["ignore", "pipe", "ignore"] });
  if (result.status !== 0 || !result.stdout) return null;
  const match = result.stdout.match(new RegExp(`${MARKER}(.*)${MARKER}`, "s"));
  return match?.[1] || null;
}

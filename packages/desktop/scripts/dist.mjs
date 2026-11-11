// Builds the macOS installers for both Intel and Apple Silicon into build/dist, named
// Banyan-<arch>.dmg so the room server's install script can pick one by architecture.
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const run = (cmd, args) => execFileSync(cmd, args, { cwd: root, stdio: "inherit" });

for (const arch of ["x64", "arm64"]) {
  run("node", ["scripts/build.mjs", "--arch", arch]);
  run(join(root, "node_modules", ".bin", "electron-builder"), ["--mac", `--${arch}`, `--config.directories.app=build/app-${arch}`]);
}

// Builds the self-contained app directory build/app-<arch> that Electron runs and
// electron-builder packages: bundled sources plus a plain npm node_modules holding only the
// dependencies that cannot be bundled. Their own npm install selects the Claude SDK's
// executable for the target architecture and gives electron-builder a node_modules without
// pnpm's symlinks. better-sqlite3 ships Node-API prebuilds, which Electron loads as is.
//   node scripts/build.mjs [--arch x64|arm64]   (default: this machine's architecture)
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { build } from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const { values } = parseArgs({ options: { arch: { type: "string", default: process.arch } } });
const arch = values.arch;
if (arch !== "x64" && arch !== "arm64") throw new Error(`unsupported architecture: ${arch}`);
const out = join(root, "build", `app-${arch}`);
const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));
const desktop = readJson(join(root, "package.json"));
const runner = readJson(join(root, "..", "runner", "package.json"));
const electronVersion = readJson(join(root, "node_modules", "electron", "package.json")).version;

// better-sqlite3 is native; the Claude SDK finds its bundled claude executable relative to
// its own install location.
const EXTERNAL = ["better-sqlite3", "@anthropic-ai/claude-agent-sdk"];

// Start clean: native modules and the Claude SDK's executable are per architecture.
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

const common = { bundle: true, platform: "node", target: "node22", sourcemap: "linked", external: ["electron", ...EXTERNAL], logLevel: "warning" };
await build({
  ...common,
  entryPoints: { main: join(root, "src", "main.ts"), "runner-host": join(root, "src", "runner-host.ts") },
  outdir: out,
  format: "esm",
  outExtension: { ".js": ".mjs" },
  // Bundled CommonJS dependencies call require().
  banner: { js: 'import { createRequire as __createRequire } from "node:module"; const require = __createRequire(import.meta.url);' },
});
// Sandboxed preload scripts must be CommonJS.
await build({ ...common, entryPoints: { preload: join(root, "src", "preload.ts") }, outdir: out, format: "cjs", outExtension: { ".js": ".cjs" } });
copyFileSync(join(root, "src", "setup.html"), join(out, "setup.html"));

const appManifest = {
  name: "banyan-desktop",
  productName: "Banyan",
  version: desktop.version,
  private: true,
  type: "module",
  main: "main.mjs",
  dependencies: Object.fromEntries(EXTERNAL.map((name) => [name, runner.dependencies[name]])),
};
writeFileSync(join(out, "package.json"), `${JSON.stringify(appManifest, null, 2)}\n`);
// Variables pnpm sets for its own run would make npm warn about unknown config.
const npmEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("npm_config_")));
// --cpu picks the Claude SDK's platform package for the target architecture.
execFileSync("npm", ["install", "--omit=dev", "--no-audit", "--no-fund", `--cpu=${arch}`], { cwd: out, stdio: "inherit", env: npmEnv });
console.log(`built ${out} for Electron ${electronVersion} (${arch})`);

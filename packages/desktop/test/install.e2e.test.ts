// One-command install end to end: a real room server hosting the built installers, the exact
// `curl | bash` command the invite dialog shows, and the installed app launching against
// that server. Needs `node scripts/dist.mjs` first (part of `pnpm test:e2e`).
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron, expect, test } from "@playwright/test";
import { buildApp } from "@banyan/server/app";

const DESKTOP = fileURLToPath(new URL("..", import.meta.url));
const WEB_DIR = fileURLToPath(new URL("../../web/dist", import.meta.url));
// The key is missing on Intel Macs, where sysctl fails.
const HOST_ARCH = spawnSync("sysctl", ["-n", "hw.optional.arm64"], { encoding: "utf8" }).stdout.trim() === "1" ? "arm64" : "x64";
const MACHO_ARCH = { x64: "x86_64", arm64: "arm64" } as const;

let app: Awaited<ReturnType<typeof buildApp>>;
let base: string;

test.beforeAll(async () => {
  app = await buildApp({
    dbPath: join(mkdtempSync(join(tmpdir(), "banyan-install-")), "server.sqlite"),
    webDir: WEB_DIR,
    desktop: { installScript: join(DESKTOP, "install.sh"), downloadsDir: join(DESKTOP, "build", "dist") },
  });
  base = await app.listen({ host: "127.0.0.1", port: 0 });
});

test.afterAll(async () => {
  await app.close();
});

// Asynchronous: the server answering curl runs in this process.
function install(dest: string): Promise<{ status: number | null; output: string }> {
  const child = spawn("bash", ["-c", `curl -fsSL ${base}/install.sh | bash -s ${base}`], {
    env: { ...process.env, BANYAN_INSTALL_DIR: dest, BANYAN_INSTALL_LAUNCH: "0" },
  });
  let output = "";
  child.stdout.on("data", (d: Buffer) => (output += d.toString()));
  child.stderr.on("data", (d: Buffer) => (output += d.toString()));
  return new Promise((resolve) => child.once("close", (status) => resolve({ status, output })));
}

const archOf = (path: string) => execFileSync("file", ["-b", path], { encoding: "utf8" });

test("builds installers whose executables match each architecture", () => {
  for (const arch of ["x64", "arm64"] as const) {
    const contents = join(DESKTOP, "build", "dist", arch === "x64" ? "mac" : "mac-arm64", "Banyan.app", "Contents");
    expect(existsSync(join(DESKTOP, "build", "dist", `Banyan-${arch}.dmg`))).toBe(true);
    expect(archOf(join(contents, "MacOS", "Banyan"))).toContain(MACHO_ARCH[arch]);
    expect(archOf(join(contents, "Resources", "app", "node_modules", "@anthropic-ai", `claude-agent-sdk-darwin-${arch}`, "claude"))).toContain(MACHO_ARCH[arch]);
    expect(archOf(join(contents, "Resources", "app", "node_modules", "better-sqlite3", "prebuilds", `darwin-${arch}.node`))).toContain(MACHO_ARCH[arch]);
  }
});

test("installs this Mac's build with one command, opens it on the server, and updates it in place", async () => {
  const dest = mkdtempSync(join(tmpdir(), "banyan-apps-"));
  const first = await install(dest);
  expect(first.status).toBe(0);
  expect(first.output).toContain(`banyan: downloading the client for ${HOST_ARCH} from ${base}`);
  expect(first.output).toContain(`banyan: installed ${dest}/Banyan.app`);
  const executable = join(dest, "Banyan.app", "Contents", "MacOS", "Banyan");
  expect(archOf(executable)).toContain(MACHO_ARCH[HOST_ARCH]);
  expect(spawnSync("xattr", ["-p", "com.apple.quarantine", join(dest, "Banyan.app")]).status).not.toBe(0);

  // The installed app opens straight on the server the script came from.
  const clientData = mkdtempSync(join(tmpdir(), "banyan-install-data-"));
  const client = await electron.launch({
    executablePath: executable,
    args: ["--lang=en-US", `--server-url=${base}`],
    env: { ...process.env, BANYAN_DESKTOP_DATA: clientData, BANYAN_LOCAL_PORT: "0" },
  });
  const exited = new Promise<number | null>((resolve) => client.process().once("exit", (code) => resolve(code)));
  try {
    const page = await client.firstWindow();
    await expect(page.getByRole("heading", { name: "Banyan" })).toBeVisible();
    expect(page.url()).toBe(`${base}/`);
    expect(JSON.parse(readFileSync(join(clientData, "settings.json"), "utf8"))).toMatchObject({ serverUrl: base, lastOpened: "team" });

    // Running the command again quits the running copy gracefully and replaces it.
    const second = await install(dest);
    expect(second.status).toBe(0);
    expect(second.output).toContain("banyan: quitting the running client");
    expect(await exited).toBe(0);
    expect(archOf(executable)).toContain(MACHO_ARCH[HOST_ARCH]);
  } finally {
    // Only matters when an assertion failed before the reinstall quit it.
    await client.close().catch(() => {});
  }
});

test("refuses to run without a server address", () => {
  const result = spawnSync("bash", [join(DESKTOP, "install.sh")], { encoding: "utf8" });
  expect(result.status).toBe(1);
  expect(result.stderr).toBe("banyan: usage: install.sh <room server URL>\n");
});

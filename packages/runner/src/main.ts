// Runner CLI.
//   banyan-runner register --server <url> --room <roomId> --member-token <token> [--hostname <name>]
//   banyan-runner start --room <roomId>
// Runner credentials are stored in $BANYAN_HOME/rooms/<roomId>/runner.json (default ~/.banyan).
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { consoleLogger } from "./logger.ts";
import { Runner } from "./runner.ts";

const MONITOR_INTERVAL_MS = 10 * 60_000;

interface SavedRunner {
  serverUrl: string;
  roomId: string;
  runnerId: string;
  runnerToken: string;
}

function roomDir(roomId: string): string {
  return join(process.env.BANYAN_HOME ?? join(homedir(), ".banyan"), "rooms", roomId);
}

async function register(args: string[]): Promise<void> {
  const { values } = parseArgs({
    args,
    options: { server: { type: "string" }, room: { type: "string" }, "member-token": { type: "string" }, hostname: { type: "string" } },
  });
  if (!values.server || !values.room || !values["member-token"]) throw new Error("register needs --server, --room and --member-token");
  const res = await fetch(`${values.server}/api/rooms/${values.room}/runners`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${values["member-token"]}` },
    body: JSON.stringify({ hostname: values.hostname ?? hostname() }),
  });
  if (!res.ok) throw new Error(`registration failed with ${res.status}: ${await res.text()}`);
  const { runnerId, runnerToken } = (await res.json()) as { runnerId: string; runnerToken: string };
  const dir = roomDir(values.room);
  mkdirSync(dir, { recursive: true });
  const saved: SavedRunner = { serverUrl: values.server, roomId: values.room, runnerId, runnerToken };
  writeFileSync(join(dir, "runner.json"), JSON.stringify(saved, null, 2), { mode: 0o600 });
  console.log(`registered runner ${runnerId}; start it with: banyan-runner start --room ${values.room}`);
}

async function start(args: string[]): Promise<void> {
  const { values } = parseArgs({ args, options: { room: { type: "string" } } });
  if (!values.room) throw new Error("start needs --room");
  const dir = roomDir(values.room);
  const saved = JSON.parse(readFileSync(join(dir, "runner.json"), "utf8")) as SavedRunner;
  const runner = new Runner({ ...saved, roomDir: dir, monitorIntervalMs: MONITOR_INTERVAL_MS }, consoleLogger);
  await runner.start();
  consoleLogger.info(`runner ${saved.runnerId} connected to room ${saved.roomId}`);
  const shutdown = () => {
    void runner.stop().then(() => process.exit(0));
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

const [command, ...rest] = process.argv.slice(2);
if (command === "register") await register(rest);
else if (command === "start") await start(rest);
else {
  console.error("usage: banyan-runner register|start ...");
  process.exit(2);
}

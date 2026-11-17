// Runner CLI.
//   banyan-runner register --server <url> --room <roomId> --member-token <token> [--hostname <name>]
//   banyan-runner start --room <roomId>
// BANYAN_CLAUDE_ARGS and BANYAN_CODEX_ARGS add command-line arguments to terminal sessions.
import { hostname } from "node:os";
import { parseArgs } from "node:util";
import { terminalArgsFromEnv } from "./args.ts";
import { consoleLogger } from "./logger.ts";
import { acquireRunnerLock, readSavedRunner, registerRunner, roomDir } from "./registration.ts";
import { Runner } from "./runner.ts";

const MONITOR_INTERVAL_MS = 10 * 60_000;

async function register(args: string[]): Promise<void> {
  const { values } = parseArgs({
    args,
    options: { server: { type: "string" }, room: { type: "string" }, "member-token": { type: "string" }, hostname: { type: "string" } },
  });
  if (!values.server || !values.room || !values["member-token"]) throw new Error("register needs --server, --room and --member-token");
  const saved = await registerRunner({ serverUrl: values.server, roomId: values.room, memberToken: values["member-token"], hostname: values.hostname ?? hostname() });
  console.log(`registered runner ${saved.runnerId}; start it with: banyan-runner start --room ${values.room}`);
}

async function start(args: string[]): Promise<void> {
  const { values } = parseArgs({ args, options: { room: { type: "string" } } });
  if (!values.room) throw new Error("start needs --room");
  const saved = readSavedRunner(values.room);
  if (!saved) throw new Error(`no runner registered for room ${values.room}; run register first`);
  const dir = roomDir(values.room);
  const releaseLock = acquireRunnerLock(dir);
  const terminalArgs = terminalArgsFromEnv(process.env);
  const runner = new Runner({ ...saved, roomDir: dir, monitorIntervalMs: MONITOR_INTERVAL_MS, ...(terminalArgs ? { terminalArgs } : {}) }, consoleLogger);
  try {
    await runner.start();
  } catch (e) {
    console.error(`cannot start runner: ${(e as Error).message}`);
    await runner.stop();
    releaseLock();
    process.exit(1);
  }
  consoleLogger.info(`runner ${saved.runnerId} connected to room ${saved.roomId}`);
  const shutdown = () => {
    void runner.stop().then(() => {
      releaseLock();
      process.exit(0);
    });
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

// Entry of the utility process hosting one room's runner, so a runner crash or a busy runner
// never affects the window. Started with the room id as its only argument.
import { acquireRunnerLock, readSavedRunner, roomDir } from "@banyan/runner/registration";
import { consoleLogger } from "@banyan/runner/logger";
import { Runner } from "@banyan/runner/runner";
import type { HostMessage, MainMessage } from "./host-protocol.ts";

const MONITOR_INTERVAL_MS = 10 * 60_000;

const port = process.parentPort;
const send = (msg: HostMessage) => port.postMessage(msg);
const roomId = process.argv[2];

async function main(): Promise<void> {
  if (!roomId) throw new Error("runner host needs a room id");
  const saved = readSavedRunner(roomId);
  if (!saved) throw new Error(`no runner registered for room ${roomId}`);
  const dir = roomDir(roomId);
  const releaseLock = acquireRunnerLock(dir);
  const runner = new Runner({ ...saved, roomDir: dir, monitorIntervalMs: MONITOR_INTERVAL_MS }, consoleLogger);
  const stop = async (code: number) => {
    await runner.stop();
    releaseLock();
    process.exit(code);
  };
  port.on("message", (e: { data: MainMessage }) => {
    if (e.data.type === "stop") void stop(0);
  });
  try {
    await runner.start();
  } catch (e) {
    send({ type: "failed", error: `cannot start runner: ${(e as Error).message}` });
    await stop(1);
  }
  consoleLogger.info(`runner ${saved.runnerId} connected to room ${saved.roomId}`);
  send({ type: "running" });
}

main().catch((e: Error) => {
  send({ type: "failed", error: e.message });
  process.exit(1);
});

// Entry of the utility process hosting one room's runner, so a runner crash or a busy runner
// never affects the window. Started with the room id as its only argument.
import { acquireRunnerLock, readSavedRunner, roomDir } from "@banyan/runner/registration";
import { consoleLogger } from "@banyan/runner/logger";
import { Runner } from "@banyan/runner/runner";
import type { HostMessage, MainMessage, TerminalArgs, TerminalPortMessage } from "./host-protocol.ts";

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
  const terminalArgs = process.env.BANYAN_TERMINAL_ARGS ? (JSON.parse(process.env.BANYAN_TERMINAL_ARGS) as TerminalArgs) : undefined;
  const runner = new Runner({ ...saved, roomDir: dir, monitorIntervalMs: MONITOR_INTERVAL_MS, ...(terminalArgs ? { terminalArgs } : {}) }, consoleLogger);
  const stop = async (code: number) => {
    await runner.stop();
    releaseLock();
    process.exit(code);
  };
  port.on("message", (e: { data: MainMessage; ports: Electron.MessagePortMain[] }) => {
    if (e.data.type === "stop") void stop(0);
    else if (e.data.type === "terminal" && e.ports[0]) connectTerminal(runner, e.data.agentId, e.ports[0]);
    else if (e.data.type === "terminal-args") runner.setTerminalArgs(e.data.args);
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

// Streams an agent's terminal to a page over the port: output one way, keystrokes and size
// changes the other.
function connectTerminal(runner: Runner, agentId: string, view: Electron.MessagePortMain): void {
  const post = (msg: TerminalPortMessage) => view.postMessage(msg);
  const terminal = runner.terminal(agentId);
  if (!terminal) {
    post({ type: "closed", reason: "this agent has no running terminal on this machine" });
    view.close();
    return;
  }
  const attached = terminal.attach(
    (data) => post({ type: "data", data }),
    (detail) => {
      post({ type: "closed", reason: detail });
      view.close();
    },
  );
  if (attached.backlog) post({ type: "data", data: attached.backlog });
  view.on("message", (e: { data: TerminalPortMessage }) => {
    const msg = e.data;
    if (msg.type === "input") terminal.write(msg.data);
    else if (msg.type === "resize") terminal.resize(msg.cols, msg.rows);
    else if (msg.type === "close") {
      attached.detach();
      view.close();
    }
  });
  view.on("close", () => attached.detach());
  view.start();
}

main().catch((e: Error) => {
  send({ type: "failed", error: e.message });
  process.exit(1);
});

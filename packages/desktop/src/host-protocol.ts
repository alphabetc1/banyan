// Messages between the main process and a runner host utility process.

// "failed" means retrying cannot help, e.g. another runner already holds the room.
export type HostMessage = { type: "running" } | { type: "failed"; error: string };

// "terminal" comes with a MessagePort to the page that shows the agent's terminal.
export type MainMessage = { type: "stop" } | { type: "terminal"; agentId: string };

// Over a terminal port: the page sends input, resize and close; the runner sends data and
// closed.
export type TerminalPortMessage =
  | { type: "input"; data: string }
  | { type: "resize"; cols: number; rows: number }
  | { type: "close" }
  | { type: "data"; data: string }
  | { type: "closed"; reason: string };

// Messages between the main process and a runner host utility process.

// "failed" means retrying cannot help, e.g. another runner already holds the room.
export type HostMessage = { type: "running" } | { type: "failed"; error: string };

export type MainMessage = { type: "stop" };

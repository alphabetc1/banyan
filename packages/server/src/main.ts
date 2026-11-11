// Room server entry point. Bind BANYAN_HOST to the tailnet address in deployment.
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { buildApp } from "./app.ts";

const host = process.env.BANYAN_HOST ?? "127.0.0.1";
const port = Number(process.env.BANYAN_PORT ?? "7700");
const dbPath = process.env.BANYAN_DB ?? "banyan.sqlite";
const webDir = process.env.BANYAN_WEB_DIR ?? fileURLToPath(new URL("../../web/dist", import.meta.url));

const app = await buildApp({ dbPath, logger: true, ...(existsSync(webDir) ? { webDir } : {}) });
await app.listen({ host, port });

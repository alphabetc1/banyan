// Room server entry point. It binds to localhost by default; expose it on the tailnet with
// `tailscale serve` rather than binding to a public interface.
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { buildApp } from "./app.ts";

const host = process.env.BANYAN_HOST ?? "127.0.0.1";
const port = Number(process.env.BANYAN_PORT ?? "7700");
const dbPath = process.env.BANYAN_DB ?? "banyan.sqlite";
const webDir = process.env.BANYAN_WEB_DIR ?? fileURLToPath(new URL("../../web/dist", import.meta.url));

const app = await buildApp({ dbPath, logger: true, ...(existsSync(webDir) ? { webDir } : {}) });
await app.listen({ host, port });

// Close connections and the database cleanly when the service manager stops us.
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.once(signal, () => {
    app.log.info(`received ${signal}, shutting down`);
    void app.close().then(() => process.exit(0));
  });
}

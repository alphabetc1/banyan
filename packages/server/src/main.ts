// Room server entry point. Bind BANYAN_HOST to the tailnet address in deployment.
import { buildApp } from "./app.ts";

const host = process.env.BANYAN_HOST ?? "127.0.0.1";
const port = Number(process.env.BANYAN_PORT ?? "7700");
const dbPath = process.env.BANYAN_DB ?? "banyan.sqlite";

const app = await buildApp({ dbPath, logger: true });
await app.listen({ host, port });

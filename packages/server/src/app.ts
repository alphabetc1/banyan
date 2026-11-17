// HTTP + WebSocket API of the room server.
import { readFileSync } from "node:fs";
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import fastifyStatic from "@fastify/static";
import fastifyWebsocket from "@fastify/websocket";
import { z } from "zod";
import { ClientMessage, draft, newId, type Actor, type ServerMessage } from "@banyan/shared";
import { Rooms } from "./rooms.ts";
import { Store, type TokenGrant } from "./store.ts";

// The UI loads only its own bundled assets and talks only to this server (including its
// WebSocket); inline styles come from React style props.
const WEB_CSP = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'";

const INVITE_TTL_MS = 7 * 24 * 3600 * 1000;
const TRANSCRIPT_PAGE_MAX = 200;

export interface AppOptions {
  dbPath: string;
  // Built web UI to serve; API routes keep precedence and unknown paths fall back to index.html.
  webDir?: string;
  // Desktop client distribution: /install.sh and the installers under /downloads/.
  desktop?: { installScript: string; downloadsDir: string };
  logger?: boolean;
  now?: () => number;
}

// A room without repoUrl and baseBranch has no shared fork, like a local workspace.
const CreateRoomBody = z
  .object({
    name: z.string().min(1).max(200),
    repoUrl: z.string().min(1).max(500).nullable().default(null),
    baseBranch: z.string().min(1).max(200).nullable().default(null),
    goalTitle: z.string().min(1).max(500),
    goalDescription: z.string().max(20_000).default(""),
    ownerName: z.string().min(1).max(100),
  })
  .refine((b) => (b.repoUrl === null) === (b.baseBranch === null), { message: "repoUrl and baseBranch go together" });
const JoinBody = z.object({ inviteToken: z.string().min(1), displayName: z.string().min(1).max(100) });
const RunnerBody = z.object({ hostname: z.string().min(1).max(200) });
const RoomParams = z.object({ roomId: z.string().min(1) });
const TranscriptParams = z.object({ roomId: z.string().min(1), agentId: z.string().min(1) });
const TranscriptQuery = z.object({
  beforeSeq: z.coerce.number().int().positive().default(Number.MAX_SAFE_INTEGER),
  limit: z.coerce.number().int().positive().max(TRANSCRIPT_PAGE_MAX).default(50),
});
const WsQuery = z.object({ token: z.string().min(1) });

function bearer(req: FastifyRequest): string | null {
  const header = req.headers.authorization;
  return header?.startsWith("Bearer ") ? header.slice("Bearer ".length) : null;
}

export async function buildApp(opts: AppOptions): Promise<FastifyInstance> {
  const now = opts.now ?? Date.now;
  const store = new Store(opts.dbPath);
  const rooms = new Rooms(store, now);
  const app = Fastify({
    logger: opts.logger
      ? {
          // Strip query strings so WebSocket tokens never reach the logs.
          serializers: { req: (req) => ({ method: req.method, url: req.url.split("?")[0] }) },
        }
      : false,
  });
  await app.register(fastifyWebsocket);
  if (opts.webDir) {
    await app.register(fastifyStatic, { root: opts.webDir, setHeaders: (reply) => reply.header("content-security-policy", WEB_CSP) });
    app.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith("/api/")) return reply.code(404).send({ error: "not found" });
      return reply.sendFile("index.html");
    });
  }
  if (opts.desktop) {
    const { installScript, downloadsDir } = opts.desktop;
    app.get("/install.sh", async (_req, reply) => reply.type("text/x-shellscript; charset=utf-8").send(readFileSync(installScript, "utf8")));
    await app.register(fastifyStatic, {
      root: downloadsDir,
      prefix: "/downloads/",
      decorateReply: false,
      index: false,
      // Only the installers, not build leftovers next to them.
      allowedPath: (pathName) => /^\/Banyan-(x64|arm64)\.dmg$/.test(pathName),
    });
  }
  app.addHook("onClose", async () => store.close());

  // Resolves a token for this room, restricted to the allowed kinds; replies 401 otherwise.
  function authenticate(req: FastifyRequest, reply: FastifyReply, roomId: string, token: string | null, kinds: TokenGrant["kind"][]): TokenGrant | null {
    const grant = token ? store.verifyToken(token, now()) : null;
    if (!grant || grant.roomId !== roomId || !kinds.includes(grant.kind)) {
      void reply.code(401).send({ error: "unauthorized" });
      return null;
    }
    return grant;
  }

  function badRequest(reply: FastifyReply, error: z.ZodError): void {
    void reply.code(400).send({ error: z.prettifyError(error) });
  }

  // Liveness probe for service managers and monitoring.
  app.get("/api/health", async () => ({ ok: true }));

  app.post("/api/rooms", async (req, reply) => {
    const body = CreateRoomBody.safeParse(req.body);
    if (!body.success) return badRequest(reply, body.error);
    const roomId = newId();
    const memberId = newId();
    const b = body.data;
    rooms.append(roomId, { kind: "system" }, [
      draft("room.created", { name: b.name, repoUrl: b.repoUrl, baseBranch: b.baseBranch, rootGoalId: newId(), rootGoalTitle: b.goalTitle, rootGoalDescription: b.goalDescription }),
      draft("member.joined", { memberId, displayName: b.ownerName, role: "owner" }),
    ]);
    const memberToken = store.issueToken({ kind: "member", roomId, subjectId: memberId }, null);
    const inviteToken = store.issueToken({ kind: "invite", roomId, subjectId: memberId }, now() + INVITE_TTL_MS);
    return { roomId, memberId, memberToken, inviteToken };
  });

  app.post("/api/rooms/:roomId/invites", async (req, reply) => {
    const { roomId } = RoomParams.parse(req.params);
    const grant = authenticate(req, reply, roomId, bearer(req), ["member"]);
    if (!grant) return;
    const inviteToken = store.issueToken({ kind: "invite", roomId, subjectId: grant.subjectId }, now() + INVITE_TTL_MS);
    return { inviteToken };
  });

  app.post("/api/rooms/:roomId/join", async (req, reply) => {
    const { roomId } = RoomParams.parse(req.params);
    const body = JoinBody.safeParse(req.body);
    if (!body.success) return badRequest(reply, body.error);
    if (!authenticate(req, reply, roomId, body.data.inviteToken, ["invite"])) return;
    const memberId = newId();
    rooms.append(roomId, { kind: "system" }, [draft("member.joined", { memberId, displayName: body.data.displayName, role: "member" })]);
    const memberToken = store.issueToken({ kind: "member", roomId, subjectId: memberId }, null);
    return { memberId, memberToken };
  });

  app.post("/api/rooms/:roomId/runners", async (req, reply) => {
    const { roomId } = RoomParams.parse(req.params);
    const grant = authenticate(req, reply, roomId, bearer(req), ["member"]);
    if (!grant) return;
    const body = RunnerBody.safeParse(req.body);
    if (!body.success) return badRequest(reply, body.error);
    const runnerId = newId();
    rooms.append(roomId, { kind: "system" }, [draft("runner.registered", { runnerId, memberId: grant.subjectId, hostname: body.data.hostname })]);
    const runnerToken = store.issueToken({ kind: "runner", roomId, subjectId: runnerId }, null);
    return { runnerId, runnerToken };
  });

  app.get("/api/rooms/:roomId/state", async (req, reply) => {
    const { roomId } = RoomParams.parse(req.params);
    if (!authenticate(req, reply, roomId, bearer(req), ["member", "runner"])) return;
    return { state: rooms.state(roomId) };
  });

  app.get("/api/rooms/:roomId/agents/:agentId/transcript", async (req, reply) => {
    const { roomId, agentId } = TranscriptParams.parse(req.params);
    if (!authenticate(req, reply, roomId, bearer(req), ["member"])) return;
    const query = TranscriptQuery.safeParse(req.query);
    if (!query.success) return badRequest(reply, query.error);
    return { events: store.transcriptBefore(roomId, agentId, query.data.beforeSeq, query.data.limit) };
  });

  // Browsers cannot set headers on WebSocket requests, so the token travels in the query string.
  app.get("/api/rooms/:roomId/ws", { websocket: true }, (socket, req) => {
    const send = (msg: ServerMessage) => socket.send(JSON.stringify(msg));
    const { roomId } = RoomParams.parse(req.params);
    const query = WsQuery.safeParse(req.query);
    const grant = query.success ? store.verifyToken(query.data.token, now()) : null;
    if (!grant || grant.roomId !== roomId || (grant.kind !== "member" && grant.kind !== "runner")) {
      send({ type: "error", error: "unauthorized" });
      socket.close(4401, "unauthorized");
      return;
    }
    let unsubscribe: (() => void) | null = null;
    let unsubscribePresence: (() => void) | null = null;
    const releaseRunner = grant.kind === "runner" ? rooms.runnerConnected(roomId, grant.subjectId) : null;
    socket.on("close", () => {
      unsubscribe?.();
      unsubscribePresence?.();
      releaseRunner?.();
    });

    socket.on("message", (raw) => {
      let parsed: ReturnType<typeof ClientMessage.safeParse>;
      try {
        parsed = ClientMessage.safeParse(JSON.parse(raw.toString()));
      } catch {
        send({ type: "error", error: "invalid JSON" });
        return;
      }
      if (!parsed.success) {
        send({ type: "error", error: z.prettifyError(parsed.error) });
        return;
      }
      const msg = parsed.data;
      if (msg.type === "subscribe") {
        unsubscribe?.();
        unsubscribe = rooms.subscribe(roomId, msg.afterSeq, (events) => send({ type: "events", events }));
        unsubscribePresence ??= rooms.onPresence(roomId, (onlineRunnerIds) => send({ type: "presence", onlineRunnerIds }));
        return;
      }
      const actor = resolveActor(grant, msg.asAgent);
      if (typeof actor === "string") {
        send({ type: "append_result", requestId: msg.requestId, results: msg.drafts.map((d) => ({ eventId: d.eventId, ok: false, error: actor })) });
        return;
      }
      send({ type: "append_result", requestId: msg.requestId, results: rooms.append(roomId, actor, msg.drafts) });
    });
  });

  // Members act as themselves; runners act as themselves or as an agent they host.
  function resolveActor(grant: TokenGrant, asAgent: string | undefined): Actor | string {
    if (grant.kind === "member") return asAgent === undefined ? { kind: "member", id: grant.subjectId } : "members may not act as agents";
    if (asAgent === undefined) return { kind: "runner", id: grant.subjectId };
    const agent = rooms.state(grant.roomId).agents[asAgent];
    if (!agent || agent.runnerId !== grant.subjectId) return "runner does not host this agent";
    return { kind: "agent", id: asAgent };
  }

  return app;
}

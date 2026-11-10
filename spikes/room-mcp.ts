// Minimal Room MCP over Streamable HTTP, shared by the Claude and Codex spikes.
// Each agent gets its own URL path (/mcp/<agentId>) so identity is bound by the
// host process, never claimed by the agent itself.
import { createServer, type Server } from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";

export interface StatusCall {
  agentId: string;
  phase: string;
  note: string | undefined;
}

export interface RoomMcp {
  url(agentId: string): string;
  calls: StatusCall[];
  close(): Promise<void>;
}

function buildServer(agentId: string, calls: StatusCall[]): McpServer {
  const server = new McpServer({ name: "banyan-room", version: "0.0.0" });
  server.registerTool(
    "room_set_status",
    {
      description: "Report your current work phase to the room.",
      inputSchema: { phase: z.string(), note: z.string().optional() },
    },
    async ({ phase, note }) => {
      calls.push({ agentId, phase, note });
      return { content: [{ type: "text", text: `status recorded for ${agentId}` }] };
    },
  );
  return server;
}

export async function startRoomMcp(): Promise<RoomMcp> {
  const calls: StatusCall[] = [];
  const http: Server = createServer(async (req, res) => {
    const match = req.url?.match(/^\/mcp\/([\w-]+)$/);
    if (!match) {
      res.writeHead(404).end();
      return;
    }
    // Stateless mode: a fresh server + transport per request keeps the spike simple.
    const server = buildServer(match[1], calls);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on("close", () => {
      void transport.close();
      void server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res);
  });
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
  const address = http.address();
  if (address === null || typeof address === "string") throw new Error("unexpected listen address");
  const port = address.port;
  return {
    url: (agentId) => `http://127.0.0.1:${port}/mcp/${agentId}`,
    calls,
    close: () => new Promise((resolve) => http.close(() => resolve())),
  };
}

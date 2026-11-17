// The environment agent CLIs run with: the runner's own, adjusted so Banyan's local endpoints
// (Room MCP, hooks) stay reachable and the agent keeps its own session.

// Loopback addresses Banyan's endpoints listen on.
const LOOPBACK = ["127.0.0.1", "localhost"];

// Variables a parent Claude Code session sets for its own children. Inherited, they make the
// agent's Claude Code consider itself a child session and skip saving its transcript, which
// would make the session impossible to resume.
function isParentSessionMarker(key: string): boolean {
  return key === "CLAUDECODE" || key === "CLAUDE_PID" || key === "CLAUDE_EFFORT" || /^CLAUDE_CODE_(ENTRYPOINT|EXECPATH|CHILD_SESSION|SESSION_|BRIDGE_|MESSAGING_)/.test(key);
}

export function agentEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined && !isParentSessionMarker(key)) out[key] = value;
  }
  // Codex sends even loopback requests through the macOS system proxy, ignoring its exception
  // list, and a proxy such as Clash then answers the Room MCP with HTTP 502. An explicit
  // no-proxy list keeps loopback traffic direct; entries already set are kept.
  const existing = (out.NO_PROXY ?? out.no_proxy ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  const noProxy = [...existing, ...LOOPBACK.filter((h) => !existing.includes(h))].join(",");
  out.NO_PROXY = noProxy;
  out.no_proxy = noProxy;
  return out;
}

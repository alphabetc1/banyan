import { describe, expect, it } from "vitest";
import { agentEnv } from "../src/agent-env.ts";

describe("agent environment", () => {
  it("drops the markers of a parent Claude Code session and keeps everything else", () => {
    const env = agentEnv({
      PATH: "/usr/bin",
      CLAUDECODE: "1",
      CLAUDE_PID: "42",
      CLAUDE_CODE_CHILD_SESSION: "1",
      CLAUDE_CODE_SESSION_ID: "s",
      CLAUDE_CODE_ENTRYPOINT: "cli",
      CLAUDE_CODE_USE_BEDROCK: "1",
      ANTHROPIC_MODEL: "x",
      UNSET: undefined,
    });
    expect(env).toEqual({ PATH: "/usr/bin", CLAUDE_CODE_USE_BEDROCK: "1", ANTHROPIC_MODEL: "x", NO_PROXY: "127.0.0.1,localhost", no_proxy: "127.0.0.1,localhost" });
  });

  it("adds loopback to an existing no-proxy list without duplicates", () => {
    expect(agentEnv({ no_proxy: "corp.internal, localhost" })).toMatchObject({ NO_PROXY: "corp.internal,localhost,127.0.0.1", no_proxy: "corp.internal,localhost,127.0.0.1" });
    expect(agentEnv({ NO_PROXY: "127.0.0.1,localhost" })).toMatchObject({ NO_PROXY: "127.0.0.1,localhost" });
  });
});

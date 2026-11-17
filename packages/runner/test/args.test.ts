import { describe, expect, it } from "vitest";
import { splitArgs, terminalArgsFromEnv } from "../src/args.ts";

describe("splitArgs", () => {
  it("splits on whitespace and keeps quoted parts together", () => {
    expect(splitArgs("--yolo  --sandbox danger-full-access")).toEqual(["--yolo", "--sandbox", "danger-full-access"]);
    expect(splitArgs(`-c 'model="o3"' --name "two words" a\\ b ""`)).toEqual(["-c", 'model="o3"', "--name", "two words", "a b", ""]);
    expect(splitArgs('"say \\"hi\\""')).toEqual(['say "hi"']);
    expect(splitArgs("   ")).toEqual([]);
  });

  it("rejects an unclosed quote", () => {
    expect(() => splitArgs("--model 'opus")).toThrow("unclosed ' in: --model 'opus");
  });

  it("reads a command-line runner's terminal arguments from the environment", () => {
    expect(terminalArgsFromEnv({})).toBeUndefined();
    expect(terminalArgsFromEnv({ BANYAN_CODEX_ARGS: "--yolo --sandbox danger-full-access" })).toEqual({ claude: [], codex: ["--yolo", "--sandbox", "danger-full-access"] });
    expect(terminalArgsFromEnv({ BANYAN_CLAUDE_ARGS: "--dangerously-skip-permissions", BANYAN_CODEX_ARGS: "" })).toEqual({ claude: ["--dangerously-skip-permissions"], codex: [] });
  });
});

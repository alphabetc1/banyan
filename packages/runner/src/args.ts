// Command-line arguments typed as one line, split the way a shell would: on whitespace, with
// single and double quotes grouping and a backslash escaping the next character.
export function splitArgs(line: string): string[] {
  const args: string[] = [];
  let current = "";
  let inArg = false;
  let quote: "'" | '"' | null = null;
  for (let i = 0; i < line.length; i++) {
    const c = line[i]!;
    if (quote) {
      if (c === quote) quote = null;
      else if (c === "\\" && quote === '"' && i + 1 < line.length) current += line[++i];
      else current += c;
    } else if (c === "'" || c === '"') {
      quote = c;
      inArg = true;
    } else if (c === "\\" && i + 1 < line.length) {
      current += line[++i];
      inArg = true;
    } else if (/\s/.test(c)) {
      if (inArg) args.push(current);
      current = "";
      inArg = false;
    } else {
      current += c;
      inArg = true;
    }
  }
  if (quote) throw new Error(`unclosed ${quote} in: ${line}`);
  if (inArg) args.push(current);
  return args;
}

// Extra arguments for terminal sessions from BANYAN_CLAUDE_ARGS and BANYAN_CODEX_ARGS, for a
// runner started from the command line; none when neither is set.
export function terminalArgsFromEnv(env: NodeJS.ProcessEnv): { claude: string[]; codex: string[] } | undefined {
  if (env.BANYAN_CLAUDE_ARGS === undefined && env.BANYAN_CODEX_ARGS === undefined) return undefined;
  return { claude: splitArgs(env.BANYAN_CLAUDE_ARGS ?? ""), codex: splitArgs(env.BANYAN_CODEX_ARGS ?? "") };
}

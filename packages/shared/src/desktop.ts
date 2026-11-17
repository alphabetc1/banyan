// Contract between the web UI and the desktop client, exposed by the client's preload script
// as window.banyanDesktop. Absent in a plain browser.

// starting: the runner process is connecting; error: it failed to start or crashed, and stays
// stopped until the user starts it again.
export type LocalRunnerState = "starting" | "running" | "error";

export interface LocalRunnerStatus {
  roomId: string;
  // The runner's id in the room, so a page can tell which agents run on this machine.
  runnerId: string | null;
  state: LocalRunnerState;
  error?: string;
}

export interface TerminalArgsLines {
  claude: string;
  codex: string;
}

// A page's connection to the terminal of an agent running on this machine.
export interface TerminalConnection {
  write(data: string): void;
  resize(cols: number, rows: number): void;
  close(): void;
}

export interface DesktopBridge {
  listRunners(): Promise<LocalRunnerStatus[]>;
  // Registers a runner for this machine on first use, then starts it now and on every launch.
  // Also starts it again after an error.
  enableRunner(roomId: string, memberToken: string): Promise<void>;
  disableRunner(roomId: string): Promise<void>;
  onRunnersChanged(listener: (runners: LocalRunnerStatus[]) => void): () => void;
  setServerUrl(url: string): Promise<void>;
  // Credentials of the client's own local workspace; only given to pages it serves itself.
  localWorkspace(): Promise<{ roomId: string; roomName: string; memberId: string; memberToken: string } | null>;
  // Lets the person pick a folder on this machine, starting in startIn if given (the last one
  // used); resolves to the top level of its git repository when it is in one, to the folder
  // itself otherwise, or to null when cancelled.
  pickRepository(startIn: string | null): Promise<string | null>;
  openLocalWorkspace(): void;
  // Extra arguments for Claude Code and Codex terminals on this machine, as typed (one line
  // each), with the defaults. Saving applies to terminals started afterwards.
  terminalArgs(): Promise<{ current: TerminalArgsLines; defaults: TerminalArgsLines }>;
  setTerminalArgs(args: TerminalArgsLines): Promise<void>;
  // Saves an image the person pasted as a file on this machine and resolves to its path, which
  // Claude Code and Codex take as an image attachment when pasted into their terminal.
  saveImage(data: ArrayBuffer, type: string): Promise<string>;
  // The path on this machine of a file dropped onto the page.
  pathForFile(file: File): string;
  // Connects to the terminal of a terminal-mode agent hosted by this machine's runner for the
  // room. onData first receives recent output, then every new chunk; onClose fires when the
  // terminal is not available or goes away.
  openTerminal(roomId: string, agentId: string, onData: (data: string) => void, onClose: (reason: string) => void): TerminalConnection;
  // Shows the page for connecting to a team room server.
  openTeamServer(): void;
  // Shows a system notification; clicking it brings the window to the given in-app path.
  notify(title: string, body: string, path: string): void;
}

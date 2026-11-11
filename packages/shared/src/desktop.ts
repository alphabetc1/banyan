// Contract between the web UI and the desktop client, exposed by the client's preload script
// as window.banyanDesktop. Absent in a plain browser.

// starting: the runner process is connecting; error: it failed to start or crashed, and stays
// stopped until the user starts it again.
export type LocalRunnerState = "starting" | "running" | "error";

export interface LocalRunnerStatus {
  roomId: string;
  state: LocalRunnerState;
  error?: string;
}

export interface DesktopBridge {
  listRunners(): Promise<LocalRunnerStatus[]>;
  // Registers a runner for this machine on first use, then starts it now and on every launch.
  // Also starts it again after an error.
  enableRunner(roomId: string, memberToken: string): Promise<void>;
  disableRunner(roomId: string): Promise<void>;
  onRunnersChanged(listener: (runners: LocalRunnerStatus[]) => void): () => void;
  setServerUrl(url: string): Promise<void>;
  // Shows a system notification; clicking it brings the window to the given in-app path.
  notify(title: string, body: string, path: string): void;
}

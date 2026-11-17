// Client settings kept in the app's user data directory: the team room server, the local
// workspace, which one was open last, and which rooms run a runner on this machine.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { LocalWorkspace } from "./local-workspace.ts";

export interface Settings {
  serverUrl: string | null;
  localWorkspace: LocalWorkspace | null;
  lastOpened: "local" | "team";
  enabledRooms: string[];
}

const DEFAULTS: Settings = { serverUrl: null, localWorkspace: null, lastOpened: "local", enabledRooms: [] };

export class SettingsFile {
  private value: Settings;

  constructor(private readonly path: string) {
    this.value = existsSync(path) ? { ...DEFAULTS, ...(JSON.parse(readFileSync(path, "utf8")) as Partial<Settings>) } : { ...DEFAULTS };
  }

  get(): Settings {
    return this.value;
  }

  update(patch: Partial<Settings>): void {
    this.value = { ...this.value, ...patch };
    mkdirSync(dirname(this.path), { recursive: true });
    // Write then rename so a crash never leaves a half-written file.
    writeFileSync(`${this.path}.tmp`, JSON.stringify(this.value, null, 2));
    renameSync(`${this.path}.tmp`, this.path);
  }
}

// Accepts a bare host:port or a full URL and returns the origin, e.g. http://host:7700.
export function normalizeServerUrl(input: string): string {
  const trimmed = input.trim();
  const url = new URL(/^[a-z]+:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`);
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error(`unsupported server URL: ${input}`);
  return url.origin;
}

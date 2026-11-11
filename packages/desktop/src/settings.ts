// Client settings kept in the app's user data directory: which room server to show and which
// rooms run a runner on this machine.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export interface Settings {
  serverUrl: string | null;
  enabledRooms: string[];
}

export class SettingsFile {
  private value: Settings;

  constructor(private readonly path: string) {
    this.value = existsSync(path) ? { serverUrl: null, enabledRooms: [], ...(JSON.parse(readFileSync(path, "utf8")) as Partial<Settings>) } : { serverUrl: null, enabledRooms: [] };
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

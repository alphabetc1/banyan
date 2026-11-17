// Images pasted into an agent's terminal, kept as files: a terminal carries only text, and both
// Claude Code and Codex attach an image when its file path is pasted in.
import { randomUUID } from "node:crypto";
import { mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const EXTENSIONS: Record<string, string> = { "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif", "image/webp": "webp" };
const MAX_BYTES = 20 * 1024 * 1024;
// Old enough that no session is still about to read it.
const KEEP_MS = 7 * 24 * 3600 * 1000;

export function savePastedImage(dir: string, data: ArrayBuffer, type: string): string {
  const ext = EXTENSIONS[type];
  if (!ext) throw new Error(`unsupported image type: ${type}`);
  if (data.byteLength > MAX_BYTES) throw new Error(`image too large: ${data.byteLength} bytes`);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${randomUUID()}.${ext}`);
  writeFileSync(path, new Uint8Array(data));
  return path;
}

export function removeOldPastedImages(dir: string, now = Date.now()): void {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of names) {
    const path = join(dir, name);
    if (now - statSync(path).mtimeMs > KEEP_MS) rmSync(path, { force: true });
  }
}

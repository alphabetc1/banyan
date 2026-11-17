import { existsSync, mkdtempSync, readFileSync, readdirSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { removeOldPastedImages, savePastedImage } from "../src/pasted-images.ts";

const dir = () => join(mkdtempSync(join(tmpdir(), "banyan-images-")), "pasted");

describe("pasted images", () => {
  it("saves an image under a fresh name with its type's extension", () => {
    const d = dir();
    const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
    const a = savePastedImage(d, bytes.buffer, "image/png");
    const b = savePastedImage(d, bytes.buffer, "image/jpeg");
    expect(a).toMatch(/\/pasted\/[0-9a-f-]{36}\.png$/);
    expect(b).toMatch(/\.jpg$/);
    expect([...readFileSync(a)]).toEqual([...bytes]);
  });

  it("refuses what is not a supported image or is too large", () => {
    expect(() => savePastedImage(dir(), new ArrayBuffer(4), "text/html")).toThrow("unsupported image type: text/html");
    expect(() => savePastedImage(dir(), new ArrayBuffer(21 * 1024 * 1024), "image/png")).toThrow("image too large");
  });

  it("removes images older than a week and keeps recent ones", () => {
    const d = dir();
    const old = savePastedImage(d, new ArrayBuffer(1), "image/png");
    const recent = savePastedImage(d, new ArrayBuffer(1), "image/png");
    const eightDaysAgo = (Date.now() - 8 * 24 * 3600 * 1000) / 1000;
    utimesSync(old, eightDaysAgo, eightDaysAgo);
    removeOldPastedImages(d);
    expect(existsSync(old)).toBe(false);
    expect(readdirSync(d)).toEqual([recent.split("/").pop()]);
    removeOldPastedImages(join(d, "missing"));
  });
});

import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { normalizeServerUrl, SettingsFile } from "../src/settings.ts";

const tempPath = () => join(mkdtempSync(join(tmpdir(), "banyan-desktop-")), "nested", "settings.json");

describe("settings", () => {
  it("starts empty and persists updates across instances", () => {
    const path = tempPath();
    const first = new SettingsFile(path);
    expect(first.get()).toEqual({ serverUrl: null, enabledRooms: [] });
    first.update({ serverUrl: "http://host:7700" });
    first.update({ enabledRooms: ["r1"] });
    expect(new SettingsFile(path).get()).toEqual({ serverUrl: "http://host:7700", enabledRooms: ["r1"] });
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ serverUrl: "http://host:7700", enabledRooms: ["r1"] });
    expect(existsSync(`${path}.tmp`)).toBe(false);
  });

  it("normalizes server addresses to an origin", () => {
    expect(normalizeServerUrl(" banyan-host:7700 ")).toBe("http://banyan-host:7700");
    expect(normalizeServerUrl("http://banyan-host:7700/rooms/x")).toBe("http://banyan-host:7700");
    expect(normalizeServerUrl("https://banyan.example.ts.net/")).toBe("https://banyan.example.ts.net");
    expect(() => normalizeServerUrl("ftp://host")).toThrow("unsupported server URL: ftp://host");
    expect(() => normalizeServerUrl("http://")).toThrow();
  });
});

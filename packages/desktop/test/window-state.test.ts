import { describe, expect, it } from "vitest";
import { restorableBounds } from "../src/window-state.ts";

const laptop = { x: 0, y: 25, width: 1440, height: 875 };
// A second display to the right of the laptop.
const external = { x: 1440, y: 0, width: 2560, height: 1440 };

describe("window bounds", () => {
  it("opens where the window was while a screen still shows its title bar", () => {
    const saved = { x: 2000, y: 200, width: 1200, height: 800 };
    expect(restorableBounds(saved, [laptop, external])).toEqual(saved);
    // Partly off screen is fine as long as enough of the title bar can be grabbed.
    expect(restorableBounds({ x: -1100, y: 100, width: 1280, height: 840 }, [laptop])).toEqual({ x: -1100, y: 100, width: 1280, height: 840 });
  });

  it("falls back to the default place when the window would be out of reach", () => {
    expect(restorableBounds(null, [laptop])).toBeNull();
    // The external display it was on is unplugged.
    expect(restorableBounds({ x: 2000, y: 200, width: 1200, height: 800 }, [laptop])).toBeNull();
    // Only a sliver of the title bar would show.
    expect(restorableBounds({ x: -1240, y: 100, width: 1280, height: 840 }, [laptop])).toBeNull();
    // The title bar would be above the top of the screen.
    expect(restorableBounds({ x: 100, y: -500, width: 1280, height: 840 }, [laptop])).toBeNull();
  });
});

// Where the window opens: where the person left it, as long as that place is still on a screen.
export interface WindowBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

// How much of the window's top edge must be on a screen for the person to grab and move it.
const GRABBABLE_WIDTH = 100;
const TITLE_BAR_HEIGHT = 32;

// The saved bounds, or null when no screen shows enough of the window's title bar, such as
// after the display it was on was unplugged.
export function restorableBounds(saved: WindowBounds | null, workAreas: WindowBounds[]): WindowBounds | null {
  if (!saved) return null;
  const titleBarVisible = workAreas.some((area) => {
    const width = Math.min(saved.x + saved.width, area.x + area.width) - Math.max(saved.x, area.x);
    const height = Math.min(saved.y + TITLE_BAR_HEIGHT, area.y + area.height) - Math.max(saved.y, area.y);
    return width >= GRABBABLE_WIDTH && height > 0;
  });
  return titleBarVisible ? saved : null;
}

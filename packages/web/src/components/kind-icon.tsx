// What kind of agent it is, as a small pixel mascot in the style of Dynamic Island companions:
// a terracotta creature for Claude Code, a cloud with a prompt for Codex, a monitor for a plain
// terminal. A mascot bobs while its agent works.
import type { Agent } from "@banyan/shared";
import { useT } from "../i18n.ts";

// One string per pixel row; each letter is a colour from the mascot's palette, "." is empty.
interface Mascot {
  rows: string[];
  palette: Record<string, string>;
}

const MASCOTS: Record<Agent["provider"], Mascot> = {
  claude: {
    rows: [
      "..OO.....OO..",
      ".OOOOOOOOOOO.",
      ".OOOOOOOOOOO.",
      ".OOKOOOOOKOO.",
      ".OOKOOOOOKOO.",
      "OOOOOOOOOOOOO",
      ".OOOOOOOOOOO.",
      ".OOOOOOOOOOO.",
      "..O.O...O.O..",
      "..O.O...O.O..",
    ],
    palette: { O: "#d97757", K: "#2b2924" },
  },
  codex: {
    rows: [
      "....BBBB.....",
      "..BBWWWWBB...",
      ".BWWWWWWWWBB.",
      "BWWKWWWWWWWWB",
      "BWWWKWWWWWWWB",
      "BWWKWWKKKWWWB",
      "BWWWWWWWWWWWB",
      ".BBBBBBBBBBB.",
    ],
    palette: { B: "#8f897d", W: "#f3f0e9", K: "#2b2924" },
  },
  shell: {
    rows: [
      "DDDDDDDDDDDDD",
      "DSSSSSSSSSSSD",
      "DSGSSSSSSSSSD",
      "DSSGSSSSSSSSD",
      "DSGSSGGGSSSSD",
      "DSSSSSSSSSSSD",
      "DDDDDDDDDDDDD",
      ".....DDD.....",
      "...DDDDDDD...",
    ],
    palette: { D: "#4a4842", S: "#24231f", G: "#7bc47f" },
  },
};

export function KindIcon({ kind, active = false }: { kind: Agent["provider"]; active?: boolean }) {
  const t = useT();
  const label = t(`dialog.kind.${kind}`);
  const { rows, palette } = MASCOTS[kind];
  const width = rows[0]!.length;
  return (
    <svg
      className={`kind-icon ${active ? "active" : ""}`}
      viewBox={`0 0 ${width} ${rows.length}`}
      width={width * 1.5}
      height={rows.length * 1.5}
      shapeRendering="crispEdges"
      role="img"
      aria-label={label}
      data-kind={kind}
    >
      <title>{label}</title>
      {rows.flatMap((row, y) => [...row].map((c, x) => (c === "." ? null : <rect key={`${x}-${y}`} x={x} y={y} width={1} height={1} fill={palette[c]} />)))}
    </svg>
  );
}

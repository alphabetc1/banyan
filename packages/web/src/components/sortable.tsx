// Reorders a vertical list split into sections by dragging a row. Within its own section the
// row follows the pointer and the others slide out of its way; over another section's row a
// line marks where it will land, and over a section's header it joins the end of that section.
// A press that does not move stays a click. Alt+Up/Down moves a focused row one place.
import { useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent } from "react";

// Movement before a press becomes a drag, so clicks still open the row.
const DRAG_THRESHOLD_PX = 4;

// Where a dragged row lands: next to targetId, or at the end of section when targetId is null.
export interface Drop {
  id: string;
  section: string;
  targetId: string | null;
  after: boolean;
}

interface Drag {
  id: string;
  from: number;
  over: number;
  // A section whose header the pointer is over.
  overHeader: string | null;
  dy: number;
  // Where each row started and how tall the dragged one is.
  tops: number[];
  height: number;
}

// ids are the visible rows from top to bottom across all sections.
export function useSortable(ids: string[], sectionOf: (id: string) => string, onDrop: (drop: Drop) => void) {
  const rows = useRef(new Map<string, HTMLElement>());
  const headers = useRef(new Map<string, HTMLElement>());
  const press = useRef<{ id: string; startY: number } | null>(null);
  const suppressClick = useRef(false);
  const [drag, setDrag] = useState<Drag | null>(null);

  const start = (id: string): Drag | null => {
    const from = ids.indexOf(id);
    const el = rows.current.get(id);
    if (from < 0 || !el) return null;
    const tops = ids.map((i) => rows.current.get(i)?.offsetTop ?? 0);
    return { id, from, over: from, overHeader: null, dy: 0, tops, height: el.offsetHeight };
  };

  const headerAt = (clientY: number): string | null => {
    for (const [section, el] of headers.current) {
      const r = el.getBoundingClientRect();
      if (clientY >= r.top && clientY <= r.bottom) return section;
    }
    return null;
  };

  const landing = (d: Drag): Drop | null => {
    if (d.overHeader !== null) return { id: d.id, section: d.overHeader, targetId: null, after: true };
    if (d.over === d.from) return null;
    const targetId = ids[d.over]!;
    return { id: d.id, section: sectionOf(targetId), targetId, after: d.over > d.from };
  };

  const rowProps = (id: string) => ({
    // Links would otherwise start the browser's own drag and cancel this one.
    draggable: false,
    ref: (el: HTMLElement | null) => {
      if (el) rows.current.set(id, el);
      else rows.current.delete(id);
    },
    onPointerDown: (e: PointerEvent<HTMLElement>) => {
      if (e.button !== 0) return;
      press.current = { id, startY: e.clientY };
    },
    onPointerMove: (e: PointerEvent<HTMLElement>) => {
      const p = press.current;
      if (!p || p.id !== id) return;
      const dy = e.clientY - p.startY;
      let current = drag;
      if (!current) {
        if (Math.abs(dy) < DRAG_THRESHOLD_PX) return;
        current = start(id);
        if (!current) return;
        e.currentTarget.setPointerCapture(e.pointerId);
      }
      // The slot whose middle the dragged row's middle has passed.
      const middle = current.tops[current.from]! + dy + current.height / 2;
      let over = current.from;
      while (over < ids.length - 1 && middle > current.tops[over + 1]! + current.height / 2) over++;
      while (over > 0 && middle < current.tops[over - 1]! + current.height / 2) over--;
      setDrag({ ...current, dy, over, overHeader: headerAt(e.clientY) });
    },
    onPointerUp: () => {
      press.current = null;
      if (!drag) return;
      suppressClick.current = true;
      const drop = landing(drag);
      setDrag(null);
      if (drop) onDrop(drop);
    },
    onPointerCancel: () => {
      press.current = null;
      setDrag(null);
    },
    onClickCapture: (e: React.MouseEvent) => {
      if (!suppressClick.current) return;
      suppressClick.current = false;
      e.preventDefault();
      e.stopPropagation();
    },
    onKeyDown: (e: KeyboardEvent<HTMLElement>) => {
      if (!e.altKey || (e.key !== "ArrowUp" && e.key !== "ArrowDown")) return;
      e.preventDefault();
      const from = ids.indexOf(id);
      const to = e.key === "ArrowUp" ? from - 1 : from + 1;
      const targetId = ids[to];
      if (targetId) onDrop({ id, section: sectionOf(targetId), targetId, after: to > from });
    },
    className: rowClass(id),
    style: rowStyle(id),
  });

  const headerProps = (section: string) => ({
    ref: (el: HTMLElement | null) => {
      if (el) headers.current.set(section, el);
      else headers.current.delete(section);
    },
  });

  // Marks the row the dragged one will land next to when it lands in another section.
  function rowClass(id: string): string {
    if (!drag || drag.overHeader !== null || drag.over === drag.from) return "";
    if (ids[drag.over] !== id || sectionOf(id) === sectionOf(drag.id)) return "";
    return drag.over > drag.from ? "drop-after" : "drop-before";
  }

  function rowStyle(id: string): CSSProperties {
    if (!drag) return {};
    if (id === drag.id) return { transform: `translateY(${drag.dy}px)`, zIndex: 2, position: "relative", transition: "none" };
    // Only the dragged row's own section makes room for it.
    const target = ids[drag.over]!;
    if (drag.overHeader !== null || sectionOf(target) !== sectionOf(drag.id) || sectionOf(id) !== sectionOf(drag.id)) return {};
    const index = ids.indexOf(id);
    // Rows between the dragged row's old and new place move one step towards its old place.
    let shift = 0;
    if (drag.from < drag.over && index > drag.from && index <= drag.over) shift = -drag.height;
    if (drag.from > drag.over && index < drag.from && index >= drag.over) shift = drag.height;
    return { transform: `translateY(${shift}px)` };
  }

  // The section a drag would land in, to highlight it.
  const dropSection = drag ? (landing(drag)?.section ?? null) : null;
  return { rowProps, headerProps, dragging: drag?.id ?? null, dropSection };
}

// Reorders a vertical list by dragging a row: the row follows the pointer and the others slide
// out of its way. A press that does not move stays a click. Alt+Up/Down moves a focused row.
import { useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent } from "react";

// Movement before a press becomes a drag, so clicks still open the row.
const DRAG_THRESHOLD_PX = 4;

interface Drag {
  id: string;
  from: number;
  over: number;
  dy: number;
  // Where each row started and how tall the dragged one is.
  tops: number[];
  height: number;
}

export function useSortable(ids: string[], onReorder: (ids: string[]) => void) {
  const rows = useRef(new Map<string, HTMLElement>());
  const press = useRef<{ id: string; startY: number } | null>(null);
  const suppressClick = useRef(false);
  const [drag, setDrag] = useState<Drag | null>(null);

  const move = (from: number, to: number) => {
    if (from === to) return;
    const next = [...ids];
    const [id] = next.splice(from, 1);
    next.splice(to, 0, id!);
    onReorder(next);
  };

  const start = (id: string): Drag | null => {
    const from = ids.indexOf(id);
    const el = rows.current.get(id);
    if (from < 0 || !el) return null;
    const tops = ids.map((i) => rows.current.get(i)?.offsetTop ?? 0);
    return { id, from, over: from, dy: 0, tops, height: el.offsetHeight };
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
      setDrag({ ...current, dy, over });
    },
    onPointerUp: () => {
      press.current = null;
      if (!drag) return;
      suppressClick.current = true;
      move(drag.from, drag.over);
      setDrag(null);
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
      const to = e.key === "ArrowUp" ? Math.max(0, from - 1) : Math.min(ids.length - 1, from + 1);
      move(from, to);
    },
    style: rowStyle(id),
  });

  function rowStyle(id: string): CSSProperties {
    if (!drag) return {};
    if (id === drag.id) return { transform: `translateY(${drag.dy}px)`, zIndex: 2, position: "relative", transition: "none" };
    const index = ids.indexOf(id);
    // Rows between the dragged row's old and new place move one step towards its old place.
    let shift = 0;
    if (drag.from < drag.over && index > drag.from && index <= drag.over) shift = -drag.height;
    if (drag.from > drag.over && index < drag.from && index >= drag.over) shift = drag.height;
    return { transform: `translateY(${shift}px)` };
  }

  return { rowProps, dragging: drag?.id ?? null };
}

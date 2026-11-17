// The person's own tags in the agent list, kept in this browser like the order of the list.
// A tag holds any number of agents; an agent sits in at most one tag, like a bookmark in a
// folder, and the rest of the agents are untagged.

export const TAG_COLORS = ["terracotta", "sage", "slate", "ochre", "plum", "gray"] as const;
export type TagColor = (typeof TAG_COLORS)[number];

export interface Tag {
  id: string;
  name: string;
  color: TagColor;
  collapsed: boolean;
}

export interface TagBoard {
  // In the order they are listed.
  tags: Tag[];
  // Agent id to tag id.
  tagOf: Record<string, string>;
}

export const EMPTY_BOARD: TagBoard = { tags: [], tagOf: {} };

const boardKey = (roomId: string) => `banyan.agentTags.${roomId}`;

function isTag(value: unknown): value is Tag {
  const t = value as Tag;
  return typeof t?.id === "string" && typeof t.name === "string" && TAG_COLORS.includes(t.color) && typeof t.collapsed === "boolean";
}

export function loadBoard(roomId: string): TagBoard {
  try {
    const raw = JSON.parse(localStorage.getItem(boardKey(roomId)) ?? "null") as Partial<TagBoard> | null;
    if (!raw || !Array.isArray(raw.tags) || typeof raw.tagOf !== "object" || raw.tagOf === null) return EMPTY_BOARD;
    return { tags: raw.tags.filter(isTag), tagOf: raw.tagOf };
  } catch {
    return EMPTY_BOARD;
  }
}

export function saveBoard(roomId: string, board: TagBoard): void {
  try {
    localStorage.setItem(boardKey(roomId), JSON.stringify(board));
  } catch {
    // Kept for this page view only.
  }
}

// The first colour no tag uses yet, or the next one round the palette once all are taken.
export function nextColor(board: TagBoard): TagColor {
  const used = new Set(board.tags.map((t) => t.color));
  return TAG_COLORS.find((c) => !used.has(c)) ?? TAG_COLORS[board.tags.length % TAG_COLORS.length]!;
}

export function addTag(board: TagBoard, tag: Tag): TagBoard {
  return { ...board, tags: [...board.tags, tag] };
}

export function updateTag(board: TagBoard, tagId: string, changes: Partial<Omit<Tag, "id">>): TagBoard {
  return { ...board, tags: board.tags.map((t) => (t.id === tagId ? { ...t, ...changes } : t)) };
}

// Its agents become untagged.
export function removeTag(board: TagBoard, tagId: string): TagBoard {
  return { tags: board.tags.filter((t) => t.id !== tagId), tagOf: Object.fromEntries(Object.entries(board.tagOf).filter(([, id]) => id !== tagId)) };
}

// tagId null takes the agent out of its tag.
export function setAgentTag(board: TagBoard, agentId: string, tagId: string | null): TagBoard {
  const { [agentId]: _, ...rest } = board.tagOf;
  return { ...board, tagOf: tagId === null ? rest : { ...rest, [agentId]: tagId } };
}

// The agent's tag, if it still exists.
export function tagOfAgent(board: TagBoard, agentId: string): Tag | null {
  const id = board.tagOf[agentId];
  return board.tags.find((t) => t.id === id) ?? null;
}

export interface TagSection<A> {
  // null for the untagged agents.
  tag: Tag | null;
  agents: A[];
}

// Every tag in order, empty ones included, then the untagged agents; agents keep the order
// they are given in.
export function tagSections<A extends { id: string }>(agents: A[], board: TagBoard): TagSection<A>[] {
  const known = new Set(board.tags.map((t) => t.id));
  const sections: TagSection<A>[] = board.tags.map((tag) => ({ tag, agents: agents.filter((a) => board.tagOf[a.id] === tag.id) }));
  sections.push({ tag: null, agents: agents.filter((a) => !known.has(board.tagOf[a.id] ?? "")) });
  return sections;
}

// The order with an id moved just before or just after another one.
export function placeNear(order: string[], id: string, targetId: string, after: boolean): string[] {
  const rest = order.filter((x) => x !== id);
  const at = rest.indexOf(targetId);
  if (at < 0) return [...rest, id];
  rest.splice(after ? at + 1 : at, 0, id);
  return rest;
}

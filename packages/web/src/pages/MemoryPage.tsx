// The room's memory: standing directives every agent follows, facts about the work, and the
// learnings agents proposed and a reviewer approved. Agents search it through the Room MCP;
// people add, edit and retire entries here.
import { useContext, useState } from "react";
import { draft, newId, type MemoryEntry, type MemoryKind } from "@banyan/shared";
import { timeAgo, useAction, useNow } from "../components/common.tsx";
import { useRoomStore } from "../contexts.ts";
import { actorName } from "../derive.ts";
import { LanguageContext, useT, type MessageKey } from "../i18n.ts";
import { useRoomVersion } from "../room-store.ts";

const SECTIONS: { kind: MemoryKind; label: MessageKey; explain: MessageKey }[] = [
  { kind: "directive", label: "memory.directives", explain: "memory.directivesExplain" },
  { kind: "fact", label: "memory.facts", explain: "memory.factsExplain" },
  { kind: "learning", label: "memory.learnings", explain: "memory.learningsExplain" },
];

function EntryCard({ entry }: { entry: MemoryEntry }) {
  const t = useT();
  const { lang } = useContext(LanguageContext);
  const store = useRoomStore();
  const now = useNow();
  const action = useAction();
  const [editing, setEditing] = useState<{ title: string; body: string } | null>(null);
  const state = store.state!;
  const source = entry.sourcePostId ? state.posts[entry.sourcePostId] : undefined;
  const save = (e: React.FormEvent) => {
    e.preventDefault();
    if (!editing) return;
    void action.run(() => store.append([draft("memory.updated", { entryId: entry.id, title: editing.title.trim(), body: editing.body })])).then((ok) => ok && setEditing(null));
  };
  if (editing) {
    return (
      <form className="post stack" onSubmit={save} data-testid={`memory-${entry.title}`}>
        <label>
          {t("memory.title")}
          <input required autoFocus maxLength={500} value={editing.title} onChange={(e) => setEditing({ ...editing, title: e.target.value })} />
        </label>
        <label>
          {t("memory.body")}
          <textarea rows={3} value={editing.body} onChange={(e) => setEditing({ ...editing, body: e.target.value })} />
        </label>
        {action.error && <span className="error">{action.error}</span>}
        <div className="row" style={{ justifyContent: "flex-end" }}>
          <button type="button" className="ghost" onClick={() => setEditing(null)}>
            {t("dialog.cancel")}
          </button>
          <button className="primary" disabled={action.busy || !editing.title.trim()}>
            {t("settings.save")}
          </button>
        </div>
      </form>
    );
  }
  return (
    <div className={`post ${entry.retired ? "retired" : ""}`} data-testid={`memory-${entry.title}`}>
      <div className="row">
        <strong style={{ flex: 1 }}>{entry.title}</strong>
        {!entry.retired && (
          <>
            <button className="ghost" disabled={action.busy} onClick={() => setEditing({ title: entry.title, body: entry.body })}>
              {t("memory.edit")}
            </button>
            <button className="ghost" disabled={action.busy} onClick={() => void action.run(() => store.append([draft("memory.retired", { entryId: entry.id })]))}>
              {t("memory.retire")}
            </button>
          </>
        )}
      </div>
      {entry.body && <div className="body">{entry.body}</div>}
      <div className="faint">
        {source && `${t("memory.from")} ${state.agents[source.agentId]?.name ?? source.agentId} · `}
        {actorName(state, entry.recordedBy)} · {timeAgo(entry.updatedAt, now, lang)}
      </div>
      {action.error && <span className="error">{action.error}</span>}
    </div>
  );
}

// People write directives and facts; learnings come from agents through review.
function AddEntry() {
  const t = useT();
  const store = useRoomStore();
  const action = useAction();
  const [kind, setKind] = useState<"directive" | "fact">("directive");
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    void action.run(() => store.append([draft("memory.recorded", { entryId: newId(), kind, title: title.trim(), body })])).then((ok) => {
      if (!ok) return;
      setTitle("");
      setBody("");
    });
  };
  return (
    <form className="panel stack" onSubmit={submit}>
      <div className="segmented" role="radiogroup" aria-label={t("memory.kind")}>
        {(["directive", "fact"] as const).map((k) => (
          <button key={k} type="button" role="radio" aria-checked={kind === k} className={kind === k ? "selected" : ""} onClick={() => setKind(k)}>
            {t(k === "directive" ? "memory.directive" : "memory.fact")}
          </button>
        ))}
      </div>
      <label>
        {t("memory.title")}
        <input required maxLength={500} value={title} onChange={(e) => setTitle(e.target.value)} />
      </label>
      <label>
        {t("memory.body")}
        <textarea rows={2} value={body} onChange={(e) => setBody(e.target.value)} />
      </label>
      {action.error && <span className="error">{action.error}</span>}
      <div className="row" style={{ justifyContent: "flex-end" }}>
        <button className="primary" disabled={action.busy || !title.trim()}>
          {t("memory.add")}
        </button>
      </div>
    </form>
  );
}

export function MemoryPage() {
  const t = useT();
  const store = useRoomStore();
  useRoomVersion(store);
  const [showRetired, setShowRetired] = useState(false);
  const entries = Object.values(store.state!.memory).sort((a, b) => a.recordedAt - b.recordedAt);
  const retired = entries.filter((e) => e.retired);
  return (
    <div className="memory stack">
      <AddEntry />
      {SECTIONS.map((s) => {
        const items = entries.filter((e) => e.kind === s.kind && !e.retired);
        return (
          <section key={s.kind} data-testid={`memory-section-${s.kind}`}>
            <h3>
              {t(s.label)} <span className="count">{items.length}</span>
            </h3>
            <div className="faint" style={{ marginBottom: 10 }}>
              {t(s.explain)}
            </div>
            {items.length === 0 && <div className="faint">{t("memory.empty")}</div>}
            {items.map((e) => (
              <EntryCard key={e.id} entry={e} />
            ))}
          </section>
        );
      })}
      {retired.length > 0 && (
        <section data-testid="memory-section-retired">
          <button className="ghost" aria-expanded={showRetired} onClick={() => setShowRetired(!showRetired)}>
            {t("memory.retired")} ({retired.length})
          </button>
          {showRetired && retired.map((e) => <EntryCard key={e.id} entry={e} />)}
        </section>
      )}
    </div>
  );
}

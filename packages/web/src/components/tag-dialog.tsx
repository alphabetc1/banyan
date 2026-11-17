// Names a new tag or renames and recolours an existing one.
import { useState } from "react";
import { useT } from "../i18n.ts";
import { TAG_COLORS, type TagColor } from "../tags.ts";
import { Dialog } from "./common.tsx";

// editing is false for a new tag, which starts from initial's suggested colour.
export function TagDialog({ initial, editing, onSave, onClose }: { initial: { name: string; color: TagColor }; editing: boolean; onSave: (name: string, color: TagColor) => void; onClose: () => void }) {
  const t = useT();
  const [name, setName] = useState(initial.name);
  const [color, setColor] = useState<TagColor>(initial.color);
  const save = (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;
    onSave(name.trim(), color);
    onClose();
  };
  return (
    <Dialog title={t(editing ? "tags.editTitle" : "tags.newTitle")} onClose={onClose}>
      <form className="stack" onSubmit={save}>
        <label>
          {t("tags.name")}
          <input value={name} onChange={(e) => setName(e.target.value)} autoFocus required maxLength={40} />
        </label>
        <div className="swatches" role="radiogroup" aria-label={t("tags.color")}>
          {TAG_COLORS.map((c) => (
            <button
              key={c}
              type="button"
              role="radio"
              aria-checked={c === color}
              aria-label={t(`tags.color.${c}`)}
              title={t(`tags.color.${c}`)}
              className={`swatch tag-${c} ${c === color ? "selected" : ""}`}
              onClick={() => setColor(c)}
            />
          ))}
        </div>
        <div className="row" style={{ justifyContent: "flex-end" }}>
          <button type="button" className="ghost" onClick={onClose}>
            {t("dialog.cancel")}
          </button>
          <button className="primary" disabled={!name.trim()}>
            {t(editing ? "settings.save" : "dialog.create")}
          </button>
        </div>
      </form>
    </Dialog>
  );
}

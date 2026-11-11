// Landing page: rooms joined in this browser and a form to create a new one.
import { useState } from "react";
import { createRoom } from "../api.ts";
import { Preferences, useAction } from "../components/common.tsx";
import { useT } from "../i18n.ts";
import { linkProps, navigate } from "../router.ts";
import { saveRoom, savedRooms } from "../session.ts";

export function HomePage() {
  const t = useT();
  const rooms = savedRooms();
  const action = useAction();
  const [form, setForm] = useState({ name: "", repoUrl: "", baseBranch: "main", goalTitle: "", goalDescription: "", ownerName: "" });
  const set = (k: keyof typeof form) => (e: { target: { value: string } }) => setForm({ ...form, [k]: e.target.value });

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    void action.run(async () => {
      const r = await createRoom("", form);
      saveRoom({ roomId: r.roomId, roomName: form.name, memberId: r.memberId, memberToken: r.memberToken, inviteToken: r.inviteToken });
      navigate(`/rooms/${r.roomId}`);
    });
  };

  return (
    <div className="content">
      <div className="row" style={{ justifyContent: "flex-end" }}>
        <Preferences />
      </div>
      <div className="centered stack">
        <div className="stack" style={{ gap: 4 }}>
          <h1>Banyan</h1>
          <span className="muted">{t("app.tagline")}</span>
        </div>
        <section className="panel stack">
          <h3>{t("home.myRooms")}</h3>
          {rooms.length === 0 && <span className="faint">{t("home.noRooms")}</span>}
          {rooms.map((r) => (
            <a key={r.roomId} className="inbox-item" {...linkProps(`/rooms/${r.roomId}`)}>
              {r.roomName}
            </a>
          ))}
        </section>
        <form className="panel stack" onSubmit={submit}>
          <h3>{t("home.create")}</h3>
          <label>
            {t("home.roomName")}
            <input required value={form.name} onChange={set("name")} />
          </label>
          <label>
            {t("home.repoUrl")}
            <input required value={form.repoUrl} onChange={set("repoUrl")} placeholder="git@github.com:you/sglang.git" />
          </label>
          <label>
            {t("home.baseBranch")}
            <input required value={form.baseBranch} onChange={set("baseBranch")} />
          </label>
          <label>
            {t("home.goalTitle")}
            <input required value={form.goalTitle} onChange={set("goalTitle")} />
          </label>
          <label>
            {t("home.goalDescription")}
            <textarea rows={3} value={form.goalDescription} onChange={set("goalDescription")} />
          </label>
          <label>
            {t("home.yourName")}
            <input required value={form.ownerName} onChange={set("ownerName")} />
          </label>
          {action.error && <span className="error">{action.error}</span>}
          <button className="primary" disabled={action.busy}>
            {t("home.create")}
          </button>
        </form>
      </div>
    </div>
  );
}

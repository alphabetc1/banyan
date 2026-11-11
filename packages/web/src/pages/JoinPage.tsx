// Joins a room from an invite link: /join/<roomId>#invite=<token>. The token travels in the
// URL fragment so it never reaches server logs.
import { useState } from "react";
import { fetchState, joinRoom } from "../api.ts";
import { Preferences, useAction } from "../components/common.tsx";
import { CopyField } from "../components/dialogs.tsx";
import { inDesktopClient, installCommand } from "../desktop.tsx";
import { useT } from "../i18n.ts";
import { navigate } from "../router.ts";
import { saveRoom } from "../session.ts";

export function JoinPage({ roomId }: { roomId: string }) {
  const t = useT();
  const inviteToken = new URLSearchParams(window.location.hash.slice(1)).get("invite");
  const [name, setName] = useState("");
  const action = useAction();

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!inviteToken) return;
    void action.run(async () => {
      const joined = await joinRoom("", roomId, inviteToken, name);
      const { state } = await fetchState("", roomId, joined.memberToken);
      saveRoom({ roomId, roomName: state.room?.name ?? roomId, memberId: joined.memberId, memberToken: joined.memberToken });
      navigate(`/rooms/${roomId}`);
    });
  };

  return (
    <div className="content">
      <div className="row" style={{ justifyContent: "flex-end" }}>
        <Preferences />
      </div>
      <form className="centered panel stack" onSubmit={submit}>
        <h1>{t("join.title")}</h1>
        {!inviteToken ? (
          <span className="error">{t("join.invalid")}</span>
        ) : (
          <>
            <label>
              {t("home.yourName")}
              <input required autoFocus value={name} onChange={(e) => setName(e.target.value)} />
            </label>
            {action.error && <span className="error">{action.error}</span>}
            <button className="primary" disabled={action.busy}>
              {t("join.submit")}
            </button>
          </>
        )}
      </form>
      {!inDesktopClient && (
        <section className="centered panel stack">
          <span className="muted">{t("invite.desktop")}</span>
          <CopyField testId="install-command" value={installCommand(window.location.origin)} />
        </section>
      )}
    </div>
  );
}

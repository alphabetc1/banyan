// Frame for all pages inside a room: owns the room connection, top bar and navigation.
import { useEffect, useState } from "react";
import { InviteDialog } from "../components/dialogs.tsx";
import { Preferences } from "../components/common.tsx";
import { RoomContext } from "../contexts.ts";
import { LocalRunnerControl, useAttentionNotifications } from "../desktop.tsx";
import { useT, type MessageKey } from "../i18n.ts";
import { RoomStore, useRoomVersion } from "../room-store.ts";
import { linkProps, routePath, type Route } from "../router.ts";
import { roomCredentials } from "../session.ts";
import { AgentPage } from "./AgentPage.tsx";
import { CoordinationPage } from "./CoordinationPage.tsx";
import { FindingsPage } from "./FindingsPage.tsx";
import { OverviewPage } from "./OverviewPage.tsx";
import { WorktreesPage } from "./WorktreesPage.tsx";

type RoomRoute = Exclude<Route, { page: "home" } | { page: "join" }>;

const NAV: { page: RoomRoute["page"]; label: MessageKey }[] = [
  { page: "overview", label: "nav.overview" },
  { page: "worktrees", label: "nav.worktrees" },
  { page: "findings", label: "nav.findings" },
  { page: "coordination", label: "nav.coordination" },
];

export function RoomShell({ route }: { route: RoomRoute }) {
  const t = useT();
  const creds = roomCredentials(route.roomId);
  const [store, setStore] = useState<RoomStore | null>(null);
  const [fatal, setFatal] = useState<string | null>(null);

  useEffect(() => {
    if (!creds) return;
    const s = new RoomStore(window.location.origin, creds.roomId, creds.memberId, creds.memberToken);
    let cancelled = false;
    s.start().then(
      () => !cancelled && setStore(s),
      (e: Error) => !cancelled && setFatal(e.message),
    );
    return () => {
      cancelled = true;
      s.close();
    };
  }, [creds?.roomId, creds?.memberToken]);

  if (!creds || fatal) {
    return (
      <div className="content">
        <div className="centered panel stack" data-testid="room-error">
          <span className="error">{fatal ?? t("join.invalid")}</span>
          <a {...linkProps("/")}>Banyan</a>
        </div>
      </div>
    );
  }
  if (!store) return <div className="content faint">…</div>;
  return (
    <RoomContext.Provider value={store}>
      <RoomFrame route={route} store={store} memberToken={creds.memberToken} />
    </RoomContext.Provider>
  );
}

function RoomFrame({ route, store, memberToken }: { route: RoomRoute; store: RoomStore; memberToken: string }) {
  const t = useT();
  useRoomVersion(store);
  useAttentionNotifications(store, route.roomId);
  const [inviting, setInviting] = useState(false);
  const room = store.state?.room;
  const activePage = route.page === "agent" ? "overview" : route.page;

  return (
    <div className="shell">
      <div>
        <header className="topbar">
          <a className="brand" {...linkProps("/")} style={{ textDecoration: "none" }}>
            Banyan
          </a>
          <span className="muted">{room?.name}</span>
          <nav>
            {NAV.map((n) => (
              <a key={n.page} className={activePage === n.page ? "active" : ""} {...linkProps(routePath({ page: n.page, roomId: route.roomId } as RoomRoute))}>
                {t(n.label)}
              </a>
            ))}
          </nav>
          <span className="spacer" />
          <LocalRunnerControl roomId={route.roomId} memberToken={memberToken} />
          <button onClick={() => setInviting(true)}>{t("top.invite")}</button>
          <Preferences />
        </header>
        {!store.connected && <div className="banner">{t("top.offline")}</div>}
      </div>
      <main className="content">
        {route.page === "overview" && <OverviewPage />}
        {route.page === "agent" && <AgentPage agentId={route.agentId} />}
        {route.page === "worktrees" && <WorktreesPage />}
        {route.page === "findings" && <FindingsPage />}
        {route.page === "coordination" && <CoordinationPage />}
      </main>
      {inviting && <InviteDialog onClose={() => setInviting(false)} />}
    </div>
  );
}

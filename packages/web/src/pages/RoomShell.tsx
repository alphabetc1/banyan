// Frame for all pages inside a room: owns the room connection, top bar and navigation.
import { useEffect, useState } from "react";
import { InviteDialog } from "../components/dialogs.tsx";
import { Preferences } from "../components/common.tsx";
import { TerminalArgsButton } from "../components/terminal-args.tsx";
import { RoomContext } from "../contexts.ts";
import { inDesktopClient, LocalRunnerControl, openLocalWorkspace, openTeamServer, useAttentionNotifications } from "../desktop.tsx";
import { useT, type MessageKey } from "../i18n.ts";
import { RoomStore, useRoomVersion } from "../room-store.ts";
import { linkProps, navigate, routePath, type Route } from "../router.ts";
import { roomCredentials, savedRooms } from "../session.ts";
import { AgentsPage } from "./AgentsPage.tsx";
import { CoordinationPage } from "./CoordinationPage.tsx";
import { FindingsPage } from "./FindingsPage.tsx";
import { GoalsPage } from "./GoalsPage.tsx";
import { WorktreesPage } from "./WorktreesPage.tsx";

type RoomRoute = Exclude<Route, { page: "home" } | { page: "join" }>;

// personal: also shown in a personal workspace, where coordination pages have no use.
const NAV: { page: RoomRoute["page"]; label: MessageKey; personal?: boolean }[] = [
  { page: "overview", label: "nav.overview", personal: true },
  { page: "goals", label: "nav.goals" },
  { page: "worktrees", label: "nav.worktrees", personal: true },
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
          <a className="brand" {...linkProps(`/rooms/${route.roomId}`)} style={{ textDecoration: "none" }}>
            Banyan
          </a>
          <RoomSwitcher roomId={route.roomId} roomName={room?.name ?? route.roomId} />
          <nav>
            {NAV.filter((n) => n.personal || !room?.personal).map((n) => (
              <a key={n.page} className={activePage === n.page ? "active" : ""} {...linkProps(routePath({ page: n.page, roomId: route.roomId } as RoomRoute))}>
                {t(n.label)}
              </a>
            ))}
          </nav>
          <span className="spacer" />
          <LocalRunnerControl roomId={route.roomId} memberToken={memberToken} />
          <button onClick={() => setInviting(true)}>{t("top.invite")}</button>
          <Preferences />
          <TerminalArgsButton />
        </header>
        {!store.connected && <div className="banner">{t("top.offline")}</div>}
      </div>
      <main className="content">
        {route.page === "overview" && <AgentsPage />}
        {route.page === "agent" && <AgentsPage agentId={route.agentId} />}
        {route.page === "goals" && <GoalsPage />}
        {route.page === "worktrees" && <WorktreesPage />}
        {route.page === "findings" && <FindingsPage />}
        {route.page === "coordination" && <CoordinationPage />}
      </main>
      {inviting && <InviteDialog onClose={() => setInviting(false)} />}
    </div>
  );
}

// Switches to another room joined on this device, or goes to the page for creating or
// joining one. In the desktop client it also switches between the local workspace and the
// team server.
const LOCAL = "desktop:local";
const TEAM = "desktop:team";

function RoomSwitcher({ roomId, roomName }: { roomId: string; roomName: string }) {
  const t = useT();
  const others = savedRooms().filter((r) => r.roomId !== roomId);
  const choose = (value: string) => {
    if (value === LOCAL) openLocalWorkspace();
    else if (value === TEAM) openTeamServer();
    else navigate(value === "" ? "/" : `/rooms/${value}`);
  };
  return (
    <select className="room-switcher" aria-label={t("top.room")} value={roomId} onChange={(e) => choose(e.target.value)} style={{ width: "auto" }}>
      <option value={roomId}>{roomName}</option>
      {others.map((r) => (
        <option key={r.roomId} value={r.roomId}>
          {r.roomName}
        </option>
      ))}
      <option value="">{t("top.otherRooms")}</option>
      {inDesktopClient && <option value={LOCAL}>{t("top.localWorkspace")}</option>}
      {inDesktopClient && <option value={TEAM}>{t("top.teamServer")}</option>}
    </select>
  );
}

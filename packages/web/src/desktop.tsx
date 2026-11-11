// Features available only inside the Banyan desktop client, which exposes window.banyanDesktop:
// running a runner for this room on the local machine, and system notifications.
import { useEffect, useRef, useState } from "react";
import type { DesktopBridge, LocalRunnerStatus } from "@banyan/shared";
import { useNow } from "./components/common.tsx";
import { attentionItems, attentionKey, ownAttention, type AttentionItem } from "./derive.ts";
import { useReasonText, useT } from "./i18n.ts";
import type { RoomStore } from "./room-store.ts";
import { routePath } from "./router.ts";

const desktop = (window as { banyanDesktop?: DesktopBridge }).banyanDesktop;

export const inDesktopClient = desktop !== undefined;

// One command that installs the client for the Mac's architecture and points it at this server.
export function installCommand(origin: string): string {
  return `curl -fsSL ${origin}/install.sh | bash -s ${origin}`;
}

const STATE_PILL: Record<LocalRunnerStatus["state"], string> = { starting: "yellow", running: "green", error: "red" };

// Electron prefixes errors thrown by the main process with the IPC channel name.
function bridgeError(e: Error): Error {
  return new Error(e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, ""));
}

export function LocalRunnerControl({ roomId, memberToken }: { roomId: string; memberToken: string }) {
  const t = useT();
  // undefined until the client has answered; null when no runner is enabled for the room.
  const [status, setStatus] = useState<LocalRunnerStatus | null | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!desktop) return;
    const pick = (list: LocalRunnerStatus[]) => setStatus(list.find((r) => r.roomId === roomId) ?? null);
    void desktop.listRunners().then(pick);
    return desktop.onRunnersChanged(pick);
  }, [roomId]);

  if (!desktop || status === undefined) return null;
  const bridge = desktop;
  const run = (fn: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    fn()
      .catch((e: Error) => setError(bridgeError(e).message))
      .finally(() => setBusy(false));
  };

  if (!status) {
    return (
      <span className="row">
        {error && <span className="error">{error}</span>}
        <button disabled={busy} onClick={() => run(() => bridge.enableRunner(roomId, memberToken))}>
          {t("desktop.runOnThisMachine")}
        </button>
      </span>
    );
  }
  return (
    <span className="row">
      <span className={`pill ${STATE_PILL[status.state]}`} title={status.error} data-testid="local-runner">
        {t(`desktop.runner.${status.state}`)}
      </span>
      {status.error && <span className="error">{status.error}</span>}
      {status.state === "error" && (
        <button disabled={busy} onClick={() => run(() => bridge.enableRunner(roomId, memberToken))}>
          {t("desktop.restartRunner")}
        </button>
      )}
      <button className="ghost" disabled={busy} onClick={() => run(() => bridge.disableRunner(roomId))}>
        {t("desktop.stopRunner")}
      </button>
    </span>
  );
}

// Notifies about attention items on this member's own agents that appear while the room is
// open; items already present when it opens are shown in the inbox only.
export function useAttentionNotifications(store: RoomStore, roomId: string): void {
  const t = useT();
  const reasonText = useReasonText();
  const now = useNow();
  const seen = useRef<Set<string> | null>(null);

  useEffect(() => {
    const state = store.state;
    if (!desktop || !state) return;
    const items = ownAttention(state, store.memberId, attentionItems(state, store.onlineRunnerIds, now));
    const previous = seen.current;
    seen.current = new Set(items.map(attentionKey));
    if (!previous) return;
    for (const item of items) {
      if (previous.has(attentionKey(item))) continue;
      const name = state.agents[item.agentId]?.name ?? item.agentId;
      desktop.notify(`${name} ${t(`desktop.notify.${item.kind}`)}`, notificationBody(item, reasonText), routePath({ page: "agent", roomId, agentId: item.agentId }));
    }
  });
}

function notificationBody(item: AttentionItem, reasonText: ReturnType<typeof useReasonText>): string {
  switch (item.kind) {
    case "approval":
      return item.tool;
    case "unhealthy":
      return item.reasons.map(reasonText).join(", ");
    case "review":
      return item.summary;
  }
}

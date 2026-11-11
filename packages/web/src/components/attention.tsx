// What needs a human right now: pending approvals, unhealthy agents and posts no agent can review.
import { useContext } from "react";
import type { RoomState } from "@banyan/shared";
import { useRoomStore } from "../contexts.ts";
import type { AttentionItem } from "../derive.ts";
import { LanguageContext, useReasonText, useT } from "../i18n.ts";
import { linkProps } from "../router.ts";
import { timeAgo, useNow } from "./common.tsx";

export function AttentionInbox({ items, state }: { items: AttentionItem[]; state: RoomState }) {
  const t = useT();
  const reasonText = useReasonText();
  const store = useRoomStore();
  const { lang } = useContext(LanguageContext);
  const now = useNow();
  return (
    <section className="inbox" data-testid="attention">
      <h3>
        ⚠ {t("overview.attention")} ({items.length})
      </h3>
      {items.length === 0 && <div className="faint" style={{ marginTop: 8 }}>{t("overview.attentionEmpty")}</div>}
      {items.map((item) => {
        const agent = state.agents[item.agentId];
        const href = item.kind === "review" ? `/rooms/${store.roomId}/findings` : `/rooms/${store.roomId}/agents/${item.agentId}`;
        const key = item.kind === "approval" ? item.approvalId : item.kind === "review" ? item.postId : `u-${item.agentId}`;
        return (
          <a key={key} className="inbox-item" {...linkProps(href)}>
            <strong>{agent?.name}</strong>{" "}
            {item.kind === "approval" && (
              <span className="muted">
                {t("agent.approvalTitle")}: {item.tool} · {timeAgo(item.since, now, lang)}
              </span>
            )}
            {item.kind === "unhealthy" && <span className="muted">{item.reasons.map(reasonText).join(" · ")}</span>}
            {item.kind === "review" && (
              <span className="muted">
                {t("findings.pending")}: {item.summary}
              </span>
            )}
          </a>
        );
      })}
    </section>
  );
}

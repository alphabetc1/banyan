// Leaders and monitors per group, and the message stream between agents and people.
import { useContext } from "react";
import { timeAgo, useNow } from "../components/common.tsx";
import { StatusIcon } from "../components/status-icon.tsx";
import { useRoomStore } from "../contexts.ts";
import { actorName, agentIcon } from "../derive.ts";
import { LanguageContext, useT } from "../i18n.ts";
import { useRoomVersion } from "../room-store.ts";
import { linkProps } from "../router.ts";

export function CoordinationPage() {
  const t = useT();
  const { lang } = useContext(LanguageContext);
  const store = useRoomStore();
  useRoomVersion(store);
  const now = useNow();
  const state = store.state!;
  const messages = Object.values(state.messages).sort((a, b) => b.sentAt - a.sentAt);

  return (
    <div className="stack">
      <h2>{t("coordination.title")}</h2>
      <div className="cards">
        {Object.values(state.groups).map((g) => (
          <div className="card" key={g.id}>
            <div className="name">{g.name}</div>
            <span className="faint">{state.goals[g.goalId]?.title}</span>
            {[g.leaderAgentId, g.monitorAgentId].map((id) => {
              const agent = id ? state.agents[id] : undefined;
              if (!agent) return null;
              return (
                <a key={agent.id} className="row" style={{ textDecoration: "none" }} {...linkProps(`/rooms/${store.roomId}/agents/${agent.id}`)}>
                  <StatusIcon kind={agentIcon(state, agent, store.onlineRunnerIds, now)} />
                  <span>{agent.name}</span>
                  <span className="pill">{t(`agent.${agent.role}`)}</span>
                </a>
              );
            })}
          </div>
        ))}
      </div>
      <h3>{t("coordination.messages")}</h3>
      {messages.length === 0 && <div className="faint">{t("coordination.empty")}</div>}
      {messages.map((m) => (
        <div className="post" key={m.id} data-testid="message">
          <div className="row">
            <strong>{actorName(state, m.from)}</strong>
            <span className="faint">→ {state.agents[m.toAgentId]?.name}</span>
            <span className="pill">{m.delivery}</span>
            <span style={{ flex: 1 }} />
            <span className="faint">{timeAgo(m.sentAt, now, lang)}</span>
          </div>
          <div className="body">{m.text}</div>
        </div>
      ))}
    </div>
  );
}

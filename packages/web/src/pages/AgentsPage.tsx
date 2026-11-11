// Room overview: every agent in a list on the left with its status, and the selected agent's
// conversation on the right.
import { useState } from "react";
import { pendingApprovalCount, type Agent, type RoomState } from "@banyan/shared";
import { AttentionInbox } from "../components/attention.tsx";
import { ROLE_MARK, StatusDot, useNow } from "../components/common.tsx";
import { NewAgentDialog } from "../components/dialogs.tsx";
import { useRoomStore } from "../contexts.ts";
import { agentStatus, attentionItems, groupAgents, groupsInSubtree, standaloneAgentsInSubtree } from "../derive.ts";
import { useReasonText, useT } from "../i18n.ts";
import { useRoomVersion } from "../room-store.ts";
import { linkProps } from "../router.ts";
import { AgentPage } from "./AgentPage.tsx";

interface Section {
  key: string;
  title: string;
  subtitle: string | null;
  agents: Agent[];
}

// Standalone agents first, then groups from the shallowest goal down.
function sections(state: RoomState, standaloneTitle: string): Section[] {
  const rootGoalId = state.room!.rootGoalId;
  const out: Section[] = [];
  const standalone = standaloneAgentsInSubtree(state, rootGoalId);
  if (standalone.length > 0) out.push({ key: "standalone", title: standaloneTitle, subtitle: null, agents: standalone });
  for (const g of groupsInSubtree(state, rootGoalId)) {
    out.push({ key: g.id, title: g.name, subtitle: state.goals[g.goalId]?.title ?? null, agents: groupAgents(state, g.id) });
  }
  return out;
}

function AgentRow({ agent, selected }: { agent: Agent; selected: boolean }) {
  const t = useT();
  const reasonText = useReasonText();
  const store = useRoomStore();
  const now = useNow();
  const state = store.state!;
  const status = agentStatus(state, agent, store.onlineRunnerIds, now);
  const approvals = pendingApprovalCount(state, agent.id);
  return (
    <a className={`agent-row ${selected ? "selected" : ""}`} data-testid={`agent-row-${agent.name}`} {...linkProps(`/rooms/${store.roomId}/agents/${agent.id}`)}>
      <div className="row" style={{ gap: 8 }}>
        <StatusDot level={status.level} title={status.reasons.map(reasonText).join("; ")} />
        {ROLE_MARK[agent.role] && <span title={t(`agent.${agent.role}`)}>{ROLE_MARK[agent.role]}</span>}
        <span className="name">{agent.name}</span>
        {approvals > 0 && (
          <span className="pill yellow" title={t("agent.approvalsWaiting")}>
            {approvals}
          </span>
        )}
        <span className="faint">{agent.provider}</span>
      </div>
      <div className="faint detail">
        {agent.phase?.value ?? t("agent.noPhase")} · {agent.process === "starting" ? t("process.starting") : t(`activity.${agent.activity}`)}
      </div>
    </a>
  );
}

export function AgentsPage({ agentId }: { agentId?: string }) {
  const t = useT();
  const store = useRoomStore();
  useRoomVersion(store);
  const now = useNow();
  const [creating, setCreating] = useState(false);
  const state = store.state!;
  const list = sections(state, t("overview.standalone"));
  // Without a selection, show the first agent in the list.
  const selectedId = agentId ?? list[0]?.agents[0]?.id;
  const attention = attentionItems(state, store.onlineRunnerIds, now);

  return (
    <div className="agents-layout">
      <aside className="agent-list panel">
        <div className="row">
          <h3 style={{ flex: 1 }}>{t("overview.agents")}</h3>
          <button className="primary" onClick={() => setCreating(true)}>
            {t("overview.newAgent")}
          </button>
        </div>
        {attention.length > 0 && <AttentionInbox items={attention} state={state} />}
        {list.length === 0 && <div className="faint">{t("overview.noAgents")}</div>}
        {list.map((s) => (
          <section key={s.key} data-testid={s.key === "standalone" ? "standalone-agents" : `group-${s.title}`}>
            <div className="list-heading">
              {s.title}
              {s.subtitle && <span className="faint"> · {s.subtitle}</span>}
            </div>
            {s.agents.map((a) => (
              <AgentRow key={a.id} agent={a} selected={a.id === selectedId} />
            ))}
          </section>
        ))}
      </aside>
      <section className="agent-detail">{selectedId ? <AgentPage agentId={selectedId} /> : <div className="panel faint">{t("overview.selectAgent")}</div>}</section>
      {creating && <NewAgentDialog goalId={state.room!.rootGoalId} onClose={() => setCreating(false)} />}
    </div>
  );
}

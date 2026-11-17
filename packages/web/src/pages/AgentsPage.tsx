// Room overview: every agent in a list on the left with its status, and the selected agent's
// conversation on the right.
import { useState } from "react";
import { pendingApprovalCount, type Agent, type RoomState } from "@banyan/shared";
import { AttentionInbox } from "../components/attention.tsx";
import { ROLE_MARK, useNow } from "../components/common.tsx";
import { KindIcon } from "../components/kind-icon.tsx";
import { useSortable } from "../components/sortable.tsx";
import { StatusIcon } from "../components/status-icon.tsx";
import { NewAgentDialog } from "../components/dialogs.tsx";
import { useRoomStore } from "../contexts.ts";
import { agentFolder, agentIcon, agentStatus, attentionItems, groupAgents, groupsInSubtree, inSavedOrder, standaloneAgentsInSubtree } from "../derive.ts";
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

// Standalone agents first, then groups from the shallowest goal down; within each, in the
// order the person arranged them.
function sections(state: RoomState, standaloneTitle: string, order: string[]): Section[] {
  const rootGoalId = state.room!.rootGoalId;
  const out: Section[] = [];
  const standalone = standaloneAgentsInSubtree(state, rootGoalId);
  if (standalone.length > 0) out.push({ key: "standalone", title: standaloneTitle, subtitle: null, agents: inSavedOrder(standalone, order) });
  for (const g of groupsInSubtree(state, rootGoalId)) {
    out.push({ key: g.id, title: g.name, subtitle: state.goals[g.goalId]?.title ?? null, agents: inSavedOrder(groupAgents(state, g.id), order) });
  }
  return out;
}

// The arrangement is this viewer's own, kept in this browser.
const orderKey = (roomId: string) => `banyan.agentOrder.${roomId}`;

function loadOrder(roomId: string): string[] {
  try {
    return JSON.parse(localStorage.getItem(orderKey(roomId)) ?? "[]") as string[];
  } catch {
    return [];
  }
}

function saveOrder(roomId: string, order: string[]): void {
  try {
    localStorage.setItem(orderKey(roomId), JSON.stringify(order));
  } catch {
    // Kept for this page view only.
  }
}

function SortableSection({ section, selectedId, order, onOrder }: { section: Section; selectedId: string | undefined; order: string[]; onOrder: (order: string[]) => void }) {
  const ids = section.agents.map((a) => a.id);
  // A new arrangement of this section, placed where its agents were in the whole order.
  const reorder = (next: string[]) => onOrder([...next, ...order.filter((id) => !next.includes(id))]);
  const { rowProps, dragging } = useSortable(ids, reorder);
  return (
    <section data-testid={section.key === "standalone" ? "standalone-agents" : `group-${section.title}`}>
      <div className="list-heading">
        {section.title}
        {section.subtitle && <span className="faint"> · {section.subtitle}</span>}
      </div>
      {section.agents.map((a) => (
        <AgentRow key={a.id} agent={a} selected={a.id === selectedId} dragging={dragging === a.id} rowProps={rowProps(a.id)} />
      ))}
    </section>
  );
}

function AgentRow({ agent, selected, dragging, rowProps }: { agent: Agent; selected: boolean; dragging: boolean; rowProps: ReturnType<ReturnType<typeof useSortable>["rowProps"]> }) {
  const t = useT();
  const reasonText = useReasonText();
  const store = useRoomStore();
  const now = useNow();
  const state = store.state!;
  const status = agentStatus(state, agent, store.onlineRunnerIds, now);
  const icon = agentIcon(state, agent, store.onlineRunnerIds, now);
  const approvals = pendingApprovalCount(state, agent.id);
  const folder = agentFolder(state, agent);
  return (
    <a
      className={`agent-row ${selected ? "selected" : ""} ${dragging ? "dragging" : ""}`}
      data-testid={`agent-row-${agent.name}`}
      {...linkProps(`/rooms/${store.roomId}/agents/${agent.id}`)}
      {...rowProps}
    >
      <div className="row" style={{ gap: 8 }}>
        <StatusIcon kind={icon} title={status.reasons.map(reasonText).join("; ") || undefined} />
        {ROLE_MARK[agent.role] && <span title={t(`agent.${agent.role}`)}>{ROLE_MARK[agent.role]}</span>}
        <span className="name">{agent.name}</span>
        {approvals > 0 && (
          <span className="pill yellow" title={t("agent.approvalsWaiting")}>
            {approvals}
          </span>
        )}
        <KindIcon kind={agent.provider} active={icon === "working"} />
      </div>
      <div className="faint detail" title={folder}>
        <span className="folder">{folder}</span>
        {agent.phase && <span> · {agent.phase.value}</span>}
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
  const [order, setOrder] = useState(() => loadOrder(store.roomId));
  const arrange = (next: string[]) => {
    setOrder(next);
    saveOrder(store.roomId, next);
  };
  const list = sections(state, t("overview.standalone"), order);
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
          <SortableSection key={s.key} section={s} selectedId={selectedId} order={order.length > 0 ? order : list.flatMap((x) => x.agents.map((a) => a.id))} onOrder={arrange} />
        ))}
      </aside>
      <section className="agent-detail">{selectedId ? <AgentPage agentId={selectedId} /> : <div className="panel faint">{t("overview.selectAgent")}</div>}</section>
      {creating && <NewAgentDialog goalId={state.room!.rootGoalId} onClose={() => setCreating(false)} />}
    </div>
  );
}

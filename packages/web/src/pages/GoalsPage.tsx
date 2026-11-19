// Goals page: goal tree on the left, groups and agent cards for the selected goal on the right.
import { useState } from "react";
import type { Agent, RoomState } from "@banyan/shared";
import { AttentionInbox } from "../components/attention.tsx";
import { ROLE_MARK, useNow } from "../components/common.tsx";
import { StatusIcon } from "../components/status-icon.tsx";
import { MetricDialog, NewAgentDialog, NewGoalDialog, NewGroupDialog } from "../components/dialogs.tsx";
import { useRoomStore } from "../contexts.ts";
import { agentIcon, agentStatus, attentionItems, goalTree, groupAgents, groupsInSubtree, standaloneAgentsInSubtree, type GoalNode } from "../derive.ts";
import { useReasonText, useT } from "../i18n.ts";
import { useRoomVersion } from "../room-store.ts";
import { linkProps } from "../router.ts";

function GoalTreeView({ node, selected, onSelect, depth = 0 }: { node: GoalNode; selected: string; onSelect: (id: string) => void; depth?: number }) {
  const [open, setOpen] = useState(depth < 2);
  return (
    <li>
      <div className={`tree-item ${selected === node.goal.id ? "selected" : ""}`} onClick={() => onSelect(node.goal.id)}>
        <span
          className="twisty"
          onClick={(e) => {
            e.stopPropagation();
            setOpen(!open);
          }}
        >
          {node.children.length > 0 ? (open ? "▾" : "▸") : ""}
        </span>
        <span className="title" title={node.goal.title}>
          {node.goal.title}
        </span>
        {node.agentCount > 0 && <span className="count">● {node.agentCount}</span>}
      </div>
      {open && node.children.length > 0 && (
        <ul>
          {node.children.map((c) => (
            <GoalTreeView key={c.goal.id} node={c} selected={selected} onSelect={onSelect} depth={depth + 1} />
          ))}
        </ul>
      )}
    </li>
  );
}

// homeGoalId is the goal of the section showing the card; the agent's own goal is shown when it differs.
function AgentCard({ state, agent, homeGoalId, online, now }: { state: RoomState; agent: Agent; homeGoalId: string; online: string[]; now: number }) {
  const t = useT();
  const reasonText = useReasonText();
  const status = agentStatus(state, agent, online, now);
  const store = useRoomStore();
  const goal = state.goals[agent.goalId];
  return (
    <a className="card" data-testid={`agent-card-${agent.name}`} {...linkProps(`/rooms/${store.roomId}/agents/${agent.id}`)}>
      <div className="name">
        <StatusIcon kind={agentIcon(state, agent, online, now)} title={status.reasons.map(reasonText).join("; ") || undefined} />
        {ROLE_MARK[agent.role] && <span title={t(`agent.${agent.role}`)}>{ROLE_MARK[agent.role]}</span>}
        <span>{agent.name}</span>
        <span className="spacer" style={{ flex: 1 }} />
        <span className="pill">{agent.provider}</span>
      </div>
      <div className="row" style={{ flexWrap: "wrap", gap: 6 }}>
        <span className="pill">{agent.phase?.value ?? t("agent.noPhase")}</span>
        {agent.process === "starting" ? <span className="pill">{t("process.starting")}</span> : <span className="pill">{t(`activity.${agent.activity}`)}</span>}
      </div>
      {goal && agent.goalId !== homeGoalId && <span className="faint">→ {goal.title}</span>}
      {status.reasons.length > 0 && <span className="reasons">{status.reasons.map(reasonText).join(" · ")}</span>}
    </a>
  );
}


export function GoalsPage() {
  const t = useT();
  const store = useRoomStore();
  useRoomVersion(store);
  const now = useNow();
  const state = store.state!;
  const tree = goalTree(state);
  const [selected, setSelected] = useState(state.room!.rootGoalId);
  const [dialog, setDialog] = useState<null | "goal" | "group" | "agent" | "metric">(null);
  if (!tree) return null;
  const goal = state.goals[selected] ?? state.goals[state.room!.rootGoalId]!;
  const groups = groupsInSubtree(state, goal.id);
  const standalone = standaloneAgentsInSubtree(state, goal.id);

  return (
    <div className="overview">
      <aside className="tree panel">
        <h3 style={{ marginBottom: 10 }}>{t("overview.goals")}</h3>
        <ul>
          <GoalTreeView node={tree} selected={goal.id} onSelect={setSelected} />
        </ul>
        <AttentionInbox items={attentionItems(state, store.onlineRunnerIds, now)} state={state} />
      </aside>
      <section>
        <div className="row" style={{ marginBottom: 20, flexWrap: "wrap" }}>
          <div className="stack" style={{ gap: 2, flex: 1 }}>
            <h2>{goal.title}</h2>
            {goal.description && <span className="muted">{goal.description}</span>}
            {goal.metric && (
              <span className="faint" data-testid="goal-metric">
                {t("metric.label")}: {goal.metric.name} · {t(`metric.${goal.metric.direction}`)}
                {goal.metric.unit && ` · ${goal.metric.unit}`} · <code>{goal.metric.command}</code>
              </span>
            )}
          </div>
          <button onClick={() => setDialog("metric")}>{t("metric.button")}</button>
          <button onClick={() => setDialog("goal")}>{t("overview.newGoal")}</button>
          <button onClick={() => setDialog("group")}>{t("overview.newGroup")}</button>
          <button className="primary" onClick={() => setDialog("agent")}>
            {t("overview.newAgent")}
          </button>
        </div>
        {groups.length === 0 && standalone.length === 0 && <div className="panel faint">{t("overview.noGroups")}</div>}
        {standalone.length > 0 && (
          <div className="group-section" data-testid="standalone-agents">
            <header>
              <h3>{t("overview.standalone")}</h3>
            </header>
            <div className="cards">
              {standalone.map((a) => (
                <AgentCard key={a.id} state={state} agent={a} homeGoalId={goal.id} online={store.onlineRunnerIds} now={now} />
              ))}
            </div>
          </div>
        )}
        {groups.map((g) => (
          <div className="group-section" key={g.id} data-testid={`group-${g.name}`}>
            <header>
              <h3>{g.name}</h3>
              {g.goalId !== goal.id && <span className="faint">{state.goals[g.goalId]?.title}</span>}
            </header>
            <div className="cards">
              {groupAgents(state, g.id).map((a) => (
                <AgentCard key={a.id} state={state} agent={a} homeGoalId={g.goalId} online={store.onlineRunnerIds} now={now} />
              ))}
            </div>
          </div>
        ))}
      </section>
      {dialog === "goal" && <NewGoalDialog parentId={goal.id} onClose={() => setDialog(null)} />}
      {dialog === "group" && <NewGroupDialog goalId={goal.id} onClose={() => setDialog(null)} />}
      {dialog === "agent" && <NewAgentDialog goalId={goal.id} onClose={() => setDialog(null)} />}
      {dialog === "metric" && <MetricDialog goalId={goal.id} onClose={() => setDialog(null)} />}
    </div>
  );
}

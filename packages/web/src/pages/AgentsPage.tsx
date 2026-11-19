// Room overview: every agent in a list on the left with its status, sorted into the person's
// own tags, and the selected agent's conversation on the right.
import { useRef, useState, type MouseEvent } from "react";
import { draft, newId, pendingApprovalCount, type Agent, type RoomState } from "@banyan/shared";
import { AttentionInbox } from "../components/attention.tsx";
import { ContextMenu, ROLE_MARK, useAction, useNow, type MenuItem } from "../components/common.tsx";
import { KindIcon } from "../components/kind-icon.tsx";
import { useSortable, type Drop } from "../components/sortable.tsx";
import { StatusIcon } from "../components/status-icon.tsx";
import { NewAgentDialog, RenameAgentDialog } from "../components/dialogs.tsx";
import { TagDialog } from "../components/tag-dialog.tsx";
import { useRoomStore } from "../contexts.ts";
import { agentFolder, agentIcon, agentStatus, attentionItems, canForkAgent, canManageAgent, groupAgents, groupsInSubtree, inSavedOrder, standaloneAgentsInSubtree } from "../derive.ts";
import { useReasonText, useT } from "../i18n.ts";
import { useRoomVersion } from "../room-store.ts";
import { linkProps, navigate } from "../router.ts";
import { addTag, loadBoard, nextColor, placeNear, removeTag, saveBoard, setAgentTag, tagOfAgent, tagSections, updateTag, type Tag, type TagBoard } from "../tags.ts";
import { AgentPage } from "./AgentPage.tsx";

// The section key of the untagged agents.
const UNTAGGED = "";

// Before the person arranges them: standalone agents, then groups from the shallowest goal
// down, each leader first.
function defaultOrder(state: RoomState): Agent[] {
  const rootGoalId = state.room!.rootGoalId;
  return [...standaloneAgentsInSubtree(state, rootGoalId), ...groupsInSubtree(state, rootGoalId).flatMap((g) => groupAgents(state, g.id))];
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

type RowProps = ReturnType<ReturnType<typeof useSortable>["rowProps"]>;

function AgentRow({ agent, selected, dragging, rowProps, onMenu }: { agent: Agent; selected: boolean; dragging: boolean; rowProps: RowProps; onMenu: (e: MouseEvent) => void }) {
  const t = useT();
  const reasonText = useReasonText();
  const store = useRoomStore();
  const now = useNow();
  const state = store.state!;
  const status = agentStatus(state, agent, store.onlineRunnerIds, now);
  const icon = agentIcon(state, agent, store.onlineRunnerIds, now);
  const approvals = pendingApprovalCount(state, agent.id);
  const folder = agentFolder(state, agent);
  const group = agent.groupId ? state.groups[agent.groupId]?.name : undefined;
  const { className: dropMark, ...props } = rowProps;
  return (
    <a
      className={`agent-row ${selected ? "selected" : ""} ${dragging ? "dragging" : ""} ${dropMark}`}
      data-testid={`agent-row-${agent.name}`}
      {...linkProps(`/rooms/${store.roomId}/agents/${agent.id}`)}
      {...props}
      onContextMenu={onMenu}
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
        {group && <span className="group-label">{group} · </span>}
        <span className="folder">{folder}</span>
        {agent.phase && <span> · {agent.phase.value}</span>}
      </div>
    </a>
  );
}

function Chevron() {
  return (
    <svg className="chevron" width="10" height="6" viewBox="0 0 10 6" aria-hidden="true">
      <path d="M1 5l4-4 4 4" />
    </svg>
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
  const [board, setBoard] = useState(() => loadBoard(store.roomId));
  // The latest board, for menu actions chosen after it changed.
  const latestBoard = useRef(board);
  const [menu, setMenu] = useState<{ x: number; y: number; items: MenuItem[] } | null>(null);
  // forAgent is an agent to put in the tag once it is created.
  const [renaming, setRenaming] = useState<string | null>(null);
  const [tagDialog, setTagDialog] = useState<{ tag: Tag | null; forAgent: string | null } | null>(null);
  // Saved at once, so a change survives the page going away right after it.
  const change = (f: (b: TagBoard) => TagBoard) => {
    const next = f(latestBoard.current);
    latestBoard.current = next;
    setBoard(next);
    saveBoard(store.roomId, next);
  };

  const agents = inSavedOrder(defaultOrder(state), order);
  const sections = tagSections(agents, board);
  const hasTags = board.tags.length > 0;
  const sectionOf = (id: string) => tagOfAgent(board, id)?.id ?? UNTAGGED;
  const drop = ({ id, section, targetId, after }: Drop) => {
    const ids = agents.map((a) => a.id);
    const next = targetId ? placeNear(ids, id, targetId, after) : [...ids.filter((x) => x !== id), id];
    setOrder(next);
    saveOrder(store.roomId, next);
    change((b) => setAgentTag(b, id, section === UNTAGGED ? null : section));
  };
  const visibleIds = sections.flatMap((s) => (s.tag?.collapsed ? [] : s.agents.map((a) => a.id)));
  const { rowProps, headerProps, dragging, dropSection } = useSortable(visibleIds, sectionOf, drop);
  // Without a selection, show the first agent in the list.
  const selectedId = agentId ?? sections.flatMap((s) => s.agents)[0]?.id;
  const attention = attentionItems(state, store.onlineRunnerIds, now);

  const openMenu = (e: MouseEvent, items: MenuItem[]) => {
    e.preventDefault();
    e.stopPropagation();
    setMenu({ x: e.clientX, y: e.clientY, items });
  };
  const agentMenu = (agent: Agent) => (e: MouseEvent) => {
    const current = tagOfAgent(board, agent.id);
    const manage: MenuItem[] = [
      ...(canManageAgent(state, store.memberId, agent) ? [{ label: t("agent.renameMenu"), onSelect: () => setRenaming(agent.id) }] : []),
      ...(canForkAgent(state, store.memberId, agent) ? [{ label: t("agent.fork"), onSelect: () => fork(agent) }] : []),
    ];
    openMenu(e, [
      ...manage,
      ...(manage.length > 0 ? ["separator" as const] : []),
      { heading: t("tags.moveTo") },
      ...board.tags.map((tag) => ({ label: tag.name, checked: tag.id === current?.id, onSelect: () => change((b) => setAgentTag(b, agent.id, tag.id)) })),
      { label: t("tags.newFromMenu"), onSelect: () => setTagDialog({ tag: null, forAgent: agent.id }) },
      ...(current ? ["separator" as const, { label: t("tags.removeFrom"), onSelect: () => change((b) => setAgentTag(b, agent.id, null)) }] : []),
    ]);
  };
  // A copy of the agent, listed right below it in the same tag, and opened.
  const forking = useAction();
  const fork = (agent: Agent) => {
    const agentId = newId();
    void forking.run(async () => {
      await store.append([
        draft("agent.created", {
          agentId,
          groupId: agent.groupId,
          runnerId: agent.runnerId,
          name: `${agent.name}-fork`,
          role: "worker",
          provider: agent.provider,
          model: agent.model,
          goalId: agent.goalId,
          instructions: agent.instructions,
          terminal: true,
          ...(agent.repoPath ? { repoPath: agent.repoPath } : {}),
          forkOf: agent.id,
        }),
      ]);
      const next = placeNear([...agents.map((a) => a.id), agentId], agentId, agent.id, true);
      setOrder(next);
      saveOrder(store.roomId, next);
      const tag = tagOfAgent(board, agent.id);
      if (tag) change((b) => setAgentTag(b, agentId, tag.id));
      navigate(`/rooms/${store.roomId}/agents/${agentId}`);
    });
  };
  const tagMenu = (tag: Tag) => (e: MouseEvent) =>
    openMenu(e, [
      { label: t("tags.edit"), onSelect: () => setTagDialog({ tag, forAgent: null }) },
      { label: t("tags.delete"), danger: true, onSelect: () => change((b) => removeTag(b, tag.id)) },
    ]);
  const saveTag = (name: string, color: Tag["color"]) => {
    const editing = tagDialog?.tag;
    if (editing) return change((b) => updateTag(b, editing.id, { name, color }));
    const tag: Tag = { id: newId(), name, color, collapsed: false };
    const forAgent = tagDialog?.forAgent;
    change((b) => (forAgent ? setAgentTag(addTag(b, tag), forAgent, tag.id) : addTag(b, tag)));
  };

  return (
    <div className="agents-layout">
      <aside className="agent-list">
        <div className="row">
          <h3 style={{ flex: 1 }}>{t("overview.agents")}</h3>
          <button className="ghost" onClick={() => setTagDialog({ tag: null, forAgent: null })}>
            {t("tags.new")}
          </button>
          <button className="primary" onClick={() => setCreating(true)}>
            {t("overview.newAgent")}
          </button>
        </div>
        {forking.error && <span className="error">{forking.error}</span>}
        {attention.length > 0 && <AttentionInbox items={attention} state={state} />}
        {agents.length === 0 && <div className="faint">{t("overview.noAgents")}</div>}
        {sections.map(({ tag, agents: members }) => {
          const key = tag?.id ?? UNTAGGED;
          // The untagged agents get a header only beside tags, and only when there is something
          // to show or a dragged agent might be dropped there.
          if (!tag && members.length === 0 && !(hasTags && dragging !== null)) return null;
          const target = dragging !== null && dropSection === key && sectionOf(dragging) !== key;
          const rows = members.map((a) => <AgentRow key={a.id} agent={a} selected={a.id === selectedId} dragging={dragging === a.id} rowProps={rowProps(a.id)} onMenu={agentMenu(a)} />);
          if (!tag)
            return (
              <section key={key} className={`tag-section untagged ${target ? "drop-target" : ""}`} data-testid="untagged-agents">
                {hasTags && (
                  <div className="list-heading" {...headerProps(key)}>
                    {t("tags.untagged")}
                  </div>
                )}
                {rows}
              </section>
            );
          const toggle = () => change((b) => updateTag(b, tag.id, { collapsed: !tag.collapsed }));
          return (
            <section key={key} className={`tag-section tag-${tag.color} ${tag.collapsed ? "collapsed" : ""} ${target ? "drop-target" : ""}`} data-testid={`tag-${tag.name}`}>
              {/* The whole header collapses the tag on a click; the chevron is its keyboard control. */}
              <div className="tag-header" {...headerProps(key)} onClick={toggle} onContextMenu={tagMenu(tag)}>
                <span className="tag-name">{tag.name}</span>
                {tag.collapsed && <span className="tag-count">{members.length}</span>}
                <button className="tag-more" aria-label={t("tags.menu")} onClick={tagMenu(tag)}>
                  ⋯
                </button>
                <button
                  className="tag-toggle"
                  aria-expanded={!tag.collapsed}
                  aria-label={tag.name}
                  onClick={(e) => {
                    e.stopPropagation();
                    toggle();
                  }}
                >
                  <Chevron />
                </button>
              </div>
              {!tag.collapsed && <div className="tag-body">{rows}</div>}
            </section>
          );
        })}
      </aside>
      <section className="agent-detail">{selectedId ? <AgentPage agentId={selectedId} /> : <div className="panel faint">{t("overview.selectAgent")}</div>}</section>
      {creating && <NewAgentDialog goalId={state.room!.rootGoalId} onClose={() => setCreating(false)} />}
      {menu && <ContextMenu {...menu} onClose={() => setMenu(null)} />}
      {renaming && <RenameAgentDialog agentId={renaming} onClose={() => setRenaming(null)} />}
      {tagDialog && (
        <TagDialog
          initial={tagDialog.tag ? { name: tagDialog.tag.name, color: tagDialog.tag.color } : { name: "", color: nextColor(board) }}
          editing={tagDialog.tag !== null}
          onSave={saveTag}
          onClose={() => setTagDialog(null)}
        />
      )}
    </div>
  );
}

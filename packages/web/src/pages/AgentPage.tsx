// One agent: virtualized transcript (paged history + live), approvals, messaging and facts.
import { useContext, useEffect, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { agentGroup, draft, goalPath, newId, type Delivery, type RoomEvent, type TranscriptEntry } from "@banyan/shared";
import { fetchTranscript, TRANSCRIPT_PAGE_SIZE } from "../api.ts";
import { StatusDot, timeAgo, useAction, useNow } from "../components/common.tsx";
import { useRoomStore } from "../contexts.ts";
import { actorName, agentStatus } from "../derive.ts";
import { LanguageContext, useReasonText, useT } from "../i18n.ts";
import { useRoomVersion } from "../room-store.ts";

interface Row {
  key: string;
  entry: TranscriptEntry;
}

function rowsOf(e: RoomEvent): Row[] {
  if (e.type !== "transcript.appended") return [];
  return e.payload.entries.map((entry, i) => ({ key: `${e.seq}-${i}`, entry }));
}

function useTranscript(agentId: string) {
  const store = useRoomStore();
  const [rows, setRows] = useState<Row[]>([]);
  const [oldestSeq, setOldestSeq] = useState<number | null>(null);
  const [hasMore, setHasMore] = useState(true);
  const action = useAction();
  // The agent currently shown; responses for a previously shown agent are dropped.
  const currentAgent = useRef(agentId);
  currentAgent.current = agentId;

  const loadOlder = (before?: number) =>
    action.run(async () => {
      const requestedFor = agentId;
      const { events } = await fetchTranscript("", store.roomId, requestedFor, store.token, before);
      if (currentAgent.current !== requestedFor) return;
      const chronological = [...events].reverse();
      // Live entries may already include the newest page; keep each row once.
      setRows((current) => {
        const known = new Set(current.map((r) => r.key));
        return [...chronological.flatMap(rowsOf).filter((r) => !known.has(r.key)), ...current];
      });
      if (chronological[0]) setOldestSeq(chronological[0].seq);
      // A short page means the history has been fully loaded.
      setHasMore(events.length === TRANSCRIPT_PAGE_SIZE);
    });

  useEffect(() => {
    setRows([]);
    setOldestSeq(null);
    setHasMore(true);
    // Subscribe before loading so no live entry falls between the page and the stream.
    const off = store.onTranscript((e) => {
      if (e.type !== "transcript.appended" || e.payload.agentId !== agentId) return;
      setRows((current) => {
        const known = new Set(current.map((r) => r.key));
        return [...current, ...rowsOf(e).filter((r) => !known.has(r.key))];
      });
    });
    void loadOlder();
    return off;
  }, [agentId]);

  return { rows, hasMore, loading: action.busy, error: action.error, loadOlder: () => oldestSeq !== null && void loadOlder(oldestSeq) };
}

// Who sent a message the agent received, and whether it interrupted the agent.
function MessageLabel({ messageId }: { messageId: string }) {
  const t = useT();
  const state = useRoomStore().state!;
  const msg = state.messages[messageId];
  if (!msg) return null;
  return (
    <div className="entry-from">
      {actorName(state, msg.from)}
      {msg.delivery === "steer" && ` · ${t("agent.interrupt")}`}
    </div>
  );
}

// Messages the agent has not received yet, e.g. while its runner is offline.
function PendingMessages({ agentId }: { agentId: string }) {
  const t = useT();
  const state = useRoomStore().state!;
  const pending = Object.values(state.messages)
    .filter((m) => m.toAgentId === agentId && m.deliveredAt === null)
    .sort((a, b) => a.sentAt - b.sentAt);
  if (pending.length === 0) return null;
  return (
    <div className="pending-messages">
      {pending.map((m) => (
        <div key={m.id} className="entry user pending" data-testid="pending-message">
          <div className="entry-from">
            {actorName(state, m.from)} · {t("agent.pending")}
          </div>
          {m.text}
        </div>
      ))}
    </div>
  );
}

function Transcript({ agentId }: { agentId: string }) {
  const t = useT();
  const { rows, hasMore, loading, error, loadOlder } = useTranscript(agentId);
  const parentRef = useRef<HTMLDivElement>(null);
  const stickToBottom = useRef(true);
  const virtualizer = useVirtualizer({ count: rows.length, getScrollElement: () => parentRef.current, estimateSize: () => 48, overscan: 12 });

  useEffect(() => {
    if (stickToBottom.current && rows.length > 0) virtualizer.scrollToIndex(rows.length - 1, { align: "end" });
  }, [rows.length, virtualizer]);

  return (
    <div
      className="transcript"
      ref={parentRef}
      data-testid="transcript"
      onScroll={(e) => {
        const el = e.currentTarget;
        stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
      }}
    >
      <div style={{ padding: 10, textAlign: "center" }}>
        {hasMore && rows.length > 0 && (
          <button className="ghost" onClick={loadOlder} disabled={loading}>
            {t("agent.loadOlder")}
          </button>
        )}
        {!loading && rows.length === 0 && <span className="faint">{t("agent.noTranscript")}</span>}
        {error && <span className="error">{error}</span>}
      </div>
      <div style={{ height: virtualizer.getTotalSize(), position: "relative" }}>
        {virtualizer.getVirtualItems().map((item) => {
          const row = rows[item.index]!;
          return (
            <div
              key={row.key}
              ref={virtualizer.measureElement}
              data-index={item.index}
              className={`entry ${row.entry.kind}`}
              style={{ position: "absolute", top: 0, left: 0, right: 0, transform: `translateY(${item.start}px)` }}
            >
              {row.entry.messageId && <MessageLabel messageId={row.entry.messageId} />}
              {row.entry.text}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function Approvals({ agentId }: { agentId: string }) {
  const t = useT();
  const store = useRoomStore();
  const action = useAction();
  const pending = Object.values(store.state!.approvals).filter((a) => a.agentId === agentId && a.state === "pending");
  const decide = (approvalId: string, decision: "allowed" | "denied") => void action.run(() => store.append([draft("approval.decided", { approvalId, decision })]));
  return (
    <>
      {pending.map((a) => (
        <div className="approval" key={a.id} data-testid="approval">
          <strong>
            {t("agent.approvalTitle")} · {a.tool}
          </strong>
          <pre>{a.input}</pre>
          <div className="row">
            <button className="primary" disabled={action.busy} onClick={() => decide(a.id, "allowed")}>
              {t("agent.allow")}
            </button>
            <button disabled={action.busy} onClick={() => decide(a.id, "denied")}>
              {t("agent.deny")}
            </button>
          </div>
        </div>
      ))}
      {action.error && <span className="error">{action.error}</span>}
    </>
  );
}

function Composer({ agentId }: { agentId: string }) {
  const t = useT();
  const store = useRoomStore();
  const action = useAction();
  const [text, setText] = useState("");
  const [delivery, setDelivery] = useState<Delivery>("fyi");
  const send = () =>
    void action
      .run(() => store.append([draft("message.sent", { messageId: newId(), toAgentId: agentId, text, delivery })]))
      .then((ok) => ok && setText(""));
  return (
    <div className="stack" style={{ gap: 6 }}>
      <div className="composer">
        <textarea
          rows={2}
          value={text}
          placeholder={t("agent.messagePlaceholder")}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && text.trim() && !action.busy) send();
          }}
        />
        <div className="stack" style={{ gap: 6 }}>
          <select value={delivery} onChange={(e) => setDelivery(e.target.value as Delivery)} aria-label="delivery">
            <option value="fyi">{t("agent.fyi")}</option>
            <option value="steer">{t("agent.steer")}</option>
          </select>
          <button className="primary" disabled={action.busy || !text.trim()} onClick={send}>
            {t("agent.send")}
          </button>
        </div>
      </div>
      {action.error && <span className="error">{action.error}</span>}
    </div>
  );
}

export function AgentPage({ agentId }: { agentId: string }) {
  const t = useT();
  const reasonText = useReasonText();
  const { lang } = useContext(LanguageContext);
  const store = useRoomStore();
  useRoomVersion(store);
  const now = useNow();
  const state = store.state!;
  const agent = state.agents[agentId];
  if (!agent) return <div className="panel">{t("agent.notFound")}</div>;
  const status = agentStatus(state, agent, store.onlineRunnerIds, now);
  const runner = state.runners[agent.runnerId];
  const wt = agent.worktreeId ? state.worktrees[agent.worktreeId] : undefined;

  return (
    <div className="agent-page">
      <div className="agent-main">
        <div className="row">
          <StatusDot level={status.level} />
          <h2>{agent.name}</h2>
          <span className="pill">{t(`agent.${agent.role}`)}</span>
          {status.reasons.length > 0 && <span className="faint">{status.reasons.map(reasonText).join(" · ")}</span>}
        </div>
        <Transcript agentId={agentId} />
        <div className="stack" style={{ gap: 10 }}>
          <PendingMessages agentId={agentId} />
          <Approvals agentId={agentId} />
          <Composer agentId={agentId} />
        </div>
      </div>
      <aside className="panel">
        <dl className="facts">
          <dt>{t("agent.goal")}</dt>
          <dd>{goalPath(state, agent.goalId).map((g) => g.title).join(" → ")}</dd>
          <dt>{t("agent.group")}</dt>
          <dd>{agentGroup(state, agent)?.name ?? t("agent.standalone")}</dd>
          <dt>{t("agent.provider")}</dt>
          <dd>
            {agent.provider} · {agent.model}
          </dd>
          <dt>{t("agent.owner")}</dt>
          <dd>{state.members[agent.memberId]?.displayName}</dd>
          <dt>{t("agent.runner")}</dt>
          <dd>
            {runner?.hostname} {!store.onlineRunnerIds.includes(agent.runnerId) && <span className="pill">{t("agent.runnerOffline")}</span>}
          </dd>
          <dt>{t("agent.process")}</dt>
          <dd>
            {agent.process}
            {agent.processDetail ? ` (${agent.processDetail})` : ""}
          </dd>
          <dt>{t("agent.activity")}</dt>
          <dd>
            {t(`activity.${agent.activity}`)} · {timeAgo(agent.lastEventAt, now, lang)}
          </dd>
          <dt>{t("agent.phase")}</dt>
          <dd>
            {agent.phase ? `${agent.phase.value}${agent.phase.note ? ` — ${agent.phase.note}` : ""}` : t("agent.noPhase")}
          </dd>
          {wt && (
            <>
              <dt>{t("agent.branch")}</dt>
              <dd>
                <code>{wt.branch}</code> · +{wt.diffStat.insertions} −{wt.diffStat.deletions}
              </dd>
            </>
          )}
          <dt>{t("agent.session")}</dt>
          <dd>
            {agent.resumability}
            {agent.resumabilityDetail ? ` (${agent.resumabilityDetail})` : ""}
          </dd>
        </dl>
      </aside>
    </div>
  );
}

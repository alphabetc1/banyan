// Leaderboard: for each goal with a metric, the results agents submitted, ranked by the value
// their runner verified on the submitted commit, with what each one built on. Results still
// being verified and those that failed verification are listed apart.
import { useContext, useState } from "react";
import { leaderboard, type Goal, type Result } from "@banyan/shared";
import { timeAgo, useNow } from "../components/common.tsx";
import { useRoomStore } from "../contexts.ts";
import { LanguageContext, useT } from "../i18n.ts";
import { useRoomVersion } from "../room-store.ts";

function GoalBoard({ goal }: { goal: Goal }) {
  const t = useT();
  const { lang } = useContext(LanguageContext);
  const store = useRoomStore();
  const now = useNow();
  const [showFailed, setShowFailed] = useState(false);
  const state = store.state!;
  const metric = goal.metric!;
  const ranked = leaderboard(state, goal.id);
  const rankOf = new Map(ranked.map((r, i) => [r.id, i + 1]));
  const results = Object.values(state.results).filter((r) => r.goalId === goal.id);
  const pending = results.filter((r) => r.status === "pending");
  const failed = results.filter((r) => r.status === "failed");
  const agentName = (r: Result) => state.agents[r.agentId]?.name ?? r.agentId;
  const unit = metric.unit ? ` ${metric.unit}` : "";
  // What a result built on: its rank when that one ranks, else who submitted it.
  const basedOn = (r: Result) => {
    const base = r.basedOn ? state.results[r.basedOn] : undefined;
    if (!base) return "";
    const rank = rankOf.get(base.id);
    return rank ? `#${rank} ${agentName(base)}` : agentName(base);
  };
  return (
    <section className="panel stack" data-testid={`board-${goal.title}`}>
      <div className="stack" style={{ gap: 2 }}>
        <h3>{goal.title}</h3>
        <span className="faint">
          {metric.name} · {t(`metric.${metric.direction}`)}
          {unit && ` ·${unit}`} · <code>{metric.command}</code>
        </span>
      </div>
      {ranked.length === 0 ? (
        <div className="faint">{t("leaderboard.noResults")}</div>
      ) : (
        <table className="board">
          <thead>
            <tr>
              <th>#</th>
              <th>{t("leaderboard.value")}</th>
              <th>{t("leaderboard.agent")}</th>
              <th>{t("leaderboard.basedOn")}</th>
              <th>{t("leaderboard.commit")}</th>
              <th>{t("leaderboard.note")}</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {ranked.map((r, i) => (
              <tr key={r.id} data-testid={`result-${i + 1}`}>
                <td>{i + 1}</td>
                <td className="value" title={`${t("leaderboard.claimed")} ${r.claimed}${unit}`}>
                  {r.value}
                  {unit}
                </td>
                <td>{agentName(r)}</td>
                <td>{basedOn(r)}</td>
                <td>
                  <code>{r.commitSha.slice(0, 8)}</code>
                </td>
                <td className="note">{r.note}</td>
                <td className="faint">{timeAgo(r.verifiedAt ?? r.submittedAt, now, lang)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {pending.length > 0 && (
        <div className="stack" style={{ gap: 4 }} data-testid="results-pending">
          <strong>{t("leaderboard.pending")}</strong>
          {pending.map((r) => (
            <span key={r.id} className="faint">
              {agentName(r)} · {t("leaderboard.claimed")} {r.claimed}
              {unit} · <code>{r.commitSha.slice(0, 8)}</code>
            </span>
          ))}
        </div>
      )}
      {failed.length > 0 && (
        <div data-testid="results-failed">
          <button className="ghost" aria-expanded={showFailed} onClick={() => setShowFailed(!showFailed)}>
            {t("leaderboard.failed")} ({failed.length})
          </button>
          {showFailed &&
            failed.map((r) => (
              <div key={r.id} className="post">
                <span>
                  {agentName(r)} · {t("leaderboard.claimed")} {r.claimed}
                  {unit} · <code>{r.commitSha.slice(0, 8)}</code>
                </span>
                <span className="error">{r.failure}</span>
                {r.log && <pre className="log">{r.log}</pre>}
              </div>
            ))}
        </div>
      )}
    </section>
  );
}

export function LeaderboardPage() {
  const t = useT();
  const store = useRoomStore();
  useRoomVersion(store);
  const goals = Object.values(store.state!.goals)
    .filter((g) => g.metric !== null)
    .sort((a, b) => a.createdAt - b.createdAt);
  return (
    <div className="stack leaderboard">
      {goals.length === 0 && <div className="panel faint">{t("leaderboard.empty")}</div>}
      {goals.map((g) => (
        <GoalBoard key={g.id} goal={g} />
      ))}
    </div>
  );
}

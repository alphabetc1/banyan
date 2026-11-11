// What each agent is exploring: worktrees grouped by goal, with direction, diff and latest finding.
import { useContext } from "react";
import { goalPath, type Worktree } from "@banyan/shared";
import { StatusDot, timeAgo, useNow } from "../components/common.tsx";
import { useRoomStore } from "../contexts.ts";
import { agentStatus, latestPost } from "../derive.ts";
import { LanguageContext, useT } from "../i18n.ts";
import { useRoomVersion } from "../room-store.ts";
import { linkProps } from "../router.ts";

function DiffBar({ wt }: { wt: Worktree }) {
  const total = wt.diffStat.insertions + wt.diffStat.deletions;
  const ins = total === 0 ? 0 : (wt.diffStat.insertions / total) * 100;
  return (
    <div className="row" style={{ gap: 8 }}>
      <div className="diffbar">
        <div className="ins" style={{ width: `${ins}%` }} />
        <div className="del" style={{ width: `${total === 0 ? 0 : 100 - ins}%` }} />
      </div>
      <span className="faint">
        {wt.diffStat.files} files · +{wt.diffStat.insertions} −{wt.diffStat.deletions}
      </span>
    </div>
  );
}

export function WorktreesPage() {
  const t = useT();
  const { lang } = useContext(LanguageContext);
  const store = useRoomStore();
  useRoomVersion(store);
  const now = useNow();
  const state = store.state!;
  const worktrees = Object.values(state.worktrees);

  // Group worktrees by the full goal path of their agent, so sibling explorations sit together.
  const byGoal = new Map<string, Worktree[]>();
  for (const wt of worktrees) {
    const agent = state.agents[wt.agentId];
    if (!agent) continue;
    const list = byGoal.get(agent.goalId) ?? [];
    list.push(wt);
    byGoal.set(agent.goalId, list);
  }

  return (
    <div className="stack">
      <h2>{t("worktrees.title")}</h2>
      {worktrees.length === 0 && <div className="panel faint">{t("worktrees.empty")}</div>}
      {[...byGoal.entries()].map(([goalId, list]) => (
        <section key={goalId} className="group-section">
          <header>
            <h3>
              {goalPath(state, goalId)
                .map((g) => g.title)
                .join(" → ")}
            </h3>
          </header>
          <div className="cards">
            {list.map((wt) => {
              const agent = state.agents[wt.agentId]!;
              const direction = latestPost(state, agent.id, "direction");
              const finding = latestPost(state, agent.id, "finding") ?? latestPost(state, agent.id, "conclusion");
              return (
                <a key={wt.id} className="card" data-testid={`worktree-${agent.name}`} {...linkProps(`/rooms/${store.roomId}/agents/${agent.id}`)}>
                  <div className="name">
                    <StatusDot level={agentStatus(state, agent, store.onlineRunnerIds, now).level} />
                    {agent.name}
                    <span style={{ flex: 1 }} />
                    <span className="faint">{timeAgo(wt.updatedAt, now, lang)}</span>
                  </div>
                  <code className="faint">{wt.branch}</code>
                  <DiffBar wt={wt} />
                  <div>
                    <div className="faint">{t("worktrees.direction")}</div>
                    <div>{direction ? direction.summary : <span className="faint">{t("worktrees.noDirection")}</span>}</div>
                    {direction?.body && <div className="reasons">{direction.body}</div>}
                  </div>
                  {finding && (
                    <div>
                      <div className="faint">{t("worktrees.latestFinding")}</div>
                      <div className="reasons">{finding.summary}</div>
                    </div>
                  )}
                </a>
              );
            })}
          </div>
        </section>
      ))}
    </div>
  );
}

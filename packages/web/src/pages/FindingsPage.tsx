// Findings board: awaiting review, shared within groups, and shared with the whole room.
// Humans may approve or reject any post, overriding leaders.
import { useContext } from "react";
import { draft, type Post } from "@banyan/shared";
import { timeAgo, useAction, useNow } from "../components/common.tsx";
import { useRoomStore } from "../contexts.ts";
import { actorName, postColumn, type PostColumn } from "../derive.ts";
import { LanguageContext, useT, type MessageKey } from "../i18n.ts";
import { useRoomVersion } from "../room-store.ts";

const COLUMNS: { id: PostColumn; label: MessageKey }[] = [
  { id: "pending", label: "findings.pending" },
  { id: "group", label: "findings.group" },
  { id: "room", label: "findings.room" },
];

function PostCard({ post }: { post: Post }) {
  const t = useT();
  const { lang } = useContext(LanguageContext);
  const store = useRoomStore();
  const now = useNow();
  const action = useAction();
  const state = store.state!;
  const review = (decision: "approved" | "rejected") => void action.run(() => store.append([draft("post.reviewed", { postId: post.id, decision })]));
  return (
    <div className="post" data-testid={`post-${post.summary}`}>
      <div className="row">
        <span className="pill">{post.kind}</span>
        <strong style={{ flex: 1 }}>{post.summary}</strong>
      </div>
      {post.body && <div className="body">{post.body}</div>}
      {post.evidence.map((ev, i) => (
        <div key={i} className="body">
          <strong>{ev.label}:</strong> {ev.detail}
        </div>
      ))}
      <div className="faint">
        {state.agents[post.agentId]?.name} · {state.goals[post.goalId]?.title} · {timeAgo(post.createdAt, now, lang)}
      </div>
      {post.review.by && (
        <div className="faint">
          {t("findings.reviewedBy")} {actorName(state, post.review.by)}
          {post.review.note ? ` — ${post.review.note}` : ""}
        </div>
      )}
      {post.proposeRoomVisible && (
        <div className="row">
          {post.review.state !== "approved" && (
            <button disabled={action.busy} onClick={() => review("approved")}>
              {t("findings.approve")}
            </button>
          )}
          {post.review.state !== "rejected" && (
            <button className="ghost" disabled={action.busy} onClick={() => review("rejected")}>
              {t("findings.reject")}
            </button>
          )}
        </div>
      )}
      {action.error && <span className="error">{action.error}</span>}
    </div>
  );
}

export function FindingsPage() {
  const t = useT();
  const store = useRoomStore();
  useRoomVersion(store);
  const posts = Object.values(store.state!.posts).sort((a, b) => b.createdAt - a.createdAt);
  return (
    <div className="columns">
      {COLUMNS.map((c) => {
        const items = posts.filter((p) => postColumn(p) === c.id);
        return (
          <section key={c.id} data-testid={`column-${c.id}`}>
            <h3 style={{ marginBottom: 12 }}>
              {t(c.label)} <span className="count">{items.length}</span>
            </h3>
            {items.length === 0 && <div className="faint">{t("findings.empty")}</div>}
            {items.map((p) => (
              <PostCard key={p.id} post={p} />
            ))}
          </section>
        );
      })}
    </div>
  );
}

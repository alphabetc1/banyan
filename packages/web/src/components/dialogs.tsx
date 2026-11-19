// Creation dialogs (goal, group, agent), renaming an agent, a goal's metric, and the invite dialog.
import { useEffect, useState } from "react";
import { draft, isGoalWithin, newId, type Agent, type Metric } from "@banyan/shared";
import { createInvite } from "../api.ts";
import { useRoomStore } from "../contexts.ts";
import { inDesktopClient, installCommand, pickRepository } from "../desktop.tsx";
import { useT } from "../i18n.ts";
import { Dialog, useAction } from "./common.tsx";

function Actions({ busy, error, onClose, submitLabel = "dialog.create" }: { busy: boolean; error: string | null; onClose: () => void; submitLabel?: "dialog.create" | "settings.save" }) {
  const t = useT();
  return (
    <>
      {error && <span className="error">{error}</span>}
      <div className="row" style={{ justifyContent: "flex-end" }}>
        <button type="button" className="ghost" onClick={onClose}>
          {t("dialog.cancel")}
        </button>
        <button className="primary" disabled={busy}>
          {t(submitLabel)}
        </button>
      </div>
    </>
  );
}

export function NewGoalDialog({ parentId, onClose }: { parentId: string; onClose: () => void }) {
  const t = useT();
  const store = useRoomStore();
  const action = useAction();
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const parent = store.state!.goals[parentId];
  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    void action.run(() => store.append([draft("goal.created", { goalId: newId(), parentId, title, description })])).then((ok) => ok && onClose());
  };
  return (
    <Dialog title={t("overview.newGoal")} onClose={onClose}>
      <form className="stack" onSubmit={submit}>
        <span className="faint">
          {t("dialog.parentGoal")}: {parent?.title}
        </span>
        <label>
          {t("dialog.title")}
          <input required autoFocus value={title} onChange={(e) => setTitle(e.target.value)} />
        </label>
        <label>
          {t("dialog.description")}
          <textarea rows={3} value={description} onChange={(e) => setDescription(e.target.value)} />
        </label>
        <Actions busy={action.busy} error={action.error} onClose={onClose} />
      </form>
    </Dialog>
  );
}

export function NewGroupDialog({ goalId, onClose }: { goalId: string; onClose: () => void }) {
  const t = useT();
  const store = useRoomStore();
  const action = useAction();
  const [name, setName] = useState("");
  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    void action.run(() => store.append([draft("group.created", { groupId: newId(), goalId, name })])).then((ok) => ok && onClose());
  };
  return (
    <Dialog title={t("overview.newGroup")} onClose={onClose}>
      <form className="stack" onSubmit={submit}>
        <label>
          {t("dialog.groupName")}
          <input required autoFocus value={name} onChange={(e) => setName(e.target.value)} />
        </label>
        <Actions busy={action.busy} error={action.error} onClose={onClose} />
      </form>
    </Dialog>
  );
}

const LAST_REPO_KEY = "banyan.lastRepoPath";

function lastRepoPath(): string {
  try {
    return localStorage.getItem(LAST_REPO_KEY) ?? "";
  } catch {
    return "";
  }
}

function rememberRepoPath(path: string): void {
  try {
    localStorage.setItem(LAST_REPO_KEY, path);
  } catch {
    // Remembered for this page view only.
  }
}

const KINDS = ["claude", "codex", "shell"] as const;

// A new agent: by default a standalone one in its CLI's own terminal, in a repository on this
// machine. Coordination (goal, group, role, instructions, managed mode) is an extra.
export function NewAgentDialog({ goalId, onClose }: { goalId: string; onClose: () => void }) {
  const t = useT();
  const store = useRoomStore();
  const state = store.state!;
  const action = useAction();
  const groups = Object.values(state.groups).filter((g) => isGoalWithin(state, g.goalId, goalId));
  const myRunners = Object.values(state.runners).filter((r) => r.memberId === store.memberId);
  // A room without a shared fork needs every agent to name a repository; the last one used is
  // the likely next one.
  const needsRepo = !state.room?.repoUrl;
  const [form, setForm] = useState({
    provider: "claude" as Agent["provider"],
    name: "",
    repoPath: needsRepo ? lastRepoPath() : "",
    runnerId: myRunners[0]?.id ?? "",
    groupId: "",
    role: "worker" as Agent["role"],
    agentGoalId: goalId,
    instructions: "",
    // Without a terminal, for machines nobody watches.
    managed: false,
  });
  const [pickError, setPickError] = useState<string | null>(null);
  const pick = () => {
    setPickError(null);
    void pickRepository(form.repoPath || lastRepoPath()).then(
      (path) => path && setForm((f) => ({ ...f, repoPath: path })),
      (e: Error) => setPickError(e.message),
    );
  };
  const set = (k: keyof typeof form) => (e: { target: { value: string } }) => setForm({ ...form, [k]: e.target.value });
  // An empty groupId means a standalone agent, which can only be a worker.
  const group = form.groupId ? state.groups[form.groupId] : undefined;
  const goalChoices = Object.values(state.goals).filter((g) => isGoalWithin(state, g.id, group?.goalId ?? goalId));
  const takenRoles = new Set([!group || group.leaderAgentId ? "leader" : "", !group || group.monitorAgentId ? "monitor" : ""]);
  const setGroup = (e: { target: { value: string } }) => {
    const next = e.target.value ? state.groups[e.target.value] : undefined;
    setForm({ ...form, groupId: e.target.value, ...(next ? { agentGoalId: next.goalId } : { role: "worker" as const }) });
  };
  const shell = form.provider === "shell";
  // A plain managed session starts on its instructions, so they are needed then.
  const plain = shell || (state.room?.personal === true && form.groupId === "");
  const needsInstructions = plain && form.managed && !shell;

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const repoPath = form.repoPath.trim();
    if (repoPath) rememberRepoPath(repoPath);
    void action
      .run(() =>
        store.append([
          draft("agent.created", {
            agentId: newId(),
            name: form.name,
            provider: form.provider,
            model: "default",
            runnerId: form.runnerId,
            groupId: form.groupId || null,
            role: shell ? "worker" : form.role,
            goalId: form.agentGoalId,
            instructions: shell ? "" : form.instructions,
            ...(repoPath ? { repoPath } : {}),
            ...(shell || !form.managed ? { terminal: true } : {}),
          }),
        ]),
      )
      .then((ok) => ok && onClose());
  };
  return (
    <Dialog title={t("overview.newAgent")} onClose={onClose}>
      <form className="stack" onSubmit={submit}>
        {myRunners.length === 0 && <span className="error">{t(inDesktopClient ? "dialog.noRunnerDesktop" : "dialog.noRunnerBrowser")}</span>}
        <div className="segmented" role="radiogroup" aria-label={t("dialog.kind")}>
          {KINDS.map((k) => (
            <button key={k} type="button" role="radio" aria-checked={form.provider === k} className={form.provider === k ? "selected" : ""} onClick={() => setForm({ ...form, provider: k })}>
              {t(`dialog.kind.${k}`)}
            </button>
          ))}
        </div>
        <label>
          {t("dialog.agentName")}
          <input required autoFocus value={form.name} onChange={set("name")} />
        </label>
        <label>
          {t(needsRepo ? "dialog.repoPath" : "dialog.repoPathOptional")}
          <div className="row">
            <input required={needsRepo} value={form.repoPath} onChange={set("repoPath")} placeholder="~/code/sglang" />
            {inDesktopClient && (
              <button type="button" onClick={pick}>
                {t("dialog.pickRepo")}
              </button>
            )}
          </div>
        </label>
        {pickError && <span className="error">{pickError}</span>}
        {myRunners.length > 1 && (
          <label>
            {t("dialog.runner")}
            <select value={form.runnerId} onChange={set("runnerId")} required>
              {myRunners.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.hostname}
                </option>
              ))}
            </select>
          </label>
        )}
        {!shell && (
          <details className="addon" open={needsInstructions || undefined}>
            <summary>{t("dialog.coordination")}</summary>
            <div className="stack">
              <div className="row">
                <label style={{ flex: 1 }}>
                  {t("agent.group")}
                  <select value={form.groupId} onChange={setGroup}>
                    <option value="">{t("dialog.noGroup")}</option>
                    {groups.map((g) => (
                      <option key={g.id} value={g.id}>
                        {g.name}
                      </option>
                    ))}
                  </select>
                </label>
                <label style={{ flex: 1 }}>
                  {t("dialog.role")}
                  <select value={form.role} onChange={set("role")}>
                    {(["worker", "leader", "monitor"] as const).map((r) => (
                      <option key={r} value={r} disabled={takenRoles.has(r)}>
                        {t(`agent.${r}`)}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
              <label>
                {t("dialog.agentGoal")}
                <select value={form.agentGoalId} onChange={set("agentGoalId")}>
                  {goalChoices.map((g) => (
                    <option key={g.id} value={g.id}>
                      {g.title}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                {t("dialog.instructions")}
                <textarea rows={3} value={form.instructions} onChange={set("instructions")} required={needsInstructions} />
              </label>
              <label className="row" style={{ gap: 8 }}>
                <input type="checkbox" checked={form.managed} onChange={(e) => setForm({ ...form, managed: e.target.checked })} style={{ width: "auto" }} />
                {t("dialog.managed")}
              </label>
            </div>
          </details>
        )}
        <Actions busy={action.busy || myRunners.length === 0} error={action.error} onClose={onClose} />
      </form>
    </Dialog>
  );
}

export function RenameAgentDialog({ agentId, onClose }: { agentId: string; onClose: () => void }) {
  const t = useT();
  const store = useRoomStore();
  const action = useAction();
  const [name, setName] = useState(store.state!.agents[agentId]?.name ?? "");
  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    void action.run(() => store.append([draft("agent.renamed", { agentId, name: name.trim() })])).then((ok) => ok && onClose());
  };
  return (
    <Dialog title={t("agent.renameTitle")} onClose={onClose}>
      <form className="stack" onSubmit={submit}>
        <label>
          {t("dialog.agentName")}
          <input required autoFocus maxLength={500} value={name} onChange={(e) => setName(e.target.value)} onFocus={(e) => e.target.select()} />
        </label>
        <Actions busy={action.busy || !name.trim()} error={action.error} onClose={onClose} submitLabel="settings.save" />
      </form>
    </Dialog>
  );
}

export function MetricDialog({ goalId, onClose }: { goalId: string; onClose: () => void }) {
  const t = useT();
  const store = useRoomStore();
  const action = useAction();
  const current = store.state!.goals[goalId]?.metric ?? null;
  const [metric, setMetric] = useState<Metric>(current ?? { name: "", direction: "higher", unit: "", command: "" });
  const set = (patch: Partial<Metric>) => setMetric({ ...metric, ...patch });
  const save = (value: Metric | null) => void action.run(() => store.append([draft("goal.metric_set", { goalId, metric: value })])).then((ok) => ok && onClose());
  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    save({ ...metric, name: metric.name.trim(), unit: metric.unit.trim(), command: metric.command.trim() });
  };
  return (
    <Dialog title={t("metric.title")} onClose={onClose}>
      <form className="stack" onSubmit={submit}>
        <label>
          {t("metric.name")}
          <input required autoFocus maxLength={100} value={metric.name} onChange={(e) => set({ name: e.target.value })} placeholder="prefill throughput" />
        </label>
        <div className="segmented" role="radiogroup" aria-label={t("metric.direction")}>
          {(["higher", "lower"] as const).map((d) => (
            <button key={d} type="button" role="radio" aria-checked={metric.direction === d} className={metric.direction === d ? "selected" : ""} onClick={() => set({ direction: d })}>
              {t(`metric.${d}`)}
            </button>
          ))}
        </div>
        <label>
          {t("metric.unit")}
          <input maxLength={20} value={metric.unit} onChange={(e) => set({ unit: e.target.value })} placeholder="tok/s" />
        </label>
        <label>
          {t("metric.command")}
          <textarea required rows={2} maxLength={2000} className="mono" value={metric.command} onChange={(e) => set({ command: e.target.value })} placeholder="python bench.py --model llama-8b | tail -1" spellCheck={false} />
        </label>
        <span className="faint">{t("metric.commandHint")}</span>
        {action.error && <span className="error">{action.error}</span>}
        <div className="row">
          {current && (
            <button type="button" className="ghost" disabled={action.busy} onClick={() => save(null)}>
              {t("metric.remove")}
            </button>
          )}
          <span style={{ flex: 1 }} />
          <button type="button" className="ghost" onClick={onClose}>
            {t("dialog.cancel")}
          </button>
          <button className="primary" disabled={action.busy || !metric.name.trim() || !metric.command.trim()}>
            {t("settings.save")}
          </button>
        </div>
      </form>
    </Dialog>
  );
}

export function CopyField({ value, testId }: { value: string; testId: string }) {
  const t = useT();
  const [copied, setCopied] = useState(false);
  return (
    <div className="row">
      <input readOnly value={value} data-testid={testId} onFocus={(e) => e.target.select()} />
      <button
        type="button"
        onClick={() =>
          void navigator.clipboard.writeText(value).then(
            () => setCopied(true),
            () => setCopied(false),
          )
        }
      >
        {copied ? t("invite.copied") : t("invite.copy")}
      </button>
    </div>
  );
}

export function InviteDialog({ onClose }: { onClose: () => void }) {
  const t = useT();
  const store = useRoomStore();
  const action = useAction();
  const [inviteToken, setInviteToken] = useState<string | null>(null);
  useEffect(() => {
    // One invite per opening of the dialog.
    void action.run(async () => setInviteToken((await createInvite("", store.roomId, store.token)).inviteToken));
  }, []);
  const origin = window.location.origin;
  return (
    <Dialog title={t("invite.title")} onClose={onClose}>
      <span className="muted">{t("invite.link")}</span>
      {inviteToken && <CopyField testId="invite-link" value={`${origin}/join/${store.roomId}#invite=${inviteToken}`} />}
      {action.error && <span className="error">{action.error}</span>}
      <span className="muted">{t("invite.desktop")}</span>
      <CopyField testId="install-command" value={installCommand(origin)} />
      <span className="muted">{t("invite.runner")}</span>
      <CopyField testId="runner-command" value={`banyan-runner register --server ${origin} --room ${store.roomId} --member-token ${store.token}`} />
      <div className="row" style={{ justifyContent: "flex-end" }}>
        <button className="ghost" onClick={onClose}>
          {t("dialog.cancel")}
        </button>
      </div>
    </Dialog>
  );
}

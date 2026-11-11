// Creation dialogs (goal, group, agent) and the invite dialog.
import { useEffect, useState } from "react";
import { draft, isGoalWithin, newId, type Agent } from "@banyan/shared";
import { createInvite } from "../api.ts";
import { useRoomStore } from "../contexts.ts";
import { inDesktopClient, installCommand } from "../desktop.tsx";
import { useT } from "../i18n.ts";
import { Dialog, useAction } from "./common.tsx";

function Actions({ busy, error, onClose }: { busy: boolean; error: string | null; onClose: () => void }) {
  const t = useT();
  return (
    <>
      {error && <span className="error">{error}</span>}
      <div className="row" style={{ justifyContent: "flex-end" }}>
        <button type="button" className="ghost" onClick={onClose}>
          {t("dialog.cancel")}
        </button>
        <button className="primary" disabled={busy}>
          {t("dialog.create")}
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

export function NewAgentDialog({ goalId, onClose }: { goalId: string; onClose: () => void }) {
  const t = useT();
  const store = useRoomStore();
  const state = store.state!;
  const action = useAction();
  const groups = Object.values(state.groups).filter((g) => g.goalId === goalId);
  const myRunners = Object.values(state.runners).filter((r) => r.memberId === store.memberId);
  const [form, setForm] = useState({
    groupId: groups[0]?.id ?? "",
    runnerId: myRunners[0]?.id ?? "",
    name: "",
    role: "worker" as Agent["role"],
    provider: "claude" as Agent["provider"],
    model: "default",
    agentGoalId: goalId,
    instructions: "",
  });
  const set = (k: keyof typeof form) => (e: { target: { value: string } }) => setForm({ ...form, [k]: e.target.value });
  // An empty groupId means a standalone agent, which can only be a worker.
  const group = form.groupId ? state.groups[form.groupId] : undefined;
  const goalChoices = Object.values(state.goals).filter((g) => isGoalWithin(state, g.id, group?.goalId ?? goalId));
  const takenRoles = new Set([!group || group.leaderAgentId ? "leader" : "", !group || group.monitorAgentId ? "monitor" : ""]);
  const setGroup = (e: { target: { value: string } }) => setForm({ ...form, groupId: e.target.value, ...(e.target.value ? {} : { role: "worker" as const }) });

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const { agentGoalId, groupId, ...rest } = form;
    void action.run(() => store.append([draft("agent.created", { ...rest, agentId: newId(), groupId: groupId || null, goalId: agentGoalId })])).then((ok) => ok && onClose());
  };
  return (
    <Dialog title={t("overview.newAgent")} onClose={onClose}>
      <form className="stack" onSubmit={submit}>
        {myRunners.length === 0 && <span className="error">{t(inDesktopClient ? "dialog.noRunnerDesktop" : "dialog.noRunnerBrowser")}</span>}
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
          {t("dialog.agentName")}
          <input required autoFocus value={form.name} onChange={set("name")} />
        </label>
        <div className="row">
          <label style={{ flex: 1 }}>
            {t("agent.provider")}
            <select value={form.provider} onChange={set("provider")}>
              <option value="claude">Claude</option>
              <option value="codex">Codex</option>
            </select>
          </label>
          <label style={{ flex: 1 }}>
            {t("dialog.runner")}
            <select value={form.runnerId} onChange={set("runnerId")} required>
              {myRunners.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.hostname}
                </option>
              ))}
            </select>
          </label>
        </div>
        <label>
          {t("dialog.model")}
          <input required value={form.model} onChange={set("model")} />
        </label>
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
          <textarea rows={4} value={form.instructions} onChange={set("instructions")} />
        </label>
        <Actions busy={action.busy || myRunners.length === 0} error={action.error} onClose={onClose} />
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

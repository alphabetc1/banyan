// UI strings in Chinese and English. Agent-produced content is shown as written.
import { createContext, useContext } from "react";
import type { StatusReason } from "./derive.ts";

const en = {
  "app.tagline": "Many agents, one tree.",
  "home.create": "Create a room",
  "home.roomName": "Room name",
  "home.repoUrl": "Fork repository URL",
  "home.baseBranch": "Base branch",
  "home.goalTitle": "Room goal",
  "home.goalDescription": "Goal description",
  "home.yourName": "Your name",
  "home.myRooms": "Your rooms",
  "home.noRooms": "You have not joined any room in this browser yet.",
  "join.title": "Join room",
  "join.invalid": "This invite link is incomplete.",
  "join.submit": "Join",
  "nav.overview": "Overview",
  "nav.worktrees": "Worktrees",
  "nav.findings": "Findings",
  "nav.coordination": "Coordination",
  "top.invite": "Invite",
  "top.offline": "Disconnected from the room server — reconnecting…",
  "top.language": "中文",
  "theme.system": "System theme",
  "theme.light": "Light",
  "theme.dark": "Dark",
  "overview.goals": "Goals",
  "overview.attention": "Needs attention",
  "overview.attentionEmpty": "Nothing needs you right now.",
  "overview.noGroups": "No group works on this goal yet.",
  "overview.newGoal": "New sub-goal",
  "overview.newGroup": "New group",
  "overview.newAgent": "New agent",
  "agent.leader": "leader",
  "agent.monitor": "monitor",
  "agent.worker": "worker",
  "agent.runnerOffline": "runner offline",
  "agent.noPhase": "no phase reported",
  "agent.approvalsWaiting": "approvals waiting",
  "agent.loadOlder": "Load older",
  "agent.noTranscript": "No transcript yet.",
  "agent.allow": "Allow",
  "agent.deny": "Deny",
  "agent.approvalTitle": "Approval needed",
  "agent.send": "Send",
  "agent.steer": "Interrupt (steer)",
  "agent.fyi": "After this turn (fyi)",
  "agent.messagePlaceholder": "Message this agent…",
  "agent.goal": "Goal",
  "agent.group": "Group",
  "agent.provider": "Provider",
  "agent.owner": "Owner",
  "agent.runner": "Runner",
  "agent.process": "Process",
  "agent.activity": "Activity",
  "agent.phase": "Phase",
  "agent.branch": "Branch",
  "agent.session": "Session",
  "agent.notFound": "Agent not found.",
  "activity.working": "working",
  "activity.idle": "idle",
  "activity.unknown": "unknown",
  "worktrees.title": "What each agent is exploring",
  "worktrees.empty": "No worktrees yet.",
  "worktrees.direction": "Direction",
  "worktrees.latestFinding": "Latest finding",
  "worktrees.noDirection": "no direction declared",
  "findings.pending": "Awaiting review",
  "findings.group": "Shared in group",
  "findings.room": "Shared with the room",
  "findings.empty": "Nothing here yet.",
  "findings.approve": "Approve",
  "findings.reject": "Reject",
  "findings.reviewedBy": "reviewed by",
  "coordination.title": "Leaders and monitors",
  "coordination.messages": "Messages",
  "coordination.empty": "No messages yet.",
  "dialog.cancel": "Cancel",
  "dialog.create": "Create",
  "dialog.title": "Title",
  "dialog.description": "Description",
  "dialog.parentGoal": "Parent goal",
  "dialog.groupName": "Group name",
  "dialog.agentName": "Agent name",
  "dialog.role": "Role",
  "dialog.model": "Model (\"default\" uses the runner's configured model)",
  "dialog.runner": "Your runner",
  "dialog.noRunner": "Register a runner first (see Invite).",
  "dialog.instructions": "Instructions",
  "dialog.agentGoal": "Agent goal",
  "invite.title": "Invite people",
  "invite.link": "Share this link (valid for 7 days):",
  "invite.runner": "Register a runner on a machine to host your agents:",
  "invite.copy": "Copy",
  "invite.copied": "Copied",
  "error.generic": "Something went wrong",
} as const;

export type MessageKey = keyof typeof en;

const zh: Record<MessageKey, string> = {
  "app.tagline": "众多 agent，同一棵树。",
  "home.create": "创建 room",
  "home.roomName": "Room 名称",
  "home.repoUrl": "Fork 仓库地址",
  "home.baseBranch": "基准分支",
  "home.goalTitle": "Room 大目标",
  "home.goalDescription": "目标说明",
  "home.yourName": "你的名字",
  "home.myRooms": "你的 room",
  "home.noRooms": "这个浏览器里还没有加入任何 room。",
  "join.title": "加入 room",
  "join.invalid": "邀请链接不完整。",
  "join.submit": "加入",
  "nav.overview": "总览",
  "nav.worktrees": "Worktree",
  "nav.findings": "结论",
  "nav.coordination": "协调",
  "top.invite": "邀请",
  "top.offline": "与 room server 断开，正在重连…",
  "top.language": "EN",
  "theme.system": "跟随系统",
  "theme.light": "亮色",
  "theme.dark": "暗色",
  "overview.goals": "目标",
  "overview.attention": "需要处理",
  "overview.attentionEmpty": "目前没有需要你处理的事。",
  "overview.noGroups": "还没有 group 在做这个目标。",
  "overview.newGoal": "新建子目标",
  "overview.newGroup": "新建 group",
  "overview.newAgent": "新建 agent",
  "agent.leader": "leader",
  "agent.monitor": "monitor",
  "agent.worker": "worker",
  "agent.runnerOffline": "runner 离线",
  "agent.noPhase": "尚未上报阶段",
  "agent.approvalsWaiting": "个审批待处理",
  "agent.loadOlder": "加载更早的记录",
  "agent.noTranscript": "还没有记录。",
  "agent.allow": "允许",
  "agent.deny": "拒绝",
  "agent.approvalTitle": "需要审批",
  "agent.send": "发送",
  "agent.steer": "立即打断（steer）",
  "agent.fyi": "本轮结束后（fyi）",
  "agent.messagePlaceholder": "给这个 agent 发消息…",
  "agent.goal": "目标",
  "agent.group": "Group",
  "agent.provider": "Provider",
  "agent.owner": "所属成员",
  "agent.runner": "Runner",
  "agent.process": "进程",
  "agent.activity": "活动",
  "agent.phase": "阶段",
  "agent.branch": "分支",
  "agent.session": "会话",
  "agent.notFound": "找不到这个 agent。",
  "activity.working": "工作中",
  "activity.idle": "空闲",
  "activity.unknown": "未知",
  "worktrees.title": "每个 agent 在探索什么",
  "worktrees.empty": "还没有 worktree。",
  "worktrees.direction": "方向",
  "worktrees.latestFinding": "最新结论",
  "worktrees.noDirection": "尚未声明方向",
  "findings.pending": "待审核",
  "findings.group": "Group 内共享",
  "findings.room": "Room 级共享",
  "findings.empty": "暂无内容。",
  "findings.approve": "批准",
  "findings.reject": "拒绝",
  "findings.reviewedBy": "审核人",
  "coordination.title": "Leader 与 monitor",
  "coordination.messages": "消息",
  "coordination.empty": "还没有消息。",
  "dialog.cancel": "取消",
  "dialog.create": "创建",
  "dialog.title": "标题",
  "dialog.description": "说明",
  "dialog.parentGoal": "父目标",
  "dialog.groupName": "Group 名称",
  "dialog.agentName": "Agent 名称",
  "dialog.role": "角色",
  "dialog.model": "模型（填 default 使用 runner 本机配置的默认模型）",
  "dialog.runner": "你的 runner",
  "dialog.noRunner": "请先注册一个 runner（见「邀请」）。",
  "dialog.instructions": "补充说明",
  "dialog.agentGoal": "Agent 目标",
  "invite.title": "邀请成员",
  "invite.link": "分享这个链接（7 天内有效）：",
  "invite.runner": "在一台机器上注册 runner 来托管你的 agent：",
  "invite.copy": "复制",
  "invite.copied": "已复制",
  "error.generic": "出错了",
};

export type Language = "zh" | "en";
export const MESSAGES: Record<Language, Record<MessageKey, string>> = { en, zh };

export function translate(lang: Language, key: MessageKey): string {
  return MESSAGES[lang][key];
}

export function reasonText(lang: Language, r: StatusReason): string {
  const zh = lang === "zh";
  switch (r.code) {
    case "runner_offline":
      return zh ? "runner 离线" : "runner offline";
    case "crashed":
      return (zh ? "已崩溃" : "crashed") + (r.detail ? `: ${r.detail}` : "");
    case "session_lost":
      return (zh ? "会话丢失" : "session lost") + (r.detail ? `: ${r.detail}` : "");
    case "approvals_overdue":
      return zh ? `${r.count} 个审批已等待 ${r.minutes} 分钟` : `${r.count} approval(s) waiting ${r.minutes} min`;
    case "approvals_waiting":
      return zh ? `${r.count} 个审批待处理` : `${r.count} approval(s) waiting for a human`;
    case "not_running":
      return zh ? "未运行" : "not running";
    case "context_full":
      return zh ? "上下文已满" : "context window full";
    case "stalled":
      return zh ? `${r.minutes} 分钟没有动静` : `no activity for ${r.minutes} min`;
    case "phase_stale":
      return zh ? `阶段「${r.phase}」${r.minutes} 分钟未更新` : `phase "${r.phase}" not updated for ${r.minutes} min`;
  }
}

export function useReasonText(): (r: StatusReason) => string {
  const { lang } = useContext(LanguageContext);
  return (r) => reasonText(lang, r);
}

export function detectLanguage(): Language {
  try {
    const saved = localStorage.getItem("banyan.lang");
    if (saved === "zh" || saved === "en") return saved;
  } catch {
    // Storage may be unavailable (private mode); fall back to the browser language.
  }
  return navigator.language.toLowerCase().startsWith("zh") ? "zh" : "en";
}

export const LanguageContext = createContext<{ lang: Language; setLang: (l: Language) => void }>({ lang: "en", setLang: () => {} });

export function useT(): (key: MessageKey) => string {
  const { lang } = useContext(LanguageContext);
  return (key) => translate(lang, key);
}

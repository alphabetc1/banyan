# Banyan 设计文档（草案 v0.2）

> 项目名 Banyan（榕树）：气生根落地成新的树干，一片林仍是一棵树——对外是 room，对内是 goal 树。
> 日期：2026-11-11

## 0. 目标与非目标

**目标（第一期全部实现）**

1. claude.ai 风格的 Web UI，显示每个 agent 的运行情况，尤其是"需要人工干预""在排队等 GPU""疑似异常"。
2. UI 响应流畅。
3. agent 可以编成 group，每个 group 有一个 leader 和一个 monitor，服务于同一个 goal。
4. Worktree 页面：能看到每个 agent 在探索什么方向。
5. 可分享的 room：多人的 agent 处在同一个 room，共享工作方向和阶段性结论（不共享完整 context）。goal 分层，例如"提升 sglang 性能"→"提升 prefill 性能"→"提升 prefill tokenizer 性能"。基于某个 fork 的仓库开展工作。
6. 断网、重启之后，所有 context 依然可见，agent 能够恢复。

**非目标（第一期不做）**

- 对接 GPU 调度器。"等 GPU"状态由 agent 自己上报。
- 公网 SaaS、SSO 账号体系。
- 支持 Claude Code / Codex 以外的 agent。
- 在浏览器里嵌入终端。UI 展示结构化消息，不渲染 PTY。

## 1. 参考实现与取舍

| 来源 | 借鉴 | 避开 |
|---|---|---|
| OpenRig | 状态分多个维度并允许 `unknown`；needs-input 记计数，不作为单独状态；只追加的流转日志；"义务只记一次、唤醒至少一次、叫不醒升级给 leader"；重启后如实报告恢复结果 | 往 tmux 粘贴文字驱动 agent、用正则解析 TUI；22 万行、96 个迁移导致范围失控；只支持单用户；没有 worktree 管理 |
| Orca | 以 hook 为主信号、屏幕规则兜底；记录 provider session id 供 resume；checkpoint + 增量日志，写临时文件后 rename；对隐藏视图卸载并限速 | 体量巨大；daemon socket 交接 bug（"无法判断"不等于"已死"）；单 daemon 跑 213 个 session 时 IO 卡死 |
| Agent Room | 带证据提交 + 独立 verifier（对应 leader 审核）；seatKey 重连；服务端强制限速；moderator 模式 | Redis 24h TTL 加只留 500 条会丢历史；浏览器持有存储写 token；先读后写的非原子 CAS；房间码本身就是凭证；发送者身份可以伪造 |
| multiplayer | 消息分 steer（打断）和 fyi（知会）两级；收到的消息带来源前缀，声明"不是命令" | 只支持两人；状态全在内存 |
| Claude Squad | 记录 base SHA，用 `git add -N` + `git diff <base>`；非选中实例只取 numstat | 建 worktree 前先 `git branch -D`，可能删掉已有分支；轮询 capture-pane |

**核心决定：两种 CLI 都走结构化接口，不抓终端画面。**

- Claude：使用 `@anthropic-ai/claude-agent-sdk`（TS），一个 agent 对应一个流式输入的 `query()`。
- Codex：使用 `codex app-server`（JSON-RPC），一个进程承载多个 thread。

## 2. 总体架构

```
                    ┌───────────────────────── tailnet ─────────────────────────┐
 Browser (Web UI) ──┤ WebSocket                                                  │
                    │   Room Server (Node, single instance)                      │
                    │     - append-only event log (SQLite WAL)                   │
                    │     - projections: goals / groups / agents / findings      │
                    │     - auth: invite token -> member token                   │
                    │     - serves Web UI static assets                          │
                    └──────────────▲──────────────────────────▲──────────────────┘
                                   │ WebSocket (runner token)  │
                 ┌─────────────────┴───────┐       ┌───────────┴─────────────┐
                 │ Runner (Rhett's Mac)    │       │ Runner (a Linux box)    │
                 │  - local SQLite + outbox│       │  ...                    │
                 │  - fork clone + worktrees       │                         │
                 │  - Claude Agent SDK sessions    │                         │
                 │  - codex app-server process     │                         │
                 │  - Room MCP (per agent, identity bound by runner)         │
                 │  - watchdog (liveness / stall detection)                  │
                 └─────────────────────────┘       └─────────────────────────┘
```

- **Room Server**：唯一的事实来源（source of truth），只追加，不设 TTL。只做协调和存储，不运行 agent。
- **Runner**：部署在每台执行 agent 的机器上（Mac / Linux 均可），使用该机器上的 Claude / Codex 订阅凭证。与 server 断开时 agent 照常运行，事件先写入本地 outbox。
- **Web UI**：只连 Room Server，不直接连 runner。

## 3. 核心概念与数据模型

### 3.1 Room / Goal / Group 的关系

**提议**：以 goal 树为骨架，group 挂在 goal 节点上。

- Room 有一个根 goal（大 goal），根 goal 上挂一个 room 级 group（room 级 leader + monitor）。
- 任何 goal 节点都可以挂一个 group（小 goal 的 leader + monitor + workers）。
- 每个 agent 属于且只属于一个 group，并且有自己的 session goal（可以是所属 group 的 goal，也可以是它下面的子 goal）。
- "对外是 room，对内是 group"：分享出去的是 room，进入后看到的是 goal 树和各个 group。

（已确认：按 goal 节点可以有多个 group。）

### 3.2 表结构（server 侧投影，由 event log 推导）

```ts
// All ids are ULIDs. Timestamps are epoch ms.
interface Room { id: string; name: string; repoUrl: string; baseBranch: string; rootGoalId: string; createdAt: number }
interface Member { id: string; roomId: string; displayName: string; role: "owner" | "member" }
interface Runner { id: string; roomId: string; memberId: string; hostname: string; lastSeenAt: number }

interface Goal {
  id: string; roomId: string; parentId: string | null;
  title: string; description: string;
  status: "open" | "done" | "abandoned";
}

interface Group { id: string; roomId: string; goalId: string; leaderAgentId: string | null; monitorAgentId: string | null }

interface Agent {
  id: string; roomId: string; groupId: string; runnerId: string; memberId: string;
  name: string; role: "leader" | "monitor" | "worker";
  provider: "claude" | "codex"; model: string;
  goalId: string;                    // session-level goal
  worktreeId: string | null;         // leader/monitor may have none
  providerSessionId: string | null;  // Claude session id / Codex thread id, used for resume
  state: AgentState;                 // see section 4
}

interface Worktree { id: string; agentId: string; branch: string; baseSha: string; headSha: string; diffStat: DiffStat }

interface Post {
  id: string; roomId: string; agentId: string; goalId: string;
  kind: "direction" | "finding" | "conclusion";
  summary: string; body: string; evidence: Evidence[];
  visibility: "group" | "room";      // room visibility requires leader approval
  review: { state: "pending" | "approved" | "rejected"; by: string | null; note: string | null };
}

interface ApprovalRequest {
  id: string; agentId: string; tool: string; input: unknown;
  state: "pending" | "allowed" | "denied" | "expired"; decidedBy: string | null;
}

interface Event { seq: number; roomId: string; ts: number; actor: string; type: string; payload: unknown; eventId: string }
```

- `Event` 是唯一的写入路径，其余表都是由它推导的投影，可以重建。
- `eventId` 由产生方生成（runner / UI），server 按它去重，所以重放离线 outbox 是幂等的。

## 4. Agent 状态模型（"一眼看出谁出了问题"）

状态拆成正交的几个维度，任何一个维度都允许取 `unknown`：

| 维度 | 取值 | 来源 |
|---|---|---|
| process | `running` / `exited` / `crashed` / `unknown` | runner 进程监控 |
| activity | `working` / `idle` / `unknown` | SDK 事件流；Codex `thread/status/changed` |
| needsHuman | 待处理的审批 / 提问计数 | Claude `canUseTool` 挂起、`AskUserQuestion`；Codex `waitingOnApproval` / `waitingOnUserInput` 及审批 JSON-RPC 请求 |
| phase | agent 自报：`exploring` / `implementing` / `waiting_gpu` / `benchmarking` / `blocked` / 自由文本 + `updatedAt` | Room MCP `room_set_status`（lazy） |
| resumability | `live` / `resumable` / `context_full` / `lost` | runner 记录的 provider session id + 恢复结果 |

**派生出的健康标记**（server 计算，UI 显示成红黄绿）：

- 🔴 `crashed`、`lost`、needsHuman > 0 且等待超过 N 分钟。
- 🟡 `stalled`：activity=working，但超过 N 分钟没有任何事件；或者 phase 超过 M 小时没更新；或者连续多个 turn 报错。
- 🟢 其余情况。
- N、M 可以按 room 配置。phase 是 `waiting_gpu` 时放宽 stall 阈值。

关键点：**不依赖 agent 自报来判断死活**。agent 卡死时根本不会上报，死活由 runner 的被动信号决定，自报只补充语义。

## 5. Room MCP（agent 与 room 之间的唯一通道）

- 由 runner 在本地给每个 agent 起一个 MCP 实例。Claude 通过 SDK 的 `mcpServers` 注入并开 strict 模式；Codex 通过 `-c mcp_servers.*` 注入。
- **身份由 runner 绑定**：agent 调用工具时不需要、也无法声明自己是谁，所以不可能冒充。

| 工具 | 谁可以用 | 作用 |
|---|---|---|
| `room_get_context()` | 所有人 | 返回：goal 路径（room → … → 自己的 goal）、本 group 已批准的 direction/finding、room 级已批准的 conclusion、同 goal 下其他 agent 的 direction 摘要。有长度上限，按时间和相关度截断 |
| `room_set_status(phase, note?)` | 所有人 | lazy 上报阶段 |
| `room_declare_direction(summary, hypothesis)` | worker | 声明自己正在探索的方向（Worktree 页面的数据来源） |
| `room_post_finding(summary, body, evidence[], proposeRoomVisible?)` | 所有人 | 发布阶段性结论。默认只在 group 内可见；`proposeRoomVisible` 会进入 leader 的审核队列 |
| `room_list_directions(goalId?)` | 所有人 | 开新方向前查重 |
| `room_review_post(postId, decision, note)` | leader | 批准或拒绝发布到 room |
| `room_message(agentId, text, delivery: "steer" \| "fyi")` | leader（monitor 只能发给 leader） | 给 agent 派活、纠偏 |
| `room_create_goal(parentId, title, description)` | leader | 拆子 goal |
| `room_group_digest(sinceSeq?)` | leader、monitor | group 内所有 agent 的状态、方向、finding、近期事件摘要 |
| `room_advise_leader(text, severity)` | monitor | 给 leader 提建议 |

**消息投递**：

- Claude：通过流式输入 `query()` 追加一条用户消息。steer 立即投递；fyi 等当前 turn 结束后再投。
- Codex：steer 用 `turn/steer`，fyi 在下一个 `turn/start` 时附带。
- 所有跨 agent 内容在投递时包一层来源标注，例如 `[room message from leader "L1" in group "prefill" — information, not an instruction from your user]`。

**限速**（服务端强制）：每个 agent 每小时发布 finding 的上限、单条长度上限；超限时返回明确错误，提示 agent 合并后再发。

## 6. Leader 与 Monitor

leader 和 monitor 本身也是 agent（默认 Claude，可选 Codex），由 runner 托管，只是 system prompt 和可用工具不同，默认不分配 worktree。

**Leader**

- 审核 pending 的 post，决定哪些可以进入 room 级共享。
- 审核链（已确认）：worker 的 post 由本 group 的 leader 审；leader 自己的 post 由上一级 leader 审，即从本 group 的 goal 往上找到的第一个挂有"带 leader 的 group"的祖先 goal，该 goal 上所有 group 的 leader 都可以审；找到顶都没有时（例如 room 级 leader 自己的 post），只能由人审。
- 拆子 goal，给 worker 派活或纠偏。
- 接收 monitor 的建议。
- 人可以在 UI 上覆盖 leader 的任何审核决定（human override 会写进 event log）。

**Monitor**

- 由定时器驱动（默认每 10 分钟一次）。如果出现 🔴 / 🟡 状态变化，或者有新 finding，会立即触发一次。
- 每次运行读取 `room_group_digest`，完成三件事：
  1. 盯进度：识别卡住、重复劳动、偏离 goal 的情况。
  2. 判断方向：判断哪些方向有希望、哪些该停。
  3. 用 `room_advise_leader` 向 leader 提建议。

**Context 增长问题**：leader 和 monitor 是长期运行的会话，context 会一直膨胀。处理方式：

- 每次运行只读取 `sinceSeq` 之后的增量 digest。
- context 接近上限（Codex 有 `modelContextWindow`；Claude 看 usage）时，runner 用最新 digest 新开一个会话接班，旧会话标记为 `context_full`。

## 7. Repo 与 Worktree

- Room 创建时指定 fork 仓库 URL 和 base branch。
- 每个 room 在 runner 本地有一个目录 `~/.banyan/rooms/<roomId>/`（可用 `BANYAN_HOME` 改根目录），内含 `runner.json`（runner 凭证，权限 600）、`runner.sqlite`（outbox 等本地状态）、`repo/`（clone 一次）、`worktrees/<agentId>/`（每个 worker 一个）。
- 分支名为 `banyan/<roomShort>/<agentName>`，从 `origin/<baseBranch>` 切出，记录 `baseSha`。
- **永不强删分支**：分支名冲突时自动加后缀。清理 worktree 时如果有未合并的提交，只删 worktree，保留分支。
- runner 定期（以及每个 turn 结束时）计算 `git diff --numstat <baseSha>`（先执行 `git add -N .`），上报 diffStat。
- **跨人查看 diff**：runner 在每个 turn 结束时把分支 push 到 fork（已确认可以自动 push；push 失败时只告警，不阻塞 agent）。Worktree 页面展示 numstat、方向和 finding；完整 diff 直接用 fork 上的 compare 链接。

**Worktree 页面**：按 goal 树分组展示各 agent 的卡片，每张卡片包括分支、direction（假设）、diffStat 迷你条、最近的 finding、状态灯；可以点开时间线和 diff。

## 8. 持久化与断线重连

| 场景 | 行为 |
|---|---|
| 浏览器断网或刷新 | UI 记住 `lastSeq`；重连后先拉投影快照，再订阅 `seq > lastSeq` 的增量。transcript 按需分页加载 |
| runner 和 server 断开 | agent 继续运行；事件写入 runner 本地 SQLite outbox；重连后按顺序上报，server 按 `eventId` 去重；server 确认（ack）后才清理 outbox |
| runner 所在机器重启 | runner 启动时读取本地 SQLite，逐个 agent 用 provider session id 恢复（Claude `resume`，Codex `thread/resume`），每个 agent 如实上报结果：`resumed` / `fresh_with_digest` / `needs_attention` / `failed`，**不会悄悄从头开始** |
| server 重启 | event log 在 SQLite（WAL）里；投影可以从 log 重建；runner 和 UI 自动重连 |

**transcript 存在哪**：runner 把每个 agent 的结构化消息流（assistant / user / tool 调用摘要）上传到 server，这样任何设备打开 UI 都能看到完整 context。

**可见范围**（已确认）：room 内所有成员都能在 UI 上查看任意 agent 的完整 transcript。但完整 transcript **不会**注入其他 agent，agent 之间只共享 direction / finding / conclusion。因为 transcript 对全体成员可见，上传前同样要做 secret 脱敏。

## 9. UI

**风格**：参考 claude.ai 的视觉气质（暖色中性底、衬线标题、宽松留白），不使用任何 Anthropic 品牌元素。

**已确认的 UI 决定**：总览页用"左侧 goal 树 + 右侧卡片墙"；界面中英文可切换；主题跟随系统亮/暗并可手动切换；排版宽松留白，一屏大约 10～20 张 agent 卡片。

**页面**

1. **Room 总览**：左侧是 goal 树；中间是 group 和 agent 卡片墙（状态灯、phase、needsHuman 角标）；顶部是"需要你处理"收件箱，汇总所有待审批项和 🔴 状态。
2. **Agent 详情**：对话式 transcript；审批卡片（允许 / 拒绝 / 附言）；底部输入框用于给 agent 发消息（steer / fyi）。
3. **Worktree 页面**：见第 7 节。
4. **Findings 看板**：分 pending 审核、group 内、room 级三栏，显示来源和证据。
5. **Leader / Monitor 面板**：monitor 的建议流和 leader 的决策记录。
6. **加入 room**：打开邀请链接，填写显示名即可加入；同一页面引导安装 runner。

**流畅性的保证**

- 不渲染终端，只渲染结构化消息。这一项就避开了 Orca 在多终端渲染上的大部分复杂度。
- server 推送增量事件，UI 端按约 10Hz 合并后再渲染。
- 长列表虚拟化（agent 卡片、transcript、事件流）。
- transcript 分页、按需加载；后台标签页只更新计数，不更新内容。
- 乐观更新：审批、发消息先在本地生效，收到 server 确认后再对齐。

## 10. 安全

- server 只监听 tailnet，不暴露公网。
- 鉴权凭证有三种：
  - 邀请 token：可撤销、有有效期，server 只存 hash。
  - member token：加入时签发。
  - runner token：runner 注册时签发，绑定 member。
- 浏览器不持有任何存储凭证，所有写操作都经过 server 校验。
- agent 身份由 runner 绑定（见第 5 节）。
- 跨人内容全部标注来源，进入 room 级共享必须经过 leader 审核；人可以撤回。
- 发布内容时做 secret 脱敏（私钥、`sk-` / `ghp_` 之类的 token 模式）。
- agent 默认**不用** `bypassPermissions` / `--dangerously-*`，高风险操作走 UI 审批。每个 agent 都可以单独配置更宽松的模式，并在 UI 上明确标注。

## 11. 技术栈与仓库结构

```
banyan/                     pnpm monorepo, Node 22, TypeScript strict
  packages/shared/          event types, zod schemas, state derivation (used by all)
  packages/server/          Fastify + ws + better-sqlite3
  packages/runner/          claude-agent-sdk, codex app-server client, MCP server, watchdog
  packages/web/             React + Vite + Tailwind + TanStack Query + virtualization
```

- 锁定 Claude Agent SDK 和 Codex CLI 的版本。Codex 的类型由 `codex app-server generate-ts` 生成并提交到仓库。
- server 是单实例 + SQLite。第一期团队规模下足够；需要多实例时再迁移到 Postgres（event log 的模型不需要改）。

## 12. 测试策略

- `shared`：状态推导、投影重建做单元测试，用真实事件序列。
- `server`：用真实 SQLite 测试事件写入、去重、投影、鉴权。
- `runner`：集成测试使用**真实**的 Claude / Codex CLI 和真实 git 仓库（不 mock），覆盖：启动、MCP 工具调用、审批往返、kill 进程后 resume、断开 server 后 outbox 重放。
- e2e：真实 server + 2 个 runner（模拟两个人）+ 浏览器（Playwright），走通"加入 room → 开 agent → 发 finding → leader 审核 → 另一个人的 agent 在 `room_get_context` 中看到该 finding"的全流程。
- 测试输出必须干净；预期中的报错要捕获并断言。

## 13. 风险

| 风险 | 应对 |
|---|---|
| Codex 能否按 thread 注入 MCP | **spike 已验证可行**（见第 16 节）：同一 app-server 进程里两个 thread 各自绑定不同 MCP URL，身份互不串 |
| Codex app-server 还标着 experimental；Claude TS SDK 刚删过 API | 锁版本，类型从 schema 生成；把两种 provider 适配器隔离在 runner 内部 |
| leader / monitor 的 context 膨胀、成本上升 | 增量 digest + 自动接班（见第 6 节） |
| 共享信息噪声大，agent 被别人的结论带偏 | leader 审核 + 限速 + `room_get_context` 截断 |
| 单个 runner 托管的 agent 很多时 IO 卡住（Orca 遇到过） | 每个 agent 的事件处理互相隔离；runner 记录事件循环延迟，延迟过高时在 UI 上告警 |
| 第一期范围大 | 按第 14 节的顺序推进，每一步都可以演示 |

## 14. 第一期实现顺序（全部功能都在第一期，只是先后顺序）

1. **Spike**（约 1-2 天）：验证 Claude SDK `canUseTool` 长时间挂起、resume；Codex app-server 按 thread 注入 MCP、审批请求、`thread/resume`。
2. `shared` 事件模型 + `server` event log / 投影 / 鉴权。
3. `runner`：单个 agent（Claude 和 Codex 各一个）+ worktree + Room MCP + 状态与 watchdog。
4. `web`：总览、Agent 详情、审批。
5. goal 树、group、post 和审核流、Findings 看板、Worktree 页面。
6. leader / monitor。
7. 断线重连与重启恢复的加固（outbox、resume、如实报告恢复结果）。
8. 多人多 runner e2e，部署到内网。

## 15. 已确认的决定

1. 按 goal 节点可以有多个 group（第 3.1 节）。
2. room 内所有成员都能查看任意 agent 的完整 transcript（第 8 节）。
3. runner 自动把分支 push 到 fork（第 7 节）。
4. leader / monitor 可以用 Claude 或 Codex，默认 Claude。
5. 项目名：Banyan。npm 上 `banyan` 已被占用，内部包统一用 `@banyan/*` 且 `private: true`，不发布。

## 16. Spike 结论（2026-11-11，claude 2.1.280 / agent-sdk 0.3.322，codex-cli 0.167.0）

代码在 `spikes/`，运行 `npx tsx claude-spike.ts` / `npx tsx codex-spike.ts`，全部通过。

| 验证项 | Claude（Agent SDK） | Codex（app-server） |
|---|---|---|
| 按会话注入 HTTP MCP，身份由 URL 路径绑定 | ✅ `mcpServers` + `strictMcpConfig` | ✅ `thread/start.config.mcp_servers.<name>.url`；同进程两个 thread 身份不串 |
| 审批挂起 20s 后放行 | ✅ `canUseTool` | ✅ `item/commandExecution/requestApproval` 延迟应答 |
| "需要人工"状态信号 | `canUseTool` 被调用本身 | ✅ `thread/status/changed` 中的 `waitingOnApproval` |
| 同会话追加消息 | ✅ 流式输入（`SDKUserMessage.priority` 有 now/next/later，可直接对应 steer/fyi） | ✅ `turn/steer`（需要 `expectedTurnId`） |
| 进程被杀 / 中断后恢复上下文 | ✅ `resume: sessionId` | ✅ 新进程中 `thread/resume` |

实现时要注意：

- Claude：不要把 room 工具放进 `allowedTools`，否则会绕过 `canUseTool` 并打印警告。改为在 `canUseTool` 里对 `mcp__room__*` 直接放行。
- Claude：每个 turn 都会发一次 `system/init`，runner 不能把它当作"新会话"。
- Codex：每次调用 MCP 工具都会发 `mcpServer/elicitation/request`（工具审批）。runner 只对 room 自己的 server 自动 accept，其他 server 的请求转给 UI。
- Codex：stdio 帧格式是 JSONL，消息里没有 `jsonrpc` 字段；`initialize` 之后要发 `initialized` 通知。
- Codex 原生提供 `thread/goal/set`，可以考虑把 session goal 同步过去（待评估）。

## 17. Runner 实现要点（第 3 步）

- 用法：`banyan-runner register --server <url> --room <roomId> --member-token <token>`，然后 `banyan-runner start --room <roomId>`。
- agent 的 `model` 填 `default` 时，使用该 provider 在本机配置的默认模型。
- 审批模式：Claude 默认 `auto`（由分类器放行安全操作，拿不准时才问人）；Codex 默认 `on-request` + `workspace-write` 沙箱。e2e 测试用 Claude `default` 模式，强制每次写文件或执行命令都走人工审批。
- 新增事件 `approval.expired`：发起审批的会话结束（崩溃或 runner 重启）后，由所属 runner 把遗留的待审批项标记为过期。
- 崩溃自动重启：间隔 5 秒，连续超过 3 次就停下，等人处理；只要有一个 turn 正常结束，计数就清零。
- resume 失败时：上报 `resumability: lost` 并附原因，然后开新会话，提示 agent 从 `room_get_context` 和 git 历史恢复。
- 唤醒机制：有新 post 待审时，给审核人（leader）发一条 fyi；monitor 每 10 分钟收到一次例行检查消息（仅在空闲时发）。
- Claude 消息优先级的映射是 steer → `next`、fyi → `later`。SDK 文档里没有写明这两个值的确切语义，**尚未专门验证** steer 能否在当前 turn 内生效。

已知限制：

- runner 冷启动时必须先连上 server 拿到 room 状态，才能恢复 agent。断网状态下重启 runner，要等网络恢复后 agent 才会被拉起。
- server 还不知道 runner 是否在线。runner 掉线时，UI 只能根据事件停滞判断，计划在第 4 步（UI）补上 presence。

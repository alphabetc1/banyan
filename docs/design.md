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

**已确认的 UI 决定**：总览页用"左侧 agent 列表（带状态）+ 右侧选中 agent 的对话"（2026-11-11 Rhett 改定，原先是 goal 树 + 卡片墙，现在移到单独的「目标」页）；界面中英文可切换；主题跟随系统亮/暗并可手动切换；排版宽松留白，一屏大约 10～20 张 agent 卡片。

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
- （已在第 4 步解决）server 通过 WebSocket 连接跟踪 runner 是否在线，并广播 `presence`。

## 18. Web UI 实现要点（第 4 步）

- 开发：`pnpm --filter @banyan/web dev`（Vite，代理到 `BANYAN_SERVER`，默认 `http://127.0.0.1:7700`）。生产：`pnpm --filter @banyan/web build` 之后，room server 自动托管 `packages/web/dist`（也可以用 `BANYAN_WEB_DIR` 指定目录）。
- 演示数据：`pnpm --filter @banyan/web exec tsx scripts/demo-room.ts` 启动一个填好演示数据的 room，并打印邀请链接。
- 邀请链接格式为 `/join/<roomId>#invite=<token>`。token 放在 URL fragment 里，不会出现在 server 日志中。成员凭证只保存在浏览器的 localStorage。
- 状态复用 shared 的 `RoomConnection` 和 `applyEvent`，渲染节流到 10Hz。transcript 历史按页拉取，新内容通过实时事件追加，长列表做虚拟化。
- 卡片状态 = `deriveHealth` 加上 runner 在线状态：runner 离线时显示灰灯。健康原因是结构化的，由 UI 按当前语言渲染。
- 凭证失效或 room 不存在时，连接不再重试，页面直接显示错误。
- 测试：`pnpm --filter @banyan/web test`（派生逻辑与 i18n），`pnpm --filter @banyan/web test:e2e`（Playwright：真实 server、真实浏览器、真实 runner 连接；浏览器 console 出现任何错误或警告即判失败）。

## 19. 第一次真实试跑（2026-11-11）的结论与修复

试跑配置：`alphabetc1/sglang`，在 Rhett 的 Mac 上跑两个 runner 模拟两个人；1 个 leader + 1 个 monitor + 2 个 worker（Claude 和 Codex 各一个）；任务是只读分析 prefill 路径。Claude 部分花费约 $1.8。整条链路跑通：分工、发现、leader 审核、提交并 push 到 fork、leader 汇总结论后等待人审。

试跑暴露的问题，均已修复并补上测试：

| 问题 | 修复 |
|---|---|
| runner 优雅停机时没有排空 outbox，server 上残留过时的 `running` 状态 | `Runner.stop()` 先 `link.drain()`（最多等 5 秒），没发完的事件下次启动再补发 |
| worker 报告 done 之后，没有任何机制唤醒 leader，leader 一直空闲，不去汇总 | worker 的阶段报为 `done` 或 `blocked` 时，supervisor 给本组 leader 发一条 fyi；提示词里也要求 worker 使用这两个阶段值 |
| clone 仓库期间 agent 显示 `unknown`，看不出在做什么 | 新增进程状态 `starting`（detail 为 "preparing workspace"），UI 显示"准备工作区中" |
| Codex 的沙箱在任何情况下都禁止写 `.git`（探针实测：`writableRoots` 和 thread 级配置都无效），每次 commit 都要人工审批 | 新增 Room MCP 工具 `room_commit(message)`，由 runner 在该 agent 自己的 worktree 里提交，提交者身份是 `banyan agent <name>`；两种 provider 统一使用这个工具 |
| Codex 改文件的审批请求里没有路径，人看不出它要改什么 | 从 `item/started` 通知中记下 fileChange 的路径和 diff，放进审批内容 |

尚未处理（记录在案）：

- 每个 runner 都会完整 clone 一次仓库。同一台机器上跑多个 runner 时，可以考虑用 `--reference` 共享对象库。
- UI 还不显示每个 agent 的花费。Claude 的花费目前只出现在 transcript 里；Codex 只上报 token 用量，没有美元金额。

## 20. 桌面客户端（`packages/desktop`）

Rhett 确认的决定（2026-11-11）：做一个类似 Orca 的桌面客户端，形态是"Electron 桌面壳 + 内置 runner"，不嵌入终端，agent 仍然走结构化接口。

- **UI 来源**：窗口直接加载 room server 的 URL（首次启动时填写），不在客户端里另打包 web。UI 与 server 的版本始终一致；客户端只有在壳或 runner 改动时才需要重新发版。
- **runner**：每个 room 对应一个 runner，运行在 Electron 的 `utilityProcess` 中，复用 `@banyan/runner` 的 `Runner` 类。注册逻辑和 runner 锁由 CLI 与客户端共用（`packages/runner/src/registration.ts`）。
- **runner 锁**：`<roomDir>/runner.lock` 里记录持锁进程的 pid。同一个 room 同时只能有一个 runner（launchd 起的或客户端起的都算）；第二个启动时直接报错。如果锁文件里的 pid 已经不存在，视为陈旧锁，直接接管。
- **web ↔ 客户端**：preload 暴露 `window.banyanDesktop`。web 端只在检测到它时显示"在本机运行 agent"开关；浏览器里的行为不变。member token 只在用户打开开关时交给主进程，用于注册 runner。
- **生命周期**：关窗口只是隐藏到托盘，runner 照常运行；从托盘退出时优雅停机（先 drain outbox），下次启动走已有的 resume 流程恢复。
- **runner 崩溃**：不自动重启（Rhett 确认）。UI 显示"本机 runner 出错已停止"、退出码和日志路径，并提供"重新启动"按钮；重新启动或者重开客户端时，agent 接着原来的会话继续，之前的历史全部可见。
- **历史不丢**：transcript 条目一产生就写入 runner 的本地 outbox（SQLite），不再在内存里攒 1 秒；即使 runner 被强杀，最多丢掉 provider 还没交给 runner 的那一部分。
- **孤儿 agent 进程**：runner 被强杀后，Claude CLI 会继续执行当前 turn（实测）。现在 agent 的 CLI 进程（claude、codex app-server）都在独立的进程组里启动，并登记在 `<roomDir>/agent-processes`。客户端一发现 runner 意外退出就清理这些进程；runner 每次启动时也会清理上一次遗留的。清理顺序是先 SIGTERM，让 CLI 结束它放在其他进程组里的工具命令（实测 Claude 的 Bash 工具和 Codex 的沙箱命令都是这样），等 3 秒后再 SIGKILL。杀之前会核对命令行，避免 pid 被复用后误杀无关进程。
- **PATH**：从 Dock 启动的 GUI 应用拿不到 shell 的 PATH，启动时先从登录 shell 读取一次 PATH，否则找不到 `codex`、`git`、`gh`。
- **Claude 可执行文件**：claude-agent-sdk 0.3.322 通过按平台拆分的 optionalDependency（`@anthropic-ai/claude-agent-sdk-<platform>-<arch>`，约 320MB）自带 claude 可执行文件。打包时关闭 asar，这样这个可执行文件可以按原路径执行。Codex 用系统里安装的 `codex`。
- **better-sqlite3**：v13 自带 Node-API 预编译包，Node 和 Electron 都能直接加载，不需要按 Electron 的 ABI 重新编译。
- **打包**：`pnpm --filter @banyan/desktop dist` 在一台机器上同时打出 `Banyan-x64.dmg` 和 `Banyan-arm64.dmg`。arm64 用 `npm install --cpu=arm64` 取对应的 claude 平台包，可以在 Intel Mac 上交叉打包。安装包暂不签名。
- **一键安装**（Rhett 确认由 room server 分发）：server 提供 `/install.sh` 和 `/downloads/Banyan-<arch>.dmg`。邀请对话框和加入页会显示 `curl -fsSL <server>/install.sh | bash -s <server>`。脚本按硬件判断架构（不用 `uname -m`，因为在 Rosetta 下它会报 x86_64），装到 `/Applications`；如果客户端正在运行，就用 SIGTERM 让它优雅退出后再替换；最后用 `--server-url` 启动客户端，所以不用手动填 server 地址。用 curl 下载的文件不带 quarantine 标记，未签名的 app 不会被 Gatekeeper 拦下。
- 客户端不内置 room server，server 仍然单独部署。
- **通知**：客户端里打开 room 时，只有"自己的 runner 上的 agent"出现新的待处理项（审批、🔴、无人可审的发现）才弹系统通知；打开 room 时已经存在的项只出现在收件箱里，不弹通知。点击通知会打开对应 agent 的页面。
- **CSP**：server 给 web UI 的所有页面加上 `Content-Security-Policy`（只允许同源脚本和连接）。这个缺口是做客户端时被 Electron 的安全警告发现的，对浏览器访问同样有效。
- **测试**：`pnpm --filter @banyan/desktop test:e2e` 先打出两个架构的安装包，再用 Playwright 启动 app、连接真实 server，覆盖以下场景：
  - 开关本机 runner；关窗口后 runner 继续运行；退出时优雅停机；重启后自动恢复。
  - 锁冲突时报错；server 地址不可达时报错。
  - 在 Dock 那种精简 PATH 下运行真实的 Claude 和 Codex agent。
  - 两个真实 agent 跑到一半时用 SIGKILL 杀掉 runner：UI 报告崩溃且不自动重启，agent 进程（包括工具命令）都被结束；重开客户端后历史完整，两个 agent 都接着原来的会话完成任务。
  - 用邀请对话框里的那行命令真实安装，安装后的 app 直接打开在该 server 上；再执行一次会优雅退出正在运行的客户端并替换。
  - 两个安装包里各个可执行文件的架构都正确。

## 21. 独立 agent（不属于任何 group）

Rhett 确认的决定（2026-11-11）：支持像 Orca 那样直接创建一个个独立 agent，不用先建 group。

- **数据模型**：`agent.created` 的 `groupId` 可以为 null。旧事件里都有 groupId，重放事件日志不受影响。只有 worker 可以独立；leader 和 monitor 必须属于某个 group。
- **目标**：独立 agent 仍然挂在某个目标上，默认是当前选中的目标（例如 room 总目标）。这样 goal 树、Worktree 页面和发现分享都照常工作。
- **同伴**：独立 agent 的 `room_get_context` 返回同一目标上所有 agent 的发现和方向；`room_list_directions` 默认列出它自己目标下的方向。
- **审核**：独立 agent 提议在 room 级共享的发现，从它自己的目标开始沿目标链向上找，第一个有 leader 的 group 的 leader 负责审核；整条链上都没有 leader 时交给人（进入「需要处理」收件箱）。
- **唤醒**：独立 agent 报告 done 或 blocked 时没有 leader 可以通知，提醒的是看着 room 的人。
- **UI**：「新建 agent」对话框的 group 选项里多了「不加入 group（独立 agent）」；所选目标下还没有 group 时这是默认值。总览页在 group 上方单独显示「独立 agent」区域，包括子目标上的独立 agent。

## 22. 像 Claude Code 一样用（2026-11-11）

Rhett 确认的决定：

- **复用 Claude Code 配置**：Claude agent 加载用户本机 Claude Code 的全部配置（`settingSources: ["user", "project", "local"]`、`skills: "all"`），包括 settings、CLAUDE.md（包括从 worktree 向上找到的 CLAUDE.md）、plugins、MCP servers、hooks 和所有 skill。用户个人的 CLAUDE.md 规则会作用于他的所有 agent。在输入框里输入 `/skill名` 可以触发 skill（已用真实 API 验证）。Room MCP 仍然以 `room` 的名字注入。
- **自己发的消息看得见**：provider 不会回显输入，所以 runner 把消息交给 agent 时，会往 transcript 里写一条带 `messageId` 的 user 记录。投影据此给消息记下 `deliveredAt`。还没送达的消息在 UI 上显示为「待送达」，并标出发送者；打断（steer）的消息另有标注。这个功能上线之前发出的消息没有送达记录，会一直显示为待送达（没做兼容处理）。
- **runner 状态**：runner 连上 server 就算「运行中」，agent 在后台各自恢复，进度显示在各自的状态里。之前要等所有 agent 都恢复完才算运行中，而加载完整的 Claude Code 配置之后，恢复明显变慢，客户端会长时间显示「启动中」。
- **总览**：左侧是 agent 列表，独立 agent 排在最前，然后按 group 分组（标出 group 所在的目标）。每行显示状态灯、角色、provider、阶段、活动和待审批数；有待处理项时，列表顶部显示收件箱。右侧是选中 agent 的对话和详情，没有选中时显示列表里的第一个 agent。goal 树和卡片墙移到导航里的「目标」页。
- **导航**：点「Banyan」回到当前 room 的总览；切换到其他 room、新建或加入 room，都通过顶栏的 room 下拉菜单。

## 23. 本地优先、像 Orca 一样（2026-11-17）

Rhett 确认的方向：界面和用法像 Orca。默认打开就是本地工作区，不需要 room；右侧是真正的 Claude Code 终端，原生功能（skills、斜杠命令、/model、plan mode、状态栏、交互式审批）一个不少。room 是附加功能，不是必需品。这一节推翻了第 1 节"不渲染终端"的决定，但只针对 Claude。

**本地工作区**
- 客户端内置一个 room server，只监听 `127.0.0.1`，端口固定（默认 7710，可以用 `BANYAN_LOCAL_PORT` 修改）。端口固定是因为 web 的登录凭证存在 localStorage 里，按 origin 隔离，换端口就丢了。数据放在客户端的 userData 目录。web 构建产物打包进客户端，由这个内置 server 提供。
- 第一次启动时，客户端自动创建一个名为「本地」的工作区（技术上就是一个 room），并自动注册、启动本机 runner。打开窗口直接进入这个工作区，不需要填任何东西。
- 本地工作区的 room 没有 fork：`room.created` 的 `repoUrl` 可以为空。新建 agent 时选一个本机已有的仓库目录（`agent.created.repoPath`），runner 以这个仓库当前的 HEAD 为起点，在 `<roomDir>/worktrees/<agentId>` 开一个 worktree 和新分支。这类 agent 的分支**不会自动 push**，因为它们属于用户自己的仓库，远端由用户管理。在团队 room 里也可以给 agent 指定本机仓库。
- 团队 room 照旧，是另外连接的 server。顶栏的 room 下拉菜单里可以在「本地」和已连接的团队 room 之间切换。

**Claude 终端模式**
- runner 用 node-pty 运行真正的交互式 `claude`，界面用 xterm.js 渲染。终端数据经 runner 所在的 utility process → 主进程 → 窗口传输（Electron MessagePort）；runner 用 headless xterm 为每个终端维护一份屏幕状态（含 scrollback），重新打开时发送序列化后的屏幕，而不是回放原始输出：从任意位置截断的输出会从转义序列中间开始，也缺少 CLI 相对重绘所依赖的光标位置。
- 启动参数：`--settings '<json>'` 注入 HTTP hooks（指向 runner 本地的接口，路径里带上 agent 身份和随机密钥），`--mcp-config` 注入 Room MCP，`--append-system-prompt` 传入 Banyan 的协作说明，恢复时用 `--resume <session_id>`。用户自己的 settings、CLAUDE.md、plugins、skills、hooks 照常加载（已实测：注入的 hooks 和用户 hooks 合并执行）。
- 去掉父进程是 Claude Code 时留下的环境变量（`CLAUDECODE`、`CLAUDE_CODE_CHILD_SESSION`、`CLAUDE_CODE_SESSION_*` 等），否则 Claude 不保存会话，也就无法恢复（已实测）。
- 状态来自 hooks：`UserPromptSubmit` → 工作中；`PermissionRequest` 或 `Notification(permission_prompt)` → 等待审批（进入「需要处理」，提示在终端里处理）；之后出现 `PreToolUse`、`PostToolUse`、`Stop` 或 `UserPromptSubmit` 时清除等待状态；`Stop` → 空闲。每个事件都带 `session_id`，用来绑定会话。审批在终端里完成，UI 上没有审批卡片。
- 对话记录：只用文档里明确列出的 hook 字段（用户输入、工具调用和结果、每轮最后一条回复）生成，供 room 里的其他人只读查看。Claude 内部的 transcript JSONL 格式官方说明会随版本变化，所以不解析它。
- room 里的消息（leader 或别人发给它的）会直接输入到终端：fyi 直接输入，Claude Code 会自己排队处理；steer 先按 Esc 打断当前操作，再输入。
- 「是否信任此文件夹」对话框默认选中「No, exit」，但信任关系会从父目录继承；第一次在新位置使用时由用户在终端里确认，不替用户自动接受。
- 退出客户端时终端随之结束，下次启动用 `claude --resume` 恢复会话。
- Codex 暂时保持托管模式（SDK + 结构化对话），因为它没有足够的 hooks 来跟踪状态和审批（Rhett 确认）。
- 远程 agent（room 里跑在别人机器上的）只显示只读的对话记录；终端只在运行这个 agent 的那台机器上可用（Rhett 确认）。

**实现中实测到的细节**（Claude Code 2.1.322）
- hook 的实际字段：`UserPromptSubmit` 的用户输入在 `prompt` 字段里；`PostToolUse` 的结果在 `tool_response` 字段里（是一个对象）。这两处和文档 agent 转述的不一致，以实测为准。`SessionStart` 不会以 HTTP hook 的形式送达，不过用不到它，因为每个事件都带 `session_id`。
- `--settings` 可以直接传 JSON 字符串，注入的 hooks 会和用户自己的 hooks 合并执行。`--mcp-config` 也可以直接传 JSON 字符串。
- 第一条消息作为命令行参数传入（`claude ... "<prompt>"`）；新会话用 `--session-id <uuid>` 预先指定会话 id；恢复时用 `--resume <id> "<prompt>"`，上下文会保留。
- 默认的权限模式下，Room MCP 的工具也会弹审批，所以注入的设置里加了 `permissions.allow: ["mcp__room"]`，和托管模式下自动放行 room 工具的做法保持一致。
- 「是否信任此文件夹」对话框出现时不会触发任何 hook，所以在屏幕上识别这段文字（去掉转义序列和空白后再匹配）。会话还没有被确认启动之前，终端就已经可以打开，方便用户回答这个问题。
- 只有 supervisor 已经写进 transcript 的 room 消息（带 `messageId`）才会忽略对应 hook 的重复记录（`send(text, delivery, recorded)`）；启动提示、唤醒 leader 的消息等都由 hook 记录。
- node-pty 预编译包里的 `spawn-helper` 安装后没有执行权限，runner 在第一次 spawn 前会补上。
- 终端 agent 的详情面板默认收起，让终端占满宽度，需要时点「详情」展开。

**实现顺序**：1. 本地工作区（内置 server、可以选本机仓库的 agent）；2. Claude 终端模式；3. 本地和 room 之间的切换、打磨。三步都已完成。

## 24. Codex 终端与「纯本地」agent（2026-11-17）

Rhett 确认的决定：

- **Codex 也走真实的 CLI 终端**。现在的 Codex（0.167）已经有稳定的 hooks，事件和字段与 Claude Code 一致（`UserPromptSubmit.prompt`、`PreToolUse`、`PermissionRequest`、`PostToolUse.tool_response`、`Stop.last_assistant_message`，每个事件都带 `session_id`）。两种 CLI 共用 `TerminalSession`，差异集中在每种 CLI 的 profile 里：启动参数、hooks 的注入方式、会话 id 什么时候能拿到。
  - Codex 的 hooks 只能是命令，而且必须先由用户信任它的完整定义（按哈希记录）。Banyan 的 hook 定义对所有 agent 都相同（`curl` 把输入转发给 `$BANYAN_HOOK_URL`；变量没设时什么都不做），所以用户只需要在第一次出现的「Hooks need review」里信任一次。不使用 `--dangerously-bypass-hook-trust`，因为它会让仓库自带的 hooks 也不经审核就运行。
  - 实测确认：`-c hooks.<事件>=[...]` 可以定义 hooks；`mcp_servers.room.url` 和 `mcp_servers.room.default_tools_approval_mode="approve"` 让 Room 工具不用审批；`developer_instructions` 注入协作说明；`codex resume [-c ...] <id> [prompt]` 用来恢复。Codex 不能预先指定会话 id，id 从第一个 hook 里拿。
- **纯本地 agent**：room 新增 `personal` 标记，客户端的本地工作区就是一个 personal room。personal room 里的独立 agent 就是纯粹的 CLI：没有 Banyan 的协作说明，也没有 Room MCP；如果填了说明就作为第一条消息发送，否则终端打开后等用户输入；恢复时也不会被要求调用 `room_get_context`。托管模式下必须有第一条消息才能启动，界面会要求填写。group 里的 agent 即使在 personal room 里，也保留协作功能。没有 personal 标记的旧本地工作区会被重建，不做兼容（Rhett 确认）。
- **往终端里输入是有条件的**（实测发现的安全问题）：只有 CLI 已经停在输入框时（已经收到过 hook，而且没有在问用户问题），Banyan 才往终端里输入。否则消息保持待送达，等 hook 表明 CLI 回到输入框后再送。fyi 还要等当前一轮结束（`Stop`），因为两种 CLI 都会把一轮进行中输入的文字并进这一轮；steer 先按 Esc 打断，再输入。之前的实现会在 Codex 弹出更新菜单时把消息输进去，消息末尾的回车会选中默认的「Update now」。这次没有真的更新，是因为全局安装目录属于 root。同样的情况如果发生在审批框上，就等于替用户点了「允许」。
- 启动阶段识别屏幕上的问题，从第一个 hook 之前一直持续到问题被回答，覆盖：信任文件夹、Codex 的 hook 审核、Codex 的更新菜单。不修改用户的 `check_for_update_on_startup`。
- Codex 0.167.1 会把发往 127.0.0.1 的请求也交给 macOS 系统代理，代理会返回 502。所有 agent 进程都会在 `NO_PROXY` 里补上回环地址。
- 测试使用临时的 `CODEX_HOME`（只复制登录凭证 `auth.json`），不往用户真实的 `~/.codex` 里写信任记录。

## 25. 新建 agent 的简化与状态图标（2026-11-17）

Rhett 的要求：

- **新建对话框默认只有三项**：类型（Claude Code / Codex / 终端）、名称、仓库目录。目标、group、角色、补充说明、后台托管（不开终端）都收进默认折叠的「协作设置」。去掉了模型字段（一律用 CLI 自己的默认，在终端里用 `/model` 切换）和「第一条消息」。
- **仓库目录有记忆**：对话框会预填上次用的仓库（保存在页面的 localStorage）；点「选择…」时，从上次选的位置打开（保存在客户端设置的 `lastRepoDir`）。
- **纯终端**：新增 `provider: "shell"`，在 agent 的 worktree 里开用户自己的登录 shell（`$SHELL -l`）。它总是终端模式、总是 worker、总是纯本地（没有 Room MCP）；没有 hooks，所以不跟踪一轮一轮的工作，状态只显示「终端」，重启后开一个新 shell。
- **状态图标**（参考 Claude 手机端）：工作中是黑色转圈，已完成/空闲是绿色对勾，需要你是黄色小手掌，出错是红色叹号，启动中是灰色转圈，离线是灰色虚线圆，已停止是灰色圆里一横，终端是 `>_`。由 `agentIcon()` 统一推导，列表、agent 页、目标页、Worktree 页、协调页都用同一套图标，去掉了原来的圆点。
- 终端启动后，如果既没有问问题、也还没有任何 hook，就算停在输入框（报告空闲），不会一直显示「启动中」。
- **删除与重新启动**（Rhett 反馈：独立 agent 删不掉，退出终端后就成了僵尸终端）：新增事件 `agent.archived` 和 `agent.restart_requested`，只有 agent 的主人或 room 的 owner 可以操作。删除后会话结束，不再启动，也不再出现在列表和收件箱里；它在 group 里的 leader/monitor 位置会腾出来；**worktree 和分支保留**，删除 agent 不会删掉代码。CLI 正常退出（`/exit`、shell 里的 `exit`）不算崩溃，不会自动重启；终端关闭的提示上有「重新启动」，agent 页顶部有「重新启动 / 删除」，删除前会确认。
- 本地工作区（personal room）的导航只保留「总览」和「Worktree」；目标、结论、协调这些协作页面只在团队 room 里显示。

## 26. 终端启动参数（2026-11-17）

Rhett 的要求：Claude Code 和 Codex 的启动参数可以自定义，默认带上跳过权限确认的参数；这是可选功能，不放在显眼的位置。

- 默认值：Claude Code 用 `--dangerously-skip-permissions`，Codex 用 `--yolo --sandbox danger-full-access`（`--yolo` 是 Codex 的隐藏别名，已实测确认它在交互模式和 `resume` 里都能用）。只影响终端模式，托管模式和纯终端（shell）不受影响。
- 位置：顶栏语言/主题旁边的小 ⚙，只在桌面客户端里显示。每种 CLI 一行，按 shell 的规则拆分（引号和反斜杠转义都支持），解析失败时不保存。保存后通过 runner 宿主进程的消息生效，只影响之后启动的终端，正在运行的不受影响，也不用重启 runner。命令行 runner 用 `BANYAN_CLAUDE_ARGS` / `BANYAN_CODEX_ARGS` 环境变量设置。
- 实测发现：带 `--dangerously-skip-permissions` 时，即使 `~` 已经被信任，Claude Code 仍会对每个新文件夹询问一次「是否信任」，默认选项是「No, exit」。Banyan 会识别这个问题并显示小手掌，不替用户回答。选「No, exit」会让 Claude 以非零退出码结束，这被当作用户的回答处理，不算崩溃，所以不会被自动重启（修复前会连续重启 3 次，反复问同一个问题）。
- 风险：在这些默认参数下，agent 执行命令前不会询问。在团队 room 里，别人或 leader 发给你的 agent 的消息会被直接输入它的终端，它会带着完全的权限去执行。

## 27. 往终端里粘贴图片（2026-11-17）

Rhett 反馈：Banyan 里的 Claude Code / Codex 不能输入图片。原因是终端只能传文字，xterm.js 收到粘贴事件时会丢掉图片；在普通终端里也一样（Claude Code 在那里要用 Ctrl+V 自己去读剪贴板）。

- 在终端里用 ⌘V 粘贴图片时，Banyan 把图片存成文件（客户端数据目录下的 `pasted-images/`，超过 7 天的在启动时清理；只接受 png/jpeg/gif/webp，单张不超过 20MB），然后把文件路径粘贴进终端。往终端里拖入文件也一样，粘贴的是文件路径。路径里的空格等字符按终端处理拖入文件的方式加反斜杠转义。
- 实测（Claude Code 2.1.322、Codex 0.167.1）：两种 CLI 都会把粘贴进来的图片路径（包括转义过的、带空格的路径）识别成 `[Image #1]`。
- Ctrl+V 照常交给 CLI 自己处理，文字粘贴也不受影响。
- 测试时发现：交互式 Codex 会在它的 home 目录下留一个后台 daemon 进程，TUI 退出后也不会结束。所以用临时 `CODEX_HOME` 的测试，结束时会把在那个目录下启动的进程一起清理掉。

## 28. 任意目录、列表排序、类型图标（2026-11-17）

- **不是 git 仓库的目录**（Rhett 反馈：用 `~/code/origin_sglang` 这种放了多个仓库的目录新建终端会报 failed to start）：如果选的目录不在 git 仓库里，或者仓库还没有任何提交，agent 就直接在这个目录里运行，不开 worktree（没有隔离：同一个目录里的多个 agent 会看到彼此的改动）。目录不存在时会给出明确的报错。「选择…」现在接受任何目录：如果是 git 仓库，返回仓库的顶层目录；否则就用选的目录本身。字段名从「仓库目录」改成「目录」。
- **左侧列表**：每个 agent 的第二行显示它的目录（把 home 显示为 `~`；用 room fork 的显示为「<名字> (fork)」），有阶段时接在后面。拖动一行可以在它所在的分组内调整顺序：被拖的行跟着指针走，其他行平滑让位；移动不到 4px 的按下仍然算点击。也可以用 Alt+↑/↓ 移动当前行。顺序是各人自己的，保存在浏览器的 localStorage 里，不写进 room。
- **类型图标**：Claude Code、Codex、终端分别用一个小图标表示（四角星、花括号、带提示符的窗口），鼠标悬停时显示名称。这些图标是 Banyan 自己画的，没有用产品的官方 logo，因为仓库要开源。


## 29. 个人 tag（2026-11-18）

- agent 可以按 tag 分组，像浏览器的书签文件夹：一个 tag 里可以有任意多个 agent，一个 agent 最多属于一个 tag，其余的显示在「未分类」里。tag 可以折叠、改名、换颜色（六种低饱和度颜色）、删除；删除后里面的 agent 回到未分类。
- tag 是各人自己的，和排序一样存在本机浏览器的 localStorage 里，按房间分开，不写进 room 的事件。
- 列表只按 tag 分区。团队房间里的协作 group 显示为 agent 第二行开头的小字。
- 把 agent 拖到 tag 标题上，它会排到这个 tag 的末尾；拖到另一个 tag 里的某个 agent 上，会在那个位置落下。右键 agent 也可以移到某个 tag、新建 tag 或移出 tag。

## 30. 终端里的使用体验（2026-11-18）

- **复制**：Claude Code 和 Codex 进入主界面后会接管鼠标（开启鼠标追踪），拖动时由它们自己处理选择，再用 OSC 52 把选中的内容写进剪贴板。Banyan 只响应 OSC 52 的写入；程序请求读取剪贴板时不回应，这样终端里的程序拿不到用户复制过的内容。另外，按住 Option 拖动可以强制让终端自己选择文字，和 iTerm2、系统终端的习惯一样。
- **链接**：程序标记的链接（OSC 8）和输出里的普通网址都可以点击，用系统浏览器打开，只放行 http/https。
- **Shift+Enter**：只在 Claude Code 终端里映射成 `\x1b\r`，也就是换行而不是发送，和 Claude Code 自己的 `/terminal-setup` 一致（这个序列是从它的程序里查到的）。Codex 收到这个序列会怎么处理没有验证，它可能被当成 Esc 加 Enter，而 Esc 会打断正在运行的任务，所以 Codex 和纯终端保持原样。
- **右键菜单**：输入框和终端里有剪切、复制、粘贴、全选；选中的文字可以复制；链接可以在浏览器中打开或复制。
- **窗口位置**：移动、缩放、隐藏或退出时保存，下次在原位置打开；如果那个位置已经不在任何屏幕上（比如外接显示器拔掉了），就回到默认位置。
- 纯 shell 终端的回滚缓冲是 10000 行。

## 31. 重命名与 Fork（2026-11-19）

- **重命名**：只改显示名，会话、worktree 和分支都不变。agent 的主人或房间主人可以改。
- **Fork**：从有会话的 Claude Code 或 Codex 终端 agent 复制出一个新 agent，带着到当前为止的完整对话，之后各走各的。只能在原 agent 所在的 runner 上进行，因为会话文件在那台机器上。
  - 原 agent 有 worktree 时，新 agent 从它当前的提交开一个新 worktree，并把未提交的改动（包括暂存的、删除的和未跟踪的文件）也复制过去。原 agent 没有 worktree（比如目录不是 git 仓库）时，新 agent 在同一个目录里运行。
  - Claude Code：`--resume <原会话> --fork-session --session-id <新会话>`。实测确认可以从另一个目录 fork，也可以指定新会话的 id。同一个仓库的新 worktree 不会再问是否信任文件夹。
  - Codex：`codex fork <原会话>`，并加上 `-c tui.resume_cwd="current"`。不加的话，Codex 会问用会话原来的目录还是当前目录，而且默认选「会话目录」，也就是原 agent 的 worktree，两个 agent 会改同一份代码。这个配置项是在临时的 Codex 主目录里选一次「Always use current directory」后，从它写入的 `config.toml` 里查到的。万一遇到不认这个配置项的 Codex 版本，Banyan 也会把这个问题识别为需要人处理，不往里面打字。
  - fork 出的 agent 不会收到开场消息，直接等人来操作。新 agent 放在原 agent 正下方、同一个 tag 里，创建后直接打开。

## 32. 房间记忆（2026-11-19）

参考 Inferact 的 Agent V：会话会结束，但经验要留下来。

- 记忆分三类：**规矩**（人写，agent 必须遵守）、**事实**（人写，或把某条 finding 存进来）、**经验**（agent 用 `room_propose_learning` 提议，以 `learning` 类型的 post 走现有的审核流程，通过后自动成为记忆条目；如果之后被驳回，这条记忆也随之停用）。
- 存在房间的事件日志里，跟着房间同步给所有人。只有人能新增、修改或停用条目。停用的条目保留在历史里，但不再提供给 agent。
- agent 怎么用：生效的规矩写进启动提示；规矩新增、修改或停用时，以 fyi 的方式通知正在运行的 agent，因为它们的启动提示是固定的。事实和经验用 `room_search_memory` 按需搜索（按词匹配，匹配的词越多越靠前，同样多的较新的在前）。
- 只对团队房间里的协作 agent 生效。个人工作区的纯本地 agent 保持「和直接运行 CLI 一样」，不带记忆（Rhett 的决定）。「记忆」页面也只在团队房间显示。

## 33. Hillclimb 排行榜（2026-11-19）

参考 Agent V 的 hillclimb：多个 agent 并行优化一个可验证的指标，结果要验证，并记录每个结果是基于哪个结果改进的。

- 人在目标上设置指标：名称、越大越好还是越小越好、单位，以及一条复跑命令。
- agent 先用 `room_commit` 提交代码，再用 `room_submit_result` 提交结果：自己测到的数值、当前的 commit，以及基于哪个结果改进。工作区里有未提交的改动时拒绝提交，因为只有提交过的代码才会被验证。
- 由 agent 所在的 runner 验证：把那个 commit 检出到一个临时的干净 worktree，用登录 shell 运行复跑命令，取输出最后一行里的最后一个数字作为结果。超过 60 分钟、退出码不为 0 或者没有数字都算验证失败，并记录原因和输出的最后一段。同一台机器上的验证排队逐个执行，免得同时跑的 benchmark 互相影响。runner 退出时会中止正在进行的验证，没有结论的结果保持「待验证」，下次启动重新排队。验证结果会以 fyi 的方式告诉提交的 agent。
- 只有验证过的数值参与排名；数值相同时，先提交的排在前面。agent 可以用 `room_leaderboard` 查看榜单，里面有每个结果的 commit 和分支，方便在最好的结果上继续改。
- Agent V 里的 GPU 竞拍积分没有做。

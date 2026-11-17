# Banyan 桌面客户端

像 Orca 一样在本机并行运行多个 Claude Code / Codex agent：左边是 agent 列表，能看到每个 agent 的状态；右边是选中 agent 的真实 Claude Code 终端，skills、斜杠命令、/model 等原生功能都能用。不需要任何 server，打开就能用。团队 room 是附加功能：连上团队的 room server，就能和同事共享方向和结论。设计见 `docs/design.md` 第 20～23 节。

## 开发

```bash
pnpm --filter @banyan/desktop start      # 构建 build/app 并启动
pnpm --filter @banyan/desktop test       # 单元测试
pnpm --filter @banyan/desktop test:e2e   # 端到端：真实 server + 打包后的 app + 真实 Claude/Codex（会产生少量费用）
```

`pnpm build` 会把源码打包进 `build/app-<arch>`。better-sqlite3 和 Claude SDK 不能打包进 bundle，所以在这个目录里用 npm 单独安装：Claude SDK 要按架构挑选自带的 claude 可执行文件，而 better-sqlite3 自带 Node-API 预编译包，Electron 可以直接加载。

## 打安装包和分发

```bash
pnpm --filter @banyan/desktop dist       # 同时打出 build/dist/Banyan-x64.dmg 和 Banyan-arm64.dmg
```

room server 会直接从 `packages/desktop/build/dist` 提供下载，换目录用 `BANYAN_DESKTOP_DOWNLOADS`。同事安装客户端只需要在终端执行一行命令，邀请对话框和加入页里都会显示：

```bash
curl -fsSL <server>/install.sh | bash -s <server>
```

脚本会自动判断 Intel 还是 Apple Silicon，装到 `/Applications`（没有写权限时装到 `~/Applications`），并预先填好 server 地址再打开客户端。客户端正在运行时，再执行一次这行命令就是升级：脚本会先让它优雅退出，本机 agent 在升级后自动恢复。安装包未签名，但通过这个脚本安装不会被 Gatekeeper 拦下。如果是手动双击 dmg 安装的，第一次打开要在 Finder 里右键 →「打开」。

## 使用

1. 打开客户端，直接进入「本地」工作区。本机 runner 会自动启动，不用填任何地址。
2. 点「新建 agent」，填写或点「选择…」选一个本机的 git 仓库，起个名字。Claude agent 默认勾选「在 Claude Code 自己的终端里运行」。每个 agent 会在这个仓库上开一个独立的 worktree 和分支（`banyan/…`），从仓库当前检出的提交开始；分支不会自动 push，push 由你自己决定。
3. 在左边选中 agent，右边就是它的 Claude Code 终端，可以直接打字、用斜杠命令、在终端里处理审批。它在等你（审批、信任文件夹之类的问题）时，左边会标出「在终端里等你处理」，并弹系统通知。
4. 需要团队协作时，在顶栏的 room 下拉菜单里选「团队 room server…」，连接团队的 server（地址见 `deploy/macos/README.md`）。之后同一个下拉菜单可以在「本地工作区」和团队 room 之间切换。在团队 room 里点「在本机运行 agent」，就能用这台机器承担你的 agent。
5. 图片：在终端里用 ⌘V 粘贴截图，或者把图片拖进终端，Claude Code 和 Codex 会把它当成图片附件（显示为 `[Image #1]`）。
6. 终端启动参数：顶栏的小 ⚙ 可以设置 Claude Code 和 Codex 的额外命令行参数。默认是 `--dangerously-skip-permissions` 和 `--yolo --sandbox danger-full-access`，也就是 agent 执行命令时不再询问。修改后只对之后启动的终端生效。
7. 关窗口只是隐藏到托盘，agent 继续运行；从托盘选「退出」会优雅停止本机 agent。下次启动时会自动拉起，终端 agent 用 `claude --resume` 接着原来的会话，之前的历史全部可见。
8. 如果 runner 崩溃，它不会自动重启。顶栏会显示「本机 runner 出错已停止」，以及原因和日志路径，它的 agent 进程（包括正在运行的工具命令）也会被一并结束。点「重新启动」或者重开客户端，agent 会接着原来的会话继续。

本地工作区的数据在客户端的数据目录里（macOS：`~/Library/Application Support/Banyan/local.sqlite`），内置 server 只监听 `127.0.0.1:7710`（可以用 `BANYAN_LOCAL_PORT` 修改）。

终端模式的 Claude agent 运行的是你本机安装的 `claude`，会加载你全部的 Claude Code 配置（settings、CLAUDE.md、plugins、skills、hooks）。托管模式的 Claude agent 用 SDK 自带的可执行文件，同样沿用本机的登录状态和配置。Codex agent 用本机的 `codex`。git 凭证也用本机的。客户端启动时会从登录 shell 读取 PATH，所以从 Dock 启动也能找到它们。

同一个 room 在一台机器上只能有一个 runner。如果已经用 `deploy/macos/banyan.sh install-runner` 装过这个 room 的 runner，先执行 `uninstall-runner`，否则客户端会显示「本机 runner 出错」，并给出占用锁的 pid。

日志：macOS 在 `~/Library/Application Support/Banyan/logs/runner-<roomId>.log`。

# Banyan 桌面客户端

Electron 桌面壳 + 内置 runner。窗口显示 room server 的 web UI；在某个 room 里打开「在本机运行 agent」后，客户端会在本机为这个 room 注册并运行 runner。设计见 `docs/design.md` 第 20 节。

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

1. 用上面那行命令安装的，会直接连到对应的 server。手动安装的，首次启动时要填写 room server 地址（见 `deploy/macos/README.md`）。托盘菜单里随时可以更换。
2. 进入 room 后，点顶栏的「在本机运行 agent」。第一次点击会为这台机器注册 runner，凭证保存在 `~/.banyan/rooms/<roomId>/runner.json`。
3. 关窗口只是隐藏到托盘，agent 继续运行；从托盘选「退出」才会优雅停止本机 agent。下次启动时会自动拉起，并恢复之前的 agent 会话，之前的历史全部可见。
4. 如果 runner 崩溃，它不会自动重启。顶栏会显示「本机 runner 出错已停止」，以及原因和日志路径，它的 agent 进程也会被一并结束。点「重新启动」或者重开客户端，agent 会接着原来的会话继续。
5. 自己的 agent 需要审批、出现异常，或者有发现等待人工审核时，会弹系统通知。

agent 用的是本机已经登录好的 `claude`（SDK 自带可执行文件，沿用本机的登录状态）、`codex` 和 git 凭证。客户端启动时会从登录 shell 读取 PATH，所以从 Dock 启动也能找到它们。

同一个 room 在一台机器上只能有一个 runner。如果已经用 `deploy/macos/banyan.sh install-runner` 装过这个 room 的 runner，先执行 `uninstall-runner`，否则客户端会显示「本机 runner 出错」，并给出占用锁的 pid。

日志：macOS 在 `~/Library/Application Support/Banyan/logs/runner-<roomId>.log`。

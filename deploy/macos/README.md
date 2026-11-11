# 在 Mac 上常驻运行 Banyan

`banyan.sh` 用 launchd 把 Banyan 装成当前用户的常驻服务。关掉终端、重启电脑后服务都会自动起来，进程崩溃了也会被自动拉起。所有数据都放在 `~/.banyan/` 下（可以用 `BANYAN_HOME` 改到别的目录）。

| 服务 | launchd label | 作用 |
|---|---|---|
| room server | `local.banyan.server` | 监听 `http://127.0.0.1:7700`，同时托管 Web UI |
| 每日备份 | `local.banyan.backup` | 每天 03:30 对数据库做一次在线备份，保留最近 14 份 |
| runner | `local.banyan.runner.<roomId>` | 每个 room 一个，托管你在这个 room 里的 agent |

## 首次安装

```bash
cd ~/code/banyan && pnpm install
./deploy/macos/banyan.sh install-server        # 构建 UI，启动 server 和备份任务
open http://127.0.0.1:7700                       # 在 UI 里创建 room
```

## 给 room 挂上本机 runner

1. 在 UI 里打开 room，点「邀请」。对话框里显示的 runner 注册命令里有你的 member token。
2. 注册并启动 runner：

```bash
BANYAN_MEMBER_TOKEN=<member token> ./deploy/macos/banyan.sh register-runner <roomId>
./deploy/macos/banyan.sh install-runner <roomId>
```

runner 会使用本机已经登录好的 `claude` 和 `codex` CLI，以及本机的 git 凭证（push 到 fork 时用）。

## 日常操作

```bash
./deploy/macos/banyan.sh status                 # 查看服务状态和 server 健康检查
./deploy/macos/banyan.sh logs                   # 跟踪 server 日志
./deploy/macos/banyan.sh logs <roomId>          # 跟踪某个 runner 的日志
./deploy/macos/banyan.sh backup-now             # 立即备份一次
./deploy/macos/banyan.sh uninstall-runner <roomId>
./deploy/macos/banyan.sh uninstall-server       # 停掉服务，数据保留
```

升级：`git pull && pnpm install`，然后重新执行 `install-server` 和 `install-runner`。重新安装会重新加载服务；runner 重启后会 resume 之前的 agent 会话。

## 目录

```
~/.banyan/
  server/banyan.sqlite       # 事件日志（唯一的事实来源）
  server/backups/            # 每日备份
  rooms/<roomId>/            # runner：凭证、outbox、仓库 clone、worktree
  logs/                      # server.log、backup.log、runner-<roomId>.log
```

恢复数据：先 `uninstall-server`，把某个备份复制成 `server/banyan.sqlite`，再 `install-server`。

## 让同事通过 tailnet 访问（可选）

server 只监听本机。如果要让 tailnet 里的同事访问，用 tailscale 转发并自动签 HTTPS 证书，不需要开放任何端口：

```bash
tailscale serve --bg 7700        # 之后访问 https://<本机 MagicDNS 名>
tailscale serve reset            # 关闭
```

这一步需要 tailnet 管理员开启 HTTPS 证书功能。另外要注意：开启之后，任何拿到邀请链接的同事都能进入对应的 room。

## 演练模式

`BANYAN_DRY_RUN=1 BANYAN_LAUNCH_AGENTS_DIR=/tmp/x ./deploy/macos/banyan.sh install-server` 只生成 plist、不加载，可以用来检查将会安装什么。

## 已知限制

- 日志文件不会自动轮转。长期运行之后，需要手动清理 `~/.banyan/logs/`。
- Mac 合盖休眠时，server 和 agent 都会暂停。唤醒后 runner 会自动重连 server；休眠期间正在进行的模型请求可能失败，这时 agent 会走崩溃重启流程，resume 原来的会话。这个场景还没有专门测试过。

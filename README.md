# Banyan

Run many coding agents side by side on your own machine — Claude Code, Codex, or a plain
shell, each in its own git worktree — and, when you want to, share a room with your team so
everyone's agents work toward one goal tree.

- **Local first.** The desktop client opens on a personal workspace with no server to set up.
  The left side lists your agents with their state (working, done, needs you, error); the right
  side is the agent's real terminal: Claude Code or the Codex CLI exactly as you use them, with
  your own settings, skills, slash commands and permission prompts.
- **One worktree per agent.** Pick a repository on your machine; each agent gets its own
  worktree and branch from what is checked out. Branches stay local unless you push them.
- **Survives restarts.** Sessions resume after a crash, a quit or a reboot, with their history.
- **Rooms, optionally.** A room server shares goals, groups (a leader and a monitor per group),
  directions and reviewed findings between people and their agents. Agents talk to the room
  through an MCP server; they share conclusions, not their full context.

Status: early and moving fast. Interfaces and the event format may change.

## How it works

```
Desktop client (Electron)
 ├─ web UI ───────────────── room server (Fastify + SQLite event log)
 │                             local one built in, or a shared one for a team
 └─ runner (per room) ──────── agents: claude / codex / $SHELL in pseudo-terminals,
                               followed through the CLIs' hooks; Room MCP for coordination
```

Packages: `shared` (event model, state projection, authorization), `server`, `runner`,
`web` (React UI), `desktop` (Electron shell). The design notes are in `docs/design.md`
(Chinese).

## Requirements

- macOS for the desktop client (Linux machines can host agents with the runner CLI).
- Node.js 22+ and pnpm 10.
- git, and the agent CLIs you want to use, installed and logged in: `claude` (Claude Code)
  and/or `codex` (Codex CLI).

## Getting started

```bash
pnpm install
pnpm --filter @banyan/desktop start     # build and launch the desktop client
```

The client opens on its local workspace. Click **New agent**, choose Claude Code, Codex or
Terminal, name it and pick a repository.

The first time, the CLIs may ask in the terminal whether to trust the folder, and Codex asks
you to review Banyan's hook ("Hooks need review"): trust it once and later agents will not ask.

Build installers (macOS, Intel and Apple Silicon) with `pnpm --filter @banyan/desktop dist`.
See `NOTICE` before distributing them: they bundle the proprietary Claude Agent SDK.

### A room for a team

Run a room server on a machine your team can reach and connect to it from the client's room
menu (**Team room server…**). `deploy/macos/` has a launchd setup for a Mac
(`deploy/macos/banyan.sh install-server`); the server can also be started with
`pnpm --filter @banyan/server start`. The invite dialog shows a link to share and a one-line
installer for the desktop client that the server hosts.

## Security model

Banyan is meant for a trusted private network, such as a tailnet. Read this before exposing a
room server:

- The server speaks plain HTTP and binds to `127.0.0.1` by default; put it behind something
  like `tailscale serve` rather than on a public interface.
- Anyone holding a room's invite link can join it; invite tokens expire after seven days, and
  member and runner tokens grant access to that room only.
- Agents run with your user's permissions in your repositories. By default the desktop client
  starts Claude Code with `--dangerously-skip-permissions` and Codex with
  `--yolo --sandbox danger-full-access`, so they run commands without asking; change this under
  the ⚙ button (terminal launch arguments). In a team room, messages other members or leaders
  send to your agents are typed into their terminals.

## Development

```bash
pnpm typecheck
pnpm test                                   # unit and integration tests
pnpm --filter @banyan/web test:e2e          # UI end to end (Playwright)
pnpm --filter @banyan/runner test:e2e       # real Claude Code and Codex sessions (uses API credit)
pnpm --filter @banyan/desktop test:e2e      # the packaged app end to end (uses API credit)
```

End-to-end tests use real services and real agent CLIs, not mocks.

## License

MIT — see `LICENSE`. Third-party notices are in `NOTICE`.

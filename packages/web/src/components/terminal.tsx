// The live terminal of a terminal-mode agent running on this machine, through the desktop
// client. The person types straight into Claude Code here.
import { useEffect, useRef, useState } from "react";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { openTerminal } from "../desktop.tsx";
import { useT } from "../i18n.ts";

// sessionKey changes when the agent's session restarts, so the view reconnects to the new one.
// onRestart, when given, offers to start the agent again once its terminal has closed.
export function TerminalView({ roomId, agentId, sessionKey, onRestart }: { roomId: string; agentId: string; sessionKey: string; onRestart?: () => void }) {
  const t = useT();
  const host = useRef<HTMLDivElement>(null);
  const [closed, setClosed] = useState<string | null>(null);

  useEffect(() => {
    const el = host.current;
    if (!el) return;
    setClosed(null);
    const term = new Terminal({
      fontFamily: 'Menlo, "SF Mono", Monaco, Consolas, monospace',
      fontSize: 13,
      cursorBlink: true,
      allowProposedApi: false,
      theme: { background: "#1f1e1c", foreground: "#ece9e2" },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(el);
    fit.fit();
    const connection = openTerminal(
      roomId,
      agentId,
      (data) => term.write(data),
      (reason) => setClosed(reason),
    );
    const input = term.onData((data) => connection.write(data));
    const resized = term.onResize(({ cols, rows }) => connection.resize(cols, rows));
    connection.resize(term.cols, term.rows);
    const observer = new ResizeObserver(() => fit.fit());
    observer.observe(el);
    term.focus();
    return () => {
      observer.disconnect();
      input.dispose();
      resized.dispose();
      connection.close();
      term.dispose();
    };
  }, [roomId, agentId, sessionKey]);

  return (
    <div className="terminal-pane" data-testid="terminal">
      <div ref={host} className="terminal-host" />
      {closed && (
        <div className="terminal-closed faint row">
          <span>{`${t("agent.terminalClosed")}: ${closed}`}</span>
          {onRestart && (
            <button onClick={onRestart} data-testid="terminal-restart">
              {t("agent.restart")}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

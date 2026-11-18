// The live terminal of a terminal-mode agent running on this machine, through the desktop
// client. The person types straight into Claude Code here.
import { useEffect, useRef, useState } from "react";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { Terminal } from "@xterm/xterm";
import type { Agent } from "@banyan/shared";
import "@xterm/xterm/css/xterm.css";
import { openTerminal, pathsForTerminal } from "../desktop.tsx";
import { useT } from "../i18n.ts";

// Web links open in the browser (the desktop client hands window.open to the system browser);
// other schemes are ignored.
function openLink(uri: string): void {
  if (/^https?:\/\//i.test(uri)) window.open(uri, "_blank", "noopener");
}

// What Shift+Enter sends: Claude Code takes ESC CR as a new line in the prompt, as its own
// /terminal-setup binds it in other terminals. Elsewhere it stays a plain Enter.
const SHIFT_ENTER: Partial<Record<Agent["provider"], string>> = { claude: "\x1b\r" };

// sessionKey changes when the agent's session restarts, so the view reconnects to the new one.
// onRestart, when given, offers to start the agent again once its terminal has closed.
export function TerminalView({ roomId, agentId, kind, sessionKey, onRestart }: { roomId: string; agentId: string; kind: Agent["provider"]; sessionKey: string; onRestart?: () => void }) {
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
      // Codex and other full-screen programs take the mouse, so a plain drag goes to them; as in
      // Terminal and iTerm2, an Option-drag still selects text to copy.
      macOptionClickForcesSelection: true,
      // Links a program marks (OSC 8), such as the ones Claude Code prints.
      linkHandler: { activate: (_e, uri) => openLink(uri) },
      scrollback: 10_000,
      theme: { background: "#1f1e1c", foreground: "#ece9e2" },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    // Plain URLs in the output.
    term.loadAddon(new WebLinksAddon((_e, uri) => openLink(uri)));
    term.open(el);
    fit.fit();
    const connection = openTerminal(
      roomId,
      agentId,
      (data) => term.write(data),
      (reason) => setClosed(reason),
    );
    // Claude Code and Codex select text themselves while they hold the mouse and copy it with an
    // OSC 52 sequence ("c;<base64>"). Only writing is honoured; a request to read the clipboard
    // ("?") gets no answer, so programs in the terminal cannot see what the person copied.
    const clipboardWrites = term.parser.registerOscHandler(52, (data) => {
      const encoded = data.slice(data.indexOf(";") + 1);
      if (encoded === "?") return true;
      try {
        const text = new TextDecoder().decode(Uint8Array.from(atob(encoded), (c) => c.charCodeAt(0)));
        void navigator.clipboard.writeText(text).catch(() => {});
      } catch {
        // Not base64; nothing to copy.
      }
      return true;
    });
    const shiftEnter = SHIFT_ENTER[kind];
    term.attachCustomKeyEventHandler((e) => {
      if (!shiftEnter || e.key !== "Enter" || !e.shiftKey || e.altKey || e.ctrlKey || e.metaKey) return true;
      // Both the keydown and the keypress are kept from xterm; the sequence goes once.
      if (e.type === "keydown") connection.write(shiftEnter);
      return false;
    });
    const input = term.onData((data) => connection.write(data));
    const resized = term.onResize(({ cols, rows }) => connection.resize(cols, rows));
    connection.resize(term.cols, term.rows);
    const observer = new ResizeObserver(() => fit.fit());
    observer.observe(el);
    // A terminal carries only text, so an image pasted or files dropped go in as file paths,
    // which Claude Code and Codex attach as images. Text pastes are left to xterm.
    const pasteFiles = (files: File[], fromClipboard: boolean) =>
      void pathsForTerminal(files, fromClipboard).then(
        (paths) => paths.length > 0 && term.paste(paths.join(" ")),
        (e: Error) => setClosed(e.message),
      );
    const onPaste = (e: ClipboardEvent) => {
      const images = [...(e.clipboardData?.files ?? [])].filter((f) => f.type.startsWith("image/"));
      if (images.length === 0) return;
      e.preventDefault();
      e.stopPropagation();
      pasteFiles(images, true);
    };
    const onDragOver = (e: DragEvent) => {
      if (e.dataTransfer?.types.includes("Files")) e.preventDefault();
    };
    const onDrop = (e: DragEvent) => {
      const files = [...(e.dataTransfer?.files ?? [])];
      if (files.length === 0) return;
      e.preventDefault();
      pasteFiles(files, false);
      term.focus();
    };
    el.addEventListener("paste", onPaste, true);
    el.addEventListener("dragover", onDragOver);
    el.addEventListener("drop", onDrop);
    term.focus();
    return () => {
      el.removeEventListener("paste", onPaste, true);
      el.removeEventListener("dragover", onDragOver);
      el.removeEventListener("drop", onDrop);
      observer.disconnect();
      clipboardWrites.dispose();
      input.dispose();
      resized.dispose();
      connection.close();
      term.dispose();
    };
  }, [roomId, agentId, kind, sessionKey]);

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

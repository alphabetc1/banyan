// This machine's extra command-line arguments for Claude Code and Codex terminals, behind a
// small settings button in the desktop client.
import { useEffect, useState } from "react";
import type { TerminalArgsLines } from "@banyan/shared";
import { inDesktopClient, setTerminalArgs, terminalArgs } from "../desktop.tsx";
import { useT } from "../i18n.ts";
import { Dialog, useAction } from "./common.tsx";

function TerminalArgsDialog({ onClose }: { onClose: () => void }) {
  const t = useT();
  const action = useAction();
  const [lines, setLines] = useState<TerminalArgsLines | null>(null);
  const [defaults, setDefaults] = useState<TerminalArgsLines | null>(null);
  useEffect(() => {
    void terminalArgs().then((r) => {
      if (!r) return;
      setLines(r.current);
      setDefaults(r.defaults);
    });
  }, []);
  const save = (e: React.FormEvent) => {
    e.preventDefault();
    if (lines) void action.run(() => setTerminalArgs(lines)).then((ok) => ok && onClose());
  };
  return (
    <Dialog title={t("settings.terminalArgs")} onClose={onClose}>
      {lines && (
        <form className="stack" onSubmit={save}>
          <span className="faint">{t("settings.terminalArgsExplain")}</span>
          <label>
            Claude Code
            <input value={lines.claude} onChange={(e) => setLines({ ...lines, claude: e.target.value })} spellCheck={false} />
          </label>
          <label>
            Codex
            <input value={lines.codex} onChange={(e) => setLines({ ...lines, codex: e.target.value })} spellCheck={false} />
          </label>
          {action.error && <span className="error">{action.error}</span>}
          <div className="row">
            <button type="button" className="ghost" onClick={() => defaults && setLines(defaults)}>
              {t("settings.restoreDefaults")}
            </button>
            <span style={{ flex: 1 }} />
            <button type="button" className="ghost" onClick={onClose}>
              {t("dialog.cancel")}
            </button>
            <button className="primary" disabled={action.busy}>
              {t("settings.save")}
            </button>
          </div>
        </form>
      )}
    </Dialog>
  );
}

export function TerminalArgsButton() {
  const t = useT();
  const [open, setOpen] = useState(false);
  if (!inDesktopClient) return null;
  return (
    <>
      <button className="ghost" title={t("settings.terminalArgs")} aria-label={t("settings.terminalArgs")} onClick={() => setOpen(true)}>
        ⚙
      </button>
      {open && <TerminalArgsDialog onClose={() => setOpen(false)} />}
    </>
  );
}

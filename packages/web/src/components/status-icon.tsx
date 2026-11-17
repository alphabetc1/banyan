// One icon per agent state, in a single line style: a spinning ring while it works, a green
// check when its turn is done, a raised hand when it needs its person.
import type { AgentIconKind } from "../derive.ts";
import { useT } from "../i18n.ts";

function Glyph({ kind }: { kind: AgentIconKind }) {
  switch (kind) {
    case "working":
      return (
        <g className="spin">
          <circle cx="12" cy="12" r="8" opacity="0.18" />
          <path d="M12 4a8 8 0 0 1 8 8" />
        </g>
      );
    case "starting":
      return (
        <g className="spin">
          <path d="M12 4a8 8 0 0 1 8 8" />
          <path d="M12 20a8 8 0 0 1-8-8" />
        </g>
      );
    case "done":
      return (
        <>
          <circle cx="12" cy="12" r="9" />
          <path d="m8 12.4 2.7 2.6L16 9.4" />
        </>
      );
    case "needs_you":
      // A raised open hand.
      return <path d="M8 13V6.5a1.5 1.5 0 0 1 3 0V11m0-.5v-6a1.5 1.5 0 0 1 3 0v6.5m0-.5V6.5a1.5 1.5 0 0 1 3 0V12m0-1.5a1.5 1.5 0 0 1 3 0V14a7 7 0 0 1-7 7h-.9a6 6 0 0 1-4.8-2.4l-2.8-3.7a1.5 1.5 0 0 1 2.4-1.8L8 15" />;
    case "error":
      return (
        <>
          <circle cx="12" cy="12" r="9" />
          <path d="M12 7.5v5.5" />
          <path d="M12 16.5h.01" />
        </>
      );
    case "offline":
      return <circle cx="12" cy="12" r="8" strokeDasharray="2.5 3" />;
    case "stopped":
      return (
        <>
          <circle cx="12" cy="12" r="9" />
          <path d="M9 12h6" />
        </>
      );
    case "terminal":
      return (
        <>
          <path d="m5 8 4 4-4 4" />
          <path d="M12 17h7" />
        </>
      );
  }
}

export function StatusIcon({ kind, title }: { kind: AgentIconKind; title?: string }) {
  const t = useT();
  const label = t(`icon.${kind}`);
  return (
    <svg className={`status-icon ${kind}`} viewBox="0 0 24 24" width="16" height="16" role="img" aria-label={label} data-icon={kind}>
      <title>{title ? `${label} · ${title}` : label}</title>
      <Glyph kind={kind} />
    </svg>
  );
}

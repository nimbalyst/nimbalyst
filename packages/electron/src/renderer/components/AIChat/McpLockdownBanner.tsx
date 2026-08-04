import React, { useEffect, useState } from 'react';
import { MaterialSymbol } from '@nimbalyst/runtime/ui/icons/MaterialSymbol';

interface McpLockdownBannerProps {
  /** Session provider id; the lockdown only affects the Claude Code paths. */
  provider?: string | null;
}

/**
 * Enterprise MCP lockdown notice (NIM-2372).
 *
 * On a machine with an enterprise `managed-mcp.json`, the `claude` binary rejects
 * every MCP server a host application passes it, so Nimbalyst launches Claude
 * sessions with none of its own tools. That degradation is invisible otherwise —
 * the agent simply cannot call the widgets — so say it once per session.
 *
 * The probe is a filesystem check in main, cached there; this caches the answer
 * per renderer too so every session doesn't re-ask.
 */
let lockdownProbe: Promise<boolean> | null = null;

function probeLockdown(): Promise<boolean> {
  if (!lockdownProbe) {
    lockdownProbe = (async () => {
      try {
        const api = (window as any)?.electronAPI;
        if (!api?.invoke) return false;
        const result = await api.invoke('mcp-config:enterprise-lockdown');
        return Boolean(result?.active);
      } catch {
        return false;
      }
    })();
  }
  return lockdownProbe;
}

export function McpLockdownBanner({ provider }: McpLockdownBannerProps) {
  const [active, setActive] = useState(false);
  const [dismissed, setDismissed] = useState(false);

  const isClaude = typeof provider === 'string' && provider.startsWith('claude');

  useEffect(() => {
    if (!isClaude) return;
    let cancelled = false;
    probeLockdown().then((result) => {
      if (!cancelled) setActive(result);
    });
    return () => {
      cancelled = true;
    };
  }, [isClaude]);

  if (!isClaude || !active || dismissed) return null;

  return (
    <div className="mcp-lockdown-banner flex items-start justify-between gap-2 px-3 py-2 bg-amber-400/10 border-b border-amber-400/30">
      <div className="mcp-lockdown-banner__info flex items-start gap-2 select-text">
        <MaterialSymbol icon="policy" size={16} className="mcp-lockdown-banner__icon text-nim-warning mt-0.5" />
        <span className="mcp-lockdown-banner__text text-xs text-nim-warning leading-snug">
          This machine has an enterprise Claude Code MCP policy, so Nimbalyst&apos;s own tools are unavailable in
          this session — no interactive question widgets, session naming, tracker tools, or extension tools. Claude
          Code itself runs normally on your organization&apos;s servers.
        </span>
      </div>
      <button
        className="mcp-lockdown-banner__dismiss shrink-0 px-2 py-1 bg-transparent border-none text-nim-warning text-[11px] font-medium cursor-pointer hover:opacity-80"
        onClick={() => setDismissed(true)}
        title="Dismiss"
      >
        Dismiss
      </button>
    </div>
  );
}

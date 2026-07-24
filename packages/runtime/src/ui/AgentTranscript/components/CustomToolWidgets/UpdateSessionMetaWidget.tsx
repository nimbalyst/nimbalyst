/**
 * UpdateSessionMetaWidget - Custom widget for the update_session_meta MCP tool.
 *
 * Shows session metadata transitions: what changed and the resulting state.
 * - Tags: kept (neutral), added (green), removed (red strikethrough)
 * - Phase: always shown as a transition arrow (old -> new)
 * - Name: shown with "Set" badge if newly set, or "Already set" note
 */

import React from 'react';
import type { CustomToolWidgetProps } from './index';

// ---------- Types ----------

interface MetaState {
  name: string | null;
  tags: string[];
  phase: string | null;
}

interface StructuredResult {
  summary: string;
  before: MetaState;
  after: MetaState;
}

// ---------- Helpers ----------

/** Try to extract a text string from the tool result, handling multiple storage shapes */
function getResultText(result: unknown): string | null {
  if (!result) return null;
  if (typeof result === 'string') return result;

  // Direct MCP content array: [{ type: "text", text: "..." }]
  if (Array.isArray(result)) {
    for (const block of result) {
      if (block && block.type === 'text' && block.text) return block.text as string;
    }
    return null;
  }

  const r = result as any;

  // Wrapped MCP content: { content: [{ type: "text", text: "..." }] }
  if (r.content && Array.isArray(r.content)) {
    for (const block of r.content) {
      if (block.type === 'text' && block.text) return block.text as string;
    }
  }

  // ToolResult.result may hold the raw content
  if (r.result != null) return getResultText(r.result);

  // ToolResult.output may hold the raw content
  if (r.output != null && typeof r.output === 'string') return r.output;

  // Already-parsed structured object (from canonical transcript path):
  // the transformer extracts inner text and parseToolResult() parses it back
  if (r.summary != null && typeof r.summary === 'string') return r.summary;

  return null;
}

function extractResult(tool: { result?: unknown }): StructuredResult | null {
  // Direct structured object: when the canonical transcript path extracts the inner
  // JSON text from MCP content arrays, parseToolResult() parses it back into a plain
  // object. Check for that shape first before trying the text extraction path.
  if (tool.result && typeof tool.result === 'object' && !Array.isArray(tool.result)) {
    const r = tool.result as any;
    if (r.before && r.after) {
      return r as StructuredResult;
    }
  }

  const text = getResultText(tool.result);
  if (!text) return null;

  try {
    const parsed = JSON.parse(text);
    if (parsed.before && parsed.after) {
      return parsed as StructuredResult;
    }
    // MCP content wrapper: { content: [{ type: "text", text: "{...}" }] }
    if (parsed.content && Array.isArray(parsed.content)) {
      const innerText = getResultText(parsed);
      if (innerText) {
        try {
          const inner = JSON.parse(innerText);
          if (inner.before && inner.after) return inner as StructuredResult;
        } catch { /* not JSON inner text */ }
      }
    }
    // Codex SDK wraps MCP results in { success, result, status }.
    if (parsed.result) {
      const inner = typeof parsed.result === 'string' ? JSON.parse(parsed.result) : parsed.result;
      if (inner && inner.before && inner.after) {
        return inner as StructuredResult;
      }
    }
  } catch {
    // Not JSON - old format, can't show transitions
  }

  return null;
}

// ---------- Phase colors ----------

const PHASE_STYLES: Record<string, { bg: string; text: string }> = {
  backlog: { bg: 'rgba(156,163,175,0.15)', text: 'var(--nim-text-faint)' },
  planning: { bg: 'rgba(168,85,247,0.15)', text: '#c084fc' },
  implementing: { bg: 'rgba(59,130,246,0.15)', text: 'var(--nim-primary)' },
  validating: { bg: 'rgba(251,191,36,0.15)', text: '#fbbf24' },
  complete: { bg: 'rgba(74,222,128,0.15)', text: '#4ade80' },
};

const getPhaseStyle = (phase: string | null) =>
  phase ? (PHASE_STYLES[phase] ?? { bg: 'rgba(156,163,175,0.15)', text: 'var(--nim-text-faint)' }) : null;

// ---------- Small components ----------

const PhaseBadge: React.FC<{ phase: string }> = ({ phase }) => {
  const style = getPhaseStyle(phase)!;
  return (
    <span
      style={{
        fontSize: '10px',
        padding: '1px 7px',
        borderRadius: '10px',
        fontWeight: 500,
        background: style.bg,
        color: style.text,
      }}
    >
      {phase}
    </span>
  );
};

const TagPill: React.FC<{ tag: string; variant: 'kept' | 'added' | 'removed' }> = ({ tag, variant }) => {
  const styles: Record<string, React.CSSProperties> = {
    kept: {
      background: 'var(--nim-bg-tertiary)',
      color: 'var(--nim-text-muted)',
      border: '1px solid var(--nim-border)',
    },
    added: {
      background: 'rgba(74,222,128,0.12)',
      color: '#4ade80',
      border: '1px solid rgba(74,222,128,0.3)',
    },
    removed: {
      background: 'rgba(248,113,113,0.12)',
      color: '#f87171',
      border: '1px solid rgba(248,113,113,0.3)',
      textDecoration: 'line-through',
    },
  };

  const prefix = variant === 'added' ? '+' : variant === 'removed' ? '-' : '';

  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: '2px',
        fontSize: '10px',
        padding: '0px 6px',
        borderRadius: '10px',
        fontWeight: 500,
        lineHeight: '18px',
        ...styles[variant],
      }}
    >
      {prefix && (
        <span style={{ fontWeight: 700, fontSize: '11px' }}>{prefix}</span>
      )}
      #{tag}
    </span>
  );
};

const Arrow: React.FC = () => (
  <span
    style={{
      color: 'var(--nim-text-faint)',
      fontSize: '10px',
      padding: '0 2px',
    }}
  >
    {'\u2192'}
  </span>
);

// ---------- Main widget ----------

export const UpdateSessionMetaWidget: React.FC<CustomToolWidgetProps> = ({ message }) => {
  const tool = message.toolCall;
  if (!tool) return null;

  const data = extractResult(tool);
  if (!data) {
    // Fallback: show plain text for old-format tool results
    const fallbackText = getResultText(tool.result) ?? '';
    if (!fallbackText) {
      // No result yet (still running) - show compact card with args
      const args = tool.arguments as Record<string, any> | undefined;
      const name = args?.name;
      if (!name && !args?.add?.length && !args?.remove?.length && !args?.phase) return null;
      return (
        <div
          style={{
            border: '1px solid var(--nim-border)',
            borderRadius: '6px',
            overflow: 'hidden',
            fontSize: '11px',
          }}
        >
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '8px',
              padding: '5px 10px',
              background: 'var(--nim-bg-tertiary)',
            }}
          >
            <span style={{ fontWeight: 600, color: 'var(--nim-text)' }}>Session Meta</span>
            {name && <span style={{ color: 'var(--nim-text-muted)', fontSize: '10px' }}>{name}</span>}
          </div>
        </div>
      );
    }
    return (
      <div
        style={{
          border: '1px solid var(--nim-border)',
          borderRadius: '6px',
          overflow: 'hidden',
          fontSize: '11px',
        }}
      >
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            padding: '5px 10px',
            background: 'var(--nim-bg-tertiary)',
            borderBottom: '1px solid var(--nim-border)',
          }}
        >
          <span style={{ fontWeight: 600, color: 'var(--nim-text)' }}>Session Meta</span>
        </div>
        <div style={{ padding: '6px 10px', color: 'var(--nim-text-muted)', whiteSpace: 'pre-wrap', fontSize: '10px' }}>
          {fallbackText}
        </div>
      </div>
    );
  }

  const { before, after } = data;

  // Compute tag transitions
  const beforeSet = new Set(before.tags);
  const afterSet = new Set(after.tags);
  const kept = after.tags.filter((t) => beforeSet.has(t));
  const added = after.tags.filter((t) => !beforeSet.has(t));
  const removed = before.tags.filter((t) => !afterSet.has(t));

  // Determine what changed
  const nameChanged = before.name !== after.name;
  const nameSkipped = !nameChanged && (tool.arguments as any)?.name && before.name;
  const phaseChanged = before.phase !== after.phase;
  const tagsChanged = added.length > 0 || removed.length > 0;

  return (
    <div
      style={{
        border: '1px solid var(--nim-border)',
        borderRadius: '6px',
        overflow: 'hidden',
        fontSize: '11px',
      }}
    >
      {/* Header */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: '8px',
          padding: '5px 10px',
          background: 'var(--nim-bg-tertiary)',
          borderBottom: '1px solid var(--nim-border)',
        }}
      >
        <span style={{ fontWeight: 600, color: 'var(--nim-text)', fontSize: '11px' }}>
          Session Meta
        </span>
      </div>

      {/* Body */}
      <div style={{ padding: '8px 10px', display: 'flex', flexDirection: 'column', gap: '6px' }}>
        {/* Name row */}
        {(after.name || nameSkipped) && (
          <div style={{ display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap' }}>
            <span style={{ fontSize: '10px', color: 'var(--nim-text-faint)', fontWeight: 500, minWidth: '36px' }}>
              Name
            </span>
            <span style={{ fontSize: '11px', color: 'var(--nim-text)', fontWeight: 500 }}>
              {after.name}
            </span>
            {nameChanged && (
              <span
                style={{
                  fontSize: '9px',
                  padding: '0px 5px',
                  borderRadius: '10px',
                  fontWeight: 500,
                  background: 'rgba(74,222,128,0.12)',
                  color: '#4ade80',
                  lineHeight: '16px',
                }}
              >
                set
              </span>
            )}
            {nameSkipped && (
              <span
                style={{
                  fontSize: '9px',
                  color: 'var(--nim-text-faint)',
                  fontStyle: 'italic',
                }}
              >
                (already set)
              </span>
            )}
          </div>
        )}

        {/* Phase row */}
        {(after.phase || phaseChanged) && (
          <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
            <span style={{ fontSize: '10px', color: 'var(--nim-text-faint)', fontWeight: 500, minWidth: '36px' }}>
              Phase
            </span>
            {phaseChanged ? (
              <div style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
                {before.phase ? (
                  <PhaseBadge phase={before.phase} />
                ) : (
                  <span style={{ fontSize: '10px', color: 'var(--nim-text-faint)', fontStyle: 'italic' }}>
                    none
                  </span>
                )}
                <Arrow />
                {after.phase ? (
                  <PhaseBadge phase={after.phase} />
                ) : (
                  <span style={{ fontSize: '10px', color: 'var(--nim-text-faint)', fontStyle: 'italic' }}>
                    none
                  </span>
                )}
              </div>
            ) : (
              after.phase && <PhaseBadge phase={after.phase} />
            )}
          </div>
        )}

        {/* Tags row */}
        {(after.tags.length > 0 || removed.length > 0) && (
          <div style={{ display: 'flex', alignItems: 'flex-start', gap: '6px' }}>
            <span style={{ fontSize: '10px', color: 'var(--nim-text-faint)', fontWeight: 500, minWidth: '36px', paddingTop: '1px' }}>
              Tags
            </span>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '3px' }}>
              {kept.map((t) => (
                <TagPill key={`kept-${t}`} tag={t} variant="kept" />
              ))}
              {added.map((t) => (
                <TagPill key={`added-${t}`} tag={t} variant="added" />
              ))}
              {removed.map((t) => (
                <TagPill key={`removed-${t}`} tag={t} variant="removed" />
              ))}
            </div>
          </div>
        )}

        {/* Empty state: nothing at all */}
        {!after.name && !after.phase && after.tags.length === 0 && removed.length === 0 && (
          <span style={{ fontSize: '10px', color: 'var(--nim-text-faint)', fontStyle: 'italic' }}>
            No metadata set
          </span>
        )}
      </div>
    </div>
  );
};

UpdateSessionMetaWidget.displayName = 'UpdateSessionMetaWidget';

/**
 * MemoryToolWidget - Custom widget for the nimbalyst-memory extension's
 * retrieval tools (`recall`, `search_project_knowledge`, and their
 * `memory_`-prefixed variants).
 *
 * Shows the tool name, the query that was used, and a readable list of the
 * source documents the memory engine returned (title + a short snippet) so
 * both voice and text sessions surface what grounded the assistant's answer.
 * Renders identically regardless of whether the call came from a voice
 * session or a regular chat session -- voice tool calls reach the transcript
 * as the same canonical tool_call events, so no voice-specific branch is
 * needed here.
 *
 * Each source's title is clickable and opens the referenced document via
 * `InteractiveWidgetHost.openFile`, the same host method FileChangeWidget /
 * ExitPlanModeWidget use. `sourcePath` is root-relative, but `openFile`'s
 * underlying switch-workspace-file handler does a plain `existsSync(filePath)`
 * with no workspacePath join -- callers must resolve to an absolute path
 * themselves (see ExitPlanModeWidget.handleOpenPlanFile for the same
 * resolution), or the open silently fails with "File does not exist".
 *
 * Safeguard: only the query string and a hard-capped, whitespace-collapsed
 * snippet per source are ever rendered -- never the raw tool result blob --
 * so a single oversized fact or chunk can't dump unbounded content into the
 * transcript.
 */

import React, { useCallback } from 'react';
import { useAtomValue } from 'jotai';
import type { CustomToolWidgetProps } from './index';
import { interactiveWidgetHostAtom } from '../../../../store/atoms/interactiveWidgetHost';

// ---------- Types ----------

interface MemorySource {
  key: string;
  title: string;
  snippet: string;
  /** Root-relative path to open via the host; undefined when the tool result had no usable sourcePath. */
  path?: string;
  meta?: string;
}

interface SearchHitLike {
  sourcePath?: unknown;
  headingPath?: unknown;
  text?: unknown;
  citation?: unknown;
  /**
   * 'doc-file' for real on-disk markdown; 'tracker' / 'session' / etc. for
   * VirtualRecords the memory engine indexes without a backing file (see
   * engine/src/types.ts). Only 'doc-file' hits have an openable sourcePath --
   * a tracker/session hit's sourcePath is a synthetic id like `tracker:<uuid>`
   * that resolves to nothing on disk. Missing refType (older persisted
   * results, from before virtual records existed) is treated as 'doc-file'.
   */
  refType?: unknown;
}

interface FactLike {
  sourcePath?: unknown;
  text?: unknown;
  category?: unknown;
  scope?: unknown;
}

// ---------- Constants ----------

const MAX_SNIPPET_CHARS = 220;
const MAX_TITLE_CHARS = 80;
const MAX_VISIBLE_SOURCES = 3;

const TOOL_LABELS: Record<string, string> = {
  recall: 'Memory Recall',
  search_project_knowledge: 'Memory Search',
};

// ---------- Helpers ----------

function getResultText(result: unknown): string | null {
  if (result == null) return null;
  if (typeof result === 'string') return result;
  if (Array.isArray(result)) {
    for (const block of result) {
      if (block && typeof block === 'object' && (block as any).type === 'text' && (block as any).text) {
        return (block as any).text as string;
      }
    }
    return null;
  }
  const r = result as any;
  if (r.content && Array.isArray(r.content)) {
    for (const block of r.content) {
      if (block?.type === 'text' && block.text) return block.text as string;
    }
  }
  return null;
}

/** Collapses whitespace and hard-caps length so a single source can't dump unbounded text. */
function truncate(text: string, max: number): string {
  const collapsed = text.replace(/\s+/g, ' ').trim();
  if (collapsed.length <= max) return collapsed;
  return `${collapsed.slice(0, max).trimEnd()}…`;
}

function basename(path: string): string {
  const parts = path.split('/');
  return parts[parts.length - 1] || path;
}

/** Human label for a non-file refType, shown instead of an internal id like `tracker:<uuid>`. */
function refTypeLabel(refType: string): string {
  if (refType === 'doc-file') return 'Document';
  return refType.length > 0 ? refType.charAt(0).toUpperCase() + refType.slice(1) : 'Result';
}

function normalizeChunks(chunks: SearchHitLike[]): MemorySource[] {
  return chunks.map((chunk, i) => {
    const refType = typeof chunk.refType === 'string' && chunk.refType.length > 0 ? chunk.refType : 'doc-file';
    const isFileBacked = refType === 'doc-file';
    const hasPath = isFileBacked && typeof chunk.sourcePath === 'string' && chunk.sourcePath.length > 0;
    const path = hasPath ? (chunk.sourcePath as string) : undefined;
    const headingPath = Array.isArray(chunk.headingPath)
      ? (chunk.headingPath as unknown[]).filter((h): h is string => typeof h === 'string')
      : [];
    const title = headingPath.length > 0
      ? headingPath.join(' › ')
      : path
        ? basename(path)
        : `${refTypeLabel(refType)} result`;
    const snippetSource = typeof chunk.text === 'string' ? chunk.text : '';
    const citation = typeof chunk.citation === 'string' ? chunk.citation : null;
    const rawSourcePath = typeof chunk.sourcePath === 'string' ? chunk.sourcePath : undefined;
    return {
      key: citation || `${rawSourcePath || refType}#${i}`,
      title: truncate(title, MAX_TITLE_CHARS),
      snippet: truncate(snippetSource, MAX_SNIPPET_CHARS),
      path,
      // A real file's path is useful context; a virtual record's internal id
      // (e.g. `tracker:<uuid>`) isn't -- show its kind instead.
      meta: path ?? (isFileBacked ? undefined : refTypeLabel(refType)),
    };
  });
}

function normalizeFacts(facts: FactLike[]): MemorySource[] {
  return facts.map((fact, i) => {
    const hasPath = typeof fact.sourcePath === 'string' && fact.sourcePath.length > 0;
    const path = hasPath ? (fact.sourcePath as string) : undefined;
    const snippetSource = typeof fact.text === 'string' ? fact.text : '';
    const metaParts = [fact.category, fact.scope].filter(
      (v): v is string => typeof v === 'string' && v.length > 0
    );
    return {
      key: `${path || 'fact'}#${i}`,
      title: truncate(basename(path || `fact-${i}`), MAX_TITLE_CHARS),
      snippet: truncate(snippetSource, MAX_SNIPPET_CHARS),
      path,
      meta: metaParts.length > 0 ? metaParts.join(' / ') : path,
    };
  });
}

/** Parses the tool's JSON result into a normalized source list, or null if unrecognized/unparseable. */
function extractSources(resultText: string | null): MemorySource[] | null {
  if (!resultText) return null;
  let parsed: any;
  try {
    parsed = JSON.parse(resultText);
  } catch {
    return null;
  }
  if (Array.isArray(parsed?.chunks)) return normalizeChunks(parsed.chunks);
  if (Array.isArray(parsed?.facts)) return normalizeFacts(parsed.facts);
  return null;
}

function getBaseName(toolName: string): string {
  return toolName.replace(/^mcp__[^_]+__/, '').replace(/^memory_/, '');
}

function getToolLabel(toolName: string): string {
  return TOOL_LABELS[getBaseName(toolName)] || 'Memory Tool';
}

// ---------- Small pieces ----------

const Shell: React.FC<{ header: React.ReactNode; children: React.ReactNode; tone?: 'default' | 'error' }> = ({
  header,
  children,
  tone = 'default',
}) => (
  <div
    className="memory-tool-widget"
    style={{
      border: `1px solid ${tone === 'error' ? 'rgba(248,113,113,0.3)' : 'var(--nim-border)'}`,
      borderRadius: '6px',
      overflow: 'hidden',
      fontSize: '11px',
    }}
  >
    <div
      className="memory-tool-widget-header"
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: '8px',
        padding: '5px 10px',
        background: tone === 'error' ? 'rgba(248,113,113,0.08)' : 'var(--nim-bg-tertiary)',
        borderBottom: `1px solid ${tone === 'error' ? 'rgba(248,113,113,0.15)' : 'var(--nim-border)'}`,
      }}
    >
      {header}
    </div>
    <div
      className="memory-tool-widget-body"
      style={{ padding: '8px 10px', display: 'flex', flexDirection: 'column', gap: '6px' }}
    >
      {children}
    </div>
  </div>
);

// ---------- Main widget ----------

export const MemoryToolWidget: React.FC<CustomToolWidgetProps> = ({ message, isExpanded, onToggle, sessionId, workspacePath }) => {
  const host = useAtomValue(interactiveWidgetHostAtom(sessionId));
  const handleOpenSource = useCallback(
    (e: React.MouseEvent, path: string) => {
      e.stopPropagation();
      if (!host) return;
      // `sourcePath` is root-relative (per the memory engine); `host.openFile`
      // requires an absolute path (see ExitPlanModeWidget's identical
      // resolution) -- the underlying switch-workspace-file handler checks
      // `existsSync(filePath)` directly with no workspacePath join, so a
      // relative path here silently resolves to nothing and errors
      // "File does not exist".
      const isAbsolute = path.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(path);
      if (isAbsolute) {
        host.openFile(path);
        return;
      }
      if (!workspacePath) {
        console.warn('[MemoryToolWidget] Cannot resolve relative sourcePath without workspacePath:', path);
        return;
      }
      const separator = workspacePath.includes('\\') ? '\\' : '/';
      host.openFile(`${workspacePath}${separator}${path}`);
    },
    [host, workspacePath]
  );

  const tool = message.toolCall;
  if (!tool) return null;

  const args = (tool.arguments || {}) as Record<string, unknown>;
  const query = typeof args.query === 'string' && args.query.trim().length > 0 ? args.query.trim() : null;
  const label = getToolLabel(tool.toolName);
  const resultText = getResultText(tool.result);
  const isError = tool.isError === true || (resultText != null && /^Error:/i.test(resultText));

  if (isError) {
    return (
      <Shell
        tone="error"
        header={<span style={{ fontWeight: 600, color: '#f87171' }}>{label}</span>}
      >
        {query && (
          <div style={{ fontSize: '10px', color: 'var(--nim-text-faint)' }}>
            Query: <span style={{ fontStyle: 'italic' }}>&ldquo;{truncate(query, MAX_TITLE_CHARS)}&rdquo;</span>
          </div>
        )}
        <div style={{ color: '#f87171', fontSize: '10px' }} data-testid="memory-tool-error">
          {truncate(resultText || 'Memory lookup failed.', MAX_SNIPPET_CHARS)}
        </div>
      </Shell>
    );
  }

  // Still running -- no result yet.
  if (resultText == null) {
    return (
      <Shell header={<span style={{ fontWeight: 600, color: 'var(--nim-text)' }}>{label}</span>}>
        {query && (
          <div style={{ fontSize: '10px', color: 'var(--nim-text-faint)' }} data-testid="memory-tool-query">
            Query: <span style={{ fontStyle: 'italic' }}>&ldquo;{truncate(query, MAX_TITLE_CHARS)}&rdquo;</span>
          </div>
        )}
      </Shell>
    );
  }

  const sources = extractSources(resultText);
  const visibleSources = sources ? (isExpanded ? sources : sources.slice(0, MAX_VISIBLE_SOURCES)) : null;
  const hiddenCount = sources ? Math.max(0, sources.length - (visibleSources?.length ?? 0)) : 0;
  const canCollapse = isExpanded && (sources?.length ?? 0) > MAX_VISIBLE_SOURCES;

  return (
    <Shell
      header={
        <>
          <span style={{ fontWeight: 600, color: 'var(--nim-text)' }}>{label}</span>
          {sources && sources.length > 0 && (
            <span style={{ marginLeft: 'auto', fontSize: '10px', color: 'var(--nim-primary)', fontWeight: 500 }}>
              ({sources.length} source{sources.length !== 1 ? 's' : ''})
            </span>
          )}
        </>
      }
    >
      {query && (
        <div style={{ fontSize: '10px', color: 'var(--nim-text-faint)' }} data-testid="memory-tool-query">
          Query: <span style={{ fontStyle: 'italic', color: 'var(--nim-text-muted)' }}>&ldquo;{truncate(query, MAX_TITLE_CHARS)}&rdquo;</span>
        </div>
      )}

      {!sources || sources.length === 0 ? (
        <div
          style={{ fontSize: '10px', color: 'var(--nim-text-faint)', fontStyle: 'italic' }}
          data-testid="memory-tool-empty"
        >
          No matching memory found for this query.
        </div>
      ) : (
        <>
          <ul
            style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: '6px' }}
            data-testid="memory-tool-sources"
          >
            {visibleSources!.map((source) => (
              <li
                key={source.key}
                data-testid="memory-tool-source"
                style={{
                  borderTop: '1px solid rgba(74,74,74,0.4)',
                  paddingTop: '5px',
                }}
              >
                {source.path ? (
                  <div
                    data-testid="memory-tool-source-title"
                    onClick={(e) => handleOpenSource(e, source.path!)}
                    style={{ fontSize: '11px', fontWeight: 500, color: 'var(--nim-text)', cursor: 'pointer' }}
                    onMouseEnter={(e) => {
                      e.currentTarget.style.textDecoration = 'underline';
                      e.currentTarget.style.color = 'var(--nim-primary)';
                    }}
                    onMouseLeave={(e) => {
                      e.currentTarget.style.textDecoration = 'none';
                      e.currentTarget.style.color = 'var(--nim-text)';
                    }}
                  >
                    {source.title}
                  </div>
                ) : (
                  <div style={{ fontSize: '11px', fontWeight: 500, color: 'var(--nim-text)' }}>{source.title}</div>
                )}
                {source.meta && (
                  <div style={{ fontSize: '9px', color: 'var(--nim-text-faint)', fontFamily: 'monospace' }}>
                    {source.meta}
                  </div>
                )}
                <div style={{ fontSize: '10px', color: 'var(--nim-text-muted)', marginTop: '2px' }}>
                  {source.snippet}
                </div>
              </li>
            ))}
          </ul>
          {(hiddenCount > 0 || canCollapse) && (
            <button
              type="button"
              onClick={onToggle}
              data-testid="memory-tool-toggle"
              style={{
                alignSelf: 'flex-start',
                background: 'none',
                border: 'none',
                padding: 0,
                fontSize: '10px',
                color: 'var(--nim-primary)',
                cursor: 'pointer',
              }}
            >
              {hiddenCount > 0 ? `Show ${hiddenCount} more source${hiddenCount !== 1 ? 's' : ''}` : 'Show fewer'}
            </button>
          )}
        </>
      )}
    </Shell>
  );
};

MemoryToolWidget.displayName = 'MemoryToolWidget';

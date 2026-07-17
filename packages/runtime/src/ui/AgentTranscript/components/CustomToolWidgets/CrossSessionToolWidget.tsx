/**
 * CrossSessionToolWidget — renders the meta-agent (child-session orchestration)
 * tool calls (`send_prompt`, `spawn_session`, `create_session`,
 * `get_session_status`, `get_session_result`, `list_queued_prompts`,
 * `respond_to_prompt`, `list_spawned_sessions`) with a clickable
 * `SessionReferenceChip` for the target/child session(s) instead of the generic
 * raw-UUID tool card.
 *
 * The target id comes from `arguments.sessionId` (tools that address an existing
 * session) and/or from the JSON result (create/spawn mint a new id;
 * list_spawned_sessions returns several). Clicking a chip opens that session.
 */

import React from 'react';
import type { CustomToolWidgetProps } from './index';
import { SessionReferenceChip } from '../../session/SessionReferenceChip';

interface ActionMeta {
  label: string;
  icon: string;
  /** Argument key holding a human-readable detail (prompt/response text). */
  detailArg?: string;
}

const ACTIONS: Record<string, ActionMeta> = {
  send_prompt: { label: 'Send prompt', icon: 'send', detailArg: 'prompt' },
  respond_to_prompt: { label: 'Respond to prompt', icon: 'reply', detailArg: 'response' },
  spawn_session: { label: 'Spawn session', icon: 'rocket_launch', detailArg: 'prompt' },
  create_session: { label: 'Create session', icon: 'add_circle', detailArg: 'initialPrompt' },
  get_session_status: { label: 'Get session status', icon: 'query_stats' },
  get_session_result: { label: 'Get session result', icon: 'task_alt' },
  list_queued_prompts: { label: 'List queued prompts', icon: 'list' },
  list_spawned_sessions: { label: 'List spawned sessions', icon: 'account_tree' },
};

/** Strip an `mcp__<server>__` prefix to the bare tool name. */
function bareToolName(name: string): string {
  return name.replace(/^mcp__[^_]+__/, '');
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_RE.test(value);
}

/** Extract a text string from a possibly-wrapped MCP tool result. */
function getResultText(result: unknown): string | null {
  if (!result) return null;
  if (typeof result === 'string') return result;
  if (Array.isArray(result)) {
    for (const block of result) {
      if (block && block.type === 'text' && block.text) return block.text as string;
    }
    return null;
  }
  const r = result as any;
  if (r.content && Array.isArray(r.content)) {
    for (const block of r.content) {
      if (block.type === 'text' && block.text) return block.text as string;
    }
  }
  if (r.result != null) return getResultText(r.result);
  if (typeof r.output === 'string') return r.output;
  return null;
}

/** Collect distinct session ids referenced by the result JSON. */
function collectResultSessionIds(result: unknown): string[] {
  const text = getResultText(result);
  if (!text) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return [];
  }
  const ids: string[] = [];
  const add = (v: unknown) => {
    if (isUuid(v) && !ids.includes(v)) ids.push(v);
  };
  const visit = (node: unknown) => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      node.forEach(visit);
      return;
    }
    const o = node as Record<string, unknown>;
    add(o.sessionId);
    add(o.id);
    if (Array.isArray(o.sessions)) o.sessions.forEach(visit);
  };
  visit(parsed);
  return ids;
}

function truncate(text: string, max = 120): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

export const CrossSessionToolWidget: React.FC<CustomToolWidgetProps> = ({
  message,
  isExpanded,
  onToggle,
}) => {
  const tool = message.toolCall;
  if (!tool) return null;

  const bare = tool.mcpTool || bareToolName(tool.toolName);
  const action = ACTIONS[bare] ?? { label: bare, icon: 'account_tree' };
  const args = (tool.arguments ?? {}) as Record<string, unknown>;

  // Target session(s): the addressed session from args, plus any minted/listed
  // ids from the result (create/spawn/list).
  const argSessionId = isUuid(args.sessionId) ? args.sessionId : null;
  const resultIds = collectResultSessionIds(tool.result);
  const sessionIds = Array.from(
    new Set([...(argSessionId ? [argSessionId] : []), ...resultIds]),
  );

  const detail =
    action.detailArg && typeof args[action.detailArg] === 'string'
      ? (args[action.detailArg] as string)
      : null;

  const canExpand = Boolean(detail || tool.result);
  const isError = tool.isError || tool.status === 'error';

  return (
    <div
      className="cross-session-tool-widget"
      data-tool={bare}
      style={{
        border: '1px solid var(--nim-border)',
        borderRadius: '8px',
        background: 'var(--nim-bg-secondary)',
        padding: '8px 10px',
        fontSize: '13px',
        color: 'var(--nim-text)',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
        <span
          className="material-symbols-outlined"
          aria-hidden="true"
          style={{
            fontSize: '16px',
            color: isError ? 'var(--nim-error)' : 'var(--nim-text-muted)',
          }}
        >
          {action.icon}
        </span>
        <span style={{ fontWeight: 600 }}>{action.label}</span>
        {sessionIds.length > 0 ? (
          <span
            className="material-symbols-outlined"
            aria-hidden="true"
            style={{ fontSize: '15px', color: 'var(--nim-text-faint)' }}
          >
            arrow_forward
          </span>
        ) : null}
        {sessionIds.map((id) => (
          <SessionReferenceChip key={id} sessionId={id} variant="compact" />
        ))}
        {canExpand ? (
          <button
            type="button"
            onClick={onToggle}
            className="cross-session-tool-widget-toggle"
            style={{
              marginLeft: 'auto',
              display: 'inline-flex',
              alignItems: 'center',
              gap: '2px',
              background: 'transparent',
              border: 'none',
              color: 'var(--nim-text-muted)',
              cursor: 'pointer',
              fontSize: '12px',
            }}
          >
            {isExpanded ? 'Hide' : 'Details'}
            <span
              className="material-symbols-outlined"
              aria-hidden="true"
              style={{ fontSize: '16px' }}
            >
              {isExpanded ? 'expand_less' : 'expand_more'}
            </span>
          </button>
        ) : null}
      </div>

      {detail && !isExpanded ? (
        <div
          className="cross-session-tool-widget-preview"
          style={{
            marginTop: '6px',
            color: 'var(--nim-text-muted)',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {truncate(detail)}
        </div>
      ) : null}

      {isExpanded ? (
        <div className="cross-session-tool-widget-details" style={{ marginTop: '8px' }}>
          {detail ? (
            <pre
              style={{
                margin: 0,
                marginBottom: tool.result ? '8px' : 0,
                whiteSpace: 'pre-wrap',
                wordBreak: 'break-word',
                fontFamily: 'inherit',
                color: 'var(--nim-text)',
              }}
            >
              {detail}
            </pre>
          ) : null}
          {tool.result ? (
            <pre
              style={{
                margin: 0,
                padding: '8px',
                borderRadius: '6px',
                background: 'var(--nim-bg-tertiary)',
                whiteSpace: 'pre-wrap',
                wordBreak: 'break-word',
                fontSize: '12px',
                color: isError ? 'var(--nim-error)' : 'var(--nim-text-muted)',
              }}
            >
              {getResultText(tool.result) ?? String(tool.result)}
            </pre>
          ) : null}
        </div>
      ) : null}
    </div>
  );
};

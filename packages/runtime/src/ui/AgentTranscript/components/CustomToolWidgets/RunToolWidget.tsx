/**
 * One transcript line for an agent acting on a run target (`run_start`,
 * `run_stop`, `run_restart` from the built-in Run Manager extension): the
 * target, the status it went from and to, and a link to its log, which is the
 * target's terminal tab.
 *
 * The widget lives here rather than in the extension because transcript
 * widgets are registered by the host.
 */

import React, { useState } from 'react';
import { useAtomValue } from 'jotai';
import { interactiveWidgetHostAtom } from '../../../../store/atoms/interactiveWidgetHost';
import type { CustomToolWidgetProps } from './index';

/** Owner of the run terminals: the Run Manager extension. */
const RUN_EXTENSION_ID = 'com.nimbalyst.run';

type RunAction = 'start' | 'stop' | 'restart';

const VERBS: Record<RunAction, { running: string; done: string; failed: string }> = {
  start: { running: 'Starting', done: 'Started', failed: 'Could not start' },
  stop: { running: 'Stopping', done: 'Stopped', failed: 'Could not stop' },
  restart: { running: 'Restarting', done: 'Restarted', failed: 'Could not restart' },
};

function actionFromToolName(toolName: string): RunAction {
  if (toolName.endsWith('run_stop')) return 'stop';
  if (toolName.endsWith('run_restart')) return 'restart';
  return 'start';
}

function parseObject(text: string): Record<string, unknown> | unknown[] | null {
  try {
    const parsed: unknown = JSON.parse(text);
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown> | unknown[]) : null;
  } catch {
    return null;
  }
}

/** The tool's JSON payload, whether it arrives as text, MCP content blocks, or an object. */
export function parseRunToolResult(result: unknown): Record<string, unknown> | null {
  let value: unknown = result;
  if (typeof value === 'string') value = parseObject(value);
  if (Array.isArray(value)) {
    const block = value.find(
      (entry): entry is { type: 'text'; text: string } =>
        !!entry && typeof entry === 'object' && (entry as { type?: unknown }).type === 'text' && typeof (entry as { text?: unknown }).text === 'string',
    );
    value = block ? parseObject(block.text) : null;
  }
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function errorText(result: unknown): string | null {
  if (typeof result !== 'string') return null;
  const parsed = parseObject(result);
  if (Array.isArray(parsed)) {
    const block = parsed.find((entry) => (entry as { type?: unknown })?.type === 'text') as { text?: unknown } | undefined;
    return typeof block?.text === 'string' ? block.text : null;
  }
  return result;
}

function statusText(status: unknown, exitCode: unknown): string {
  if (typeof status !== 'string') return '';
  return status === 'crashed' && typeof exitCode === 'number' ? `crashed (exit ${exitCode})` : status;
}

export const RunToolWidget: React.FC<CustomToolWidgetProps> = ({ message, sessionId }) => {
  const host = useAtomValue(interactiveWidgetHostAtom(sessionId));
  const [noLogTab, setNoLogTab] = useState(false);
  const tool = message.toolCall;
  if (!tool) return null;

  const action = actionFromToolName(tool.toolName);
  const args = (tool.arguments ?? {}) as { id?: unknown };
  const payload = parseRunToolResult(tool.result);
  const id = typeof args.id === 'string' ? args.id : typeof payload?.id === 'string' ? payload.id : '';
  const name = typeof payload?.name === 'string' ? payload.name : id || 'a run target';

  const callRunning = tool.status === 'running';
  const callFailed = !callRunning && (tool.isError || tool.status === 'error' || !payload);
  const status = payload?.status;
  const timedOut = payload?.timedOut === true;
  // The call can succeed while the target did not: it crashed, or is still starting.
  const outcome: 'running' | 'done' | 'pending' | 'failed' = callRunning
    ? 'running'
    : callFailed || status === 'crashed'
      ? 'failed'
      : timedOut
        ? 'pending'
        : 'done';

  const verb = callRunning ? VERBS[action].running : callFailed ? VERBS[action].failed : VERBS[action].done;
  const from = statusText(payload?.previousStatus, undefined);
  // Field names follow the extension's tool result (`describeRun` in
  // packages/extensions/run-manager/src/backend/runTools.ts).
  const to = statusText(status, payload?.lastExitCode);
  const transition = from && to ? `${from} → ${to}` : to;
  const tone =
    outcome === 'failed'
      ? 'border-nim-error text-nim-error'
      : outcome === 'pending'
        ? 'border-nim text-nim-warning'
        : 'border-nim text-nim-muted';

  return (
    <div
      className={`run-tool-line flex items-center gap-2 rounded-md border border-dashed px-2.5 py-2 text-xs ${tone}`}
      data-testid="run-tool-line"
      data-outcome={outcome}
    >
      <span className="font-medium text-nim">{verb}</span>
      <span className="run-tool-line-name truncate text-nim">{name}</span>
      {!callRunning && !callFailed && transition && <span className="shrink-0">&middot; {transition}</span>}
      {outcome === 'pending' && <span className="shrink-0">&middot; still starting</span>}
      {callFailed && errorText(tool.result) && <span className="truncate select-text">&middot; {errorText(tool.result)}</span>}
      {id &&
        host?.revealCommandTerminal &&
        (noLogTab ? (
          <span className="run-tool-line-logs ml-auto shrink-0 text-nim-faint">No log tab</span>
        ) : (
          <button
            type="button"
            className="run-tool-line-logs ml-auto shrink-0 text-nim-primary hover:underline"
            onClick={() => {
              host.revealCommandTerminal!({ extensionId: RUN_EXTENSION_ID, key: id })
                .then((found) => {
                  if (!found) setNoLogTab(true);
                })
                .catch((error: unknown) => {
                  console.error('[RunToolWidget] Failed to show the run log:', error);
                });
            }}
          >
            Show logs
          </button>
        ))}
    </div>
  );
};

RunToolWidget.displayName = 'RunToolWidget';

/**
 * An agent starting, stopping or restarting a run target shows as one line:
 * the target, the status it went from and to, and a link to its log tab.
 */

import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { Provider as JotaiProvider } from 'jotai';
import { store } from '../../../../../store/store';
import { setInteractiveWidgetHost } from '../../../../../store/atoms/interactiveWidgetHost';
import type { InteractiveWidgetHost } from '../InteractiveWidgetHost';
import { getCustomToolWidget } from '../index';
import { parseRunToolResult } from '../RunToolWidget';

const SESSION = 'session-run-tool';

function renderTool(toolCall: Record<string, unknown>) {
  const Widget = getCustomToolWidget(String(toolCall.toolName));
  if (!Widget) throw new Error(`no widget for ${String(toolCall.toolName)}`);
  return render(
    <JotaiProvider store={store}>
      <Widget message={{ toolCall } as any} sessionId={SESSION} isExpanded={false} onToggle={() => {}} />
    </JotaiProvider>,
  );
}

function installHost(found = true): { revealCommandTerminal: ReturnType<typeof vi.fn> } {
  const host = { revealCommandTerminal: vi.fn().mockResolvedValue(found) };
  setInteractiveWidgetHost(SESSION, host as unknown as InteractiveWidgetHost);
  return host;
}

afterEach(() => setInteractiveWidgetHost(SESSION, null));

describe('run tool line', () => {
  it('shows the target, the status transition, and a link that opens its log tab', async () => {
    const host = installHost();
    const { container } = renderTool({
      toolName: 'mcp__nimbalyst-run__run_start',
      status: 'completed',
      arguments: { id: 'web' },
      result: JSON.stringify({
        action: 'start',
        previousStatus: 'stopped',
        id: 'web',
        name: 'Web dev server',
        status: 'running',
        terminalId: 'term-1',
      }),
    });

    expect(container.textContent).toContain('Started');
    expect(container.textContent).toContain('Web dev server');
    expect(container.textContent).toContain('stopped → running');
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Show logs' }));
    });
    expect(host.revealCommandTerminal).toHaveBeenCalledWith({ extensionId: 'com.nimbalyst.run', key: 'web' });
  });

  it('marks a start that ended crashed, and one that was still starting when the wait ended', () => {
    installHost();
    const crashed = renderTool({
      toolName: 'mcp__nimbalyst-run__run_restart',
      status: 'completed',
      arguments: { id: 'worker' },
      result: JSON.stringify({ action: 'restart', previousStatus: 'running', id: 'worker', name: 'Queue worker', status: 'crashed', exitCode: 1 }),
    });
    expect(crashed.container.querySelector('.run-tool-line')?.getAttribute('data-outcome')).toBe('failed');
    expect(crashed.container.textContent).toContain('running → crashed (exit 1)');
    crashed.unmount();

    const slow = renderTool({
      toolName: 'mcp__nimbalyst-run__run_start',
      status: 'completed',
      arguments: { id: 'api' },
      result: JSON.stringify({ action: 'start', previousStatus: 'stopped', id: 'api', name: 'API', status: 'starting', timedOut: true }),
    });
    expect(slow.container.querySelector('.run-tool-line')?.getAttribute('data-outcome')).toBe('pending');
    expect(slow.container.textContent).toContain('still starting');
  });

  it('names the target by id while the call is running and reports a failed call', () => {
    installHost();
    const running = renderTool({ toolName: 'mcp__nimbalyst-run__run_stop', status: 'running', arguments: { id: 'web' } });
    expect(running.container.textContent).toContain('Stopping');
    expect(running.container.textContent).toContain('web');
    running.unmount();

    const failed = renderTool({
      toolName: 'mcp__nimbalyst-run__run_start',
      status: 'error',
      isError: true,
      arguments: { id: 'nope' },
      result: 'No run target with id "nope".',
    });
    expect(failed.container.textContent).toContain('Could not start');
    expect(failed.container.textContent).toContain('No run target with id "nope".');
  });

  it('says so when the target has no log tab any more', async () => {
    installHost(false);
    const { container } = renderTool({
      toolName: 'mcp__nimbalyst-run__run_stop',
      status: 'completed',
      arguments: { id: 'web' },
      result: JSON.stringify({ action: 'stop', previousStatus: 'running', id: 'web', name: 'Web dev server', status: 'stopped' }),
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Show logs' }));
    });
    expect(container.textContent).toContain('No log tab');
    expect(screen.queryByRole('button', { name: 'Show logs' })).toBeNull();
  });
});

describe('parseRunToolResult', () => {
  it('reads a JSON string, MCP content blocks, or an object', () => {
    const payload = { action: 'start', id: 'web', status: 'running' };
    expect(parseRunToolResult(JSON.stringify(payload))).toEqual(payload);
    expect(parseRunToolResult(JSON.stringify([{ type: 'text', text: JSON.stringify(payload) }]))).toEqual(payload);
    expect(parseRunToolResult([{ type: 'text', text: JSON.stringify(payload) }])).toEqual(payload);
    expect(parseRunToolResult(payload)).toEqual(payload);
    expect(parseRunToolResult('plain failure text')).toBeNull();
    expect(parseRunToolResult(undefined)).toBeNull();
  });
});

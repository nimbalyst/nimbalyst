/**
 * An agent edit to a page shows as one "Updated <page>" line that opens the
 * page (Decision 19: no Undo). Covers the shared-page edit tool through the
 * widget registry, and a tracker_update that changed a typed page's body.
 */

import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { Provider as JotaiProvider } from 'jotai';
import { store } from '../../../../../store/store';
import { setInteractiveWidgetHost } from '../../../../../store/atoms/interactiveWidgetHost';
import type { InteractiveWidgetHost } from '../InteractiveWidgetHost';
import { getCustomToolWidget } from '../index';
import { createHumanCitation, formatCitationMarkdown } from '../../../../../core/citationSyntax';

const SESSION = 'session-page-edit';

function renderTool(toolCall: Record<string, unknown>) {
  const Widget = getCustomToolWidget(String(toolCall.toolName));
  if (!Widget) throw new Error(`no widget for ${String(toolCall.toolName)}`);
  return render(
    <JotaiProvider store={store}>
      <Widget message={{ toolCall } as any} sessionId={SESSION} isExpanded={false} onToggle={() => {}} />
    </JotaiProvider>,
  );
}

function installHost(): { openPage: ReturnType<typeof vi.fn> } {
  const host = { openPage: vi.fn().mockResolvedValue(undefined) };
  setInteractiveWidgetHost(SESSION, host as unknown as InteractiveWidgetHost);
  return host;
}

afterEach(() => setInteractiveWidgetHost(SESSION, null));

describe('page update line', () => {
  it('shows one line per shared-page edit that opens the page', () => {
    const host = installHost();
    const { container } = renderTool({
      toolName: 'mcp__nimbalyst-situational__applyCollabDocEdit',
      status: 'completed',
      arguments: {
        filePath: 'collab://org:o1:doc:d1',
        replacements: [
          {
            oldText: 'a',
            newText: `One shared DataTable. ${formatCitationMarkdown(createHumanCitation({
              sessionId: 's1', inputKind: 'answer', key: 'toolu_q1', by: 'Greg Hinkle', email: 'greg@example.com',
            }))}`,
          },
          { oldText: 'b', newText: 'AG Grid is out.' },
        ],
      },
      result: 'Updated "TanStack Table" (collab://org:o1:doc:d1)',
      providerToolCallId: 'call-1',
      progress: [],
    });

    expect(container.querySelectorAll('.page-update-line')).toHaveLength(1);
    expect(screen.queryByText(/undo/i)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'TanStack Table' }));
    expect(host.openPage).toHaveBeenCalledWith('collab://org:o1:doc:d1');
    expect(container.textContent).toContain('2 edits');
    expect(container.textContent).toContain('cited to your answer');
  });

  it('adds the line to a tracker_update that changed the typed page body', () => {
    const host = installHost();
    const structured = {
      action: 'updated',
      id: 'item-7',
      type: 'library',
      title: 'TanStack Table',
      changes: { description: { from: 'old', to: 'new body' } },
    };
    const { container } = renderTool({
      toolName: 'mcp__nimbalyst-trackers__tracker_update',
      status: 'completed',
      arguments: { id: 'item-7', description: 'new body' },
      result: JSON.stringify({ structured, summary: 'Updated' }),
      providerToolCallId: 'call-2',
      progress: [],
    });

    expect(container.querySelectorAll('.page-update-line')).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: 'TanStack Table' }));
    expect(host.openPage).toHaveBeenCalledWith('tracker://item-7');
  });
});

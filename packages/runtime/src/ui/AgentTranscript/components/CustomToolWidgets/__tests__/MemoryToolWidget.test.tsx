import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { Provider as JotaiProvider } from 'jotai';
import { store } from '../../../../../store/store';
import { setInteractiveWidgetHost } from '../../../../../store/atoms/interactiveWidgetHost';
import { MemoryToolWidget } from '../MemoryToolWidget';
import type { InteractiveWidgetHost } from '../InteractiveWidgetHost';

const SESSION_ID = 'session-1';
const WORKSPACE_PATH = '/workspace';

function makeMessage(overrides: Record<string, unknown> = {}) {
  return {
    toolCall: {
      toolName: 'memory_recall',
      toolDisplayName: 'Memory Recall',
      status: 'completed',
      description: null,
      arguments: { query: 'voice mode shortcut' },
      targetFilePath: null,
      mcpServer: 'nimbalyst-memory',
      mcpTool: 'recall',
      result: undefined,
      providerToolCallId: 'call-1',
      progress: [],
      ...overrides,
    },
  } as any;
}

function renderWidget(
  overrides: Record<string, unknown> = {},
  props: Partial<{ isExpanded: boolean; onToggle: () => void; workspacePath: string }> = {}
) {
  return render(
    <JotaiProvider store={store}>
      <MemoryToolWidget
        message={makeMessage(overrides)}
        sessionId={SESSION_ID}
        workspacePath={props.workspacePath ?? WORKSPACE_PATH}
        isExpanded={props.isExpanded ?? false}
        onToggle={props.onToggle ?? vi.fn()}
      />
    </JotaiProvider>
  );
}

function makeFakeHost(): InteractiveWidgetHost {
  return { openFile: vi.fn().mockResolvedValue(undefined) } as unknown as InteractiveWidgetHost;
}

describe('MemoryToolWidget', () => {
  beforeEach(() => {
    setInteractiveWidgetHost(SESSION_ID, null);
  });

  it('opens the referenced document when a source title is clicked, resolved to an absolute path', () => {
    // Regression: openFile's underlying switch-workspace-file handler does a
    // plain existsSync(filePath) with no workspacePath join, so passing the
    // engine's root-relative sourcePath as-is resolved to nothing on disk and
    // failed with "File does not exist: <relative path>".
    const host = makeFakeHost();
    setInteractiveWidgetHost(SESSION_ID, host);

    renderWidget({
      arguments: { query: 'preferred commit style' },
      result: JSON.stringify({
        facts: [{ sourcePath: 'facts/git-preferences.md', text: 'Use one-sentence commit subjects.' }],
      }),
    });

    fireEvent.click(screen.getByTestId('memory-tool-source-title'));
    expect(host.openFile).toHaveBeenCalledWith(`${WORKSPACE_PATH}/facts/git-preferences.md`);
  });

  it('opens an already-absolute sourcePath unchanged', () => {
    const host = makeFakeHost();
    setInteractiveWidgetHost(SESSION_ID, host);

    renderWidget({
      arguments: { query: 'preferred commit style' },
      result: JSON.stringify({
        facts: [{ sourcePath: '/elsewhere/facts/git-preferences.md', text: 'Use one-sentence commit subjects.' }],
      }),
    });

    fireEvent.click(screen.getByTestId('memory-tool-source-title'));
    expect(host.openFile).toHaveBeenCalledWith('/elsewhere/facts/git-preferences.md');
  });

  it('does not attempt to open a file when workspacePath is unavailable', () => {
    const host = makeFakeHost();
    setInteractiveWidgetHost(SESSION_ID, host);

    renderWidget(
      {
        arguments: { query: 'preferred commit style' },
        result: JSON.stringify({
          facts: [{ sourcePath: 'facts/git-preferences.md', text: 'Use one-sentence commit subjects.' }],
        }),
      },
      { workspacePath: '' }
    );

    fireEvent.click(screen.getByTestId('memory-tool-source-title'));
    expect(host.openFile).not.toHaveBeenCalled();
  });

  it('does not render a clickable title when the result has no sourcePath', () => {
    const host = makeFakeHost();
    setInteractiveWidgetHost(SESSION_ID, host);

    renderWidget({
      arguments: { query: 'no path fact' },
      result: JSON.stringify({ facts: [{ text: 'A fact with no sourcePath.' }] }),
    });

    expect(screen.queryByTestId('memory-tool-source-title')).toBeNull();
    expect(screen.getByTestId('memory-tool-source').textContent).toContain('A fact with no sourcePath.');
  });

  it('does not treat a virtual-record (tracker/session) hit as an openable file', () => {
    // Regression: search_project_knowledge can return hits indexed from
    // trackers/sessions (VirtualRecords), whose sourcePath is a synthetic id
    // like `tracker:<uuid>` rather than a real file. Clicking it used to
    // resolve to a nonexistent path and open a blank editor tab.
    const host = makeFakeHost();
    setInteractiveWidgetHost(SESSION_ID, host);

    renderWidget({
      toolName: 'search_project_knowledge',
      arguments: { query: 'auth bug' },
      result: JSON.stringify({
        chunks: [
          {
            sourcePath: 'tracker:abc-123',
            refType: 'tracker',
            headingPath: ['Fix auth redirect loop'],
            text: 'Tracked bug: auth redirect loop on expired session.',
          },
        ],
      }),
    });

    expect(screen.queryByTestId('memory-tool-source-title')).toBeNull();
    const source = screen.getByTestId('memory-tool-source');
    expect(source.textContent).toContain('Fix auth redirect loop');
    expect(source.textContent).toContain('Tracked bug: auth redirect loop');
  });

  it('still opens a doc-file chunk explicitly tagged refType: doc-file', () => {
    const host = makeFakeHost();
    setInteractiveWidgetHost(SESSION_ID, host);

    renderWidget({
      toolName: 'search_project_knowledge',
      arguments: { query: 'realtime voice grounding' },
      result: JSON.stringify({
        chunks: [
          {
            sourcePath: 'design/VoiceMode/realtime-grounding.md',
            refType: 'doc-file',
            headingPath: ['Voice Mode'],
            text: 'The voice bridge grounds responses using memory search.',
          },
        ],
      }),
    });

    fireEvent.click(screen.getByTestId('memory-tool-source-title'));
    expect(host.openFile).toHaveBeenCalledWith(`${WORKSPACE_PATH}/design/VoiceMode/realtime-grounding.md`);
  });

  it('renders the query and the returned source list for a chunk-based search result', () => {
    renderWidget({
      toolName: 'mcp__nimbalyst-memory__memory_search_project_knowledge',
      arguments: { query: 'realtime voice grounding' },
      result: JSON.stringify({
        chunks: [
          {
            sourcePath: 'design/VoiceMode/realtime-grounding.md',
            headingPath: ['Voice Mode', 'Realtime Grounding'],
            text: 'The voice bridge grounds responses using the memory engine search tool.',
            citation: 'design/VoiceMode/realtime-grounding.md#Realtime Grounding',
          },
        ],
      }),
    });

    expect(screen.getByTestId('memory-tool-query').textContent).toContain('realtime voice grounding');
    const sources = screen.getAllByTestId('memory-tool-source');
    expect(sources).toHaveLength(1);
    expect(sources[0].textContent).toContain('Voice Mode');
    expect(sources[0].textContent).toContain('Realtime Grounding');
    expect(sources[0].textContent).toContain('The voice bridge grounds responses');
  });

  it('renders the query and the returned source list for a fact-based recall result', () => {
    renderWidget({
      arguments: { query: 'preferred commit style' },
      result: JSON.stringify({
        facts: [
          {
            sourcePath: 'facts/git-preferences.md',
            text: 'Use one-sentence commit subjects; no Co-Authored-By trailers.',
            category: 'git',
            scope: 'global',
            priority: 1,
            mtime: 0,
          },
        ],
      }),
    });

    expect(screen.getByTestId('memory-tool-query').textContent).toContain('preferred commit style');
    const sources = screen.getAllByTestId('memory-tool-source');
    expect(sources).toHaveLength(1);
    expect(sources[0].textContent).toContain('git-preferences.md');
    expect(sources[0].textContent).toContain('git / global');
    expect(sources[0].textContent).toContain('Use one-sentence commit subjects');
  });

  it('shows an explicit empty state when recall returns no facts', () => {
    renderWidget({
      arguments: { query: 'something never remembered' },
      result: JSON.stringify({ facts: [] }),
    });

    expect(screen.getByTestId('memory-tool-empty')).toBeTruthy();
    expect(screen.queryByTestId('memory-tool-source')).toBeNull();
  });

  it('shows an explicit empty state when search returns no chunks', () => {
    renderWidget({
      toolName: 'memory_search_project_knowledge',
      arguments: { query: 'nonexistent topic' },
      result: JSON.stringify({ chunks: [] }),
    });

    expect(screen.getByTestId('memory-tool-empty')).toBeTruthy();
    expect(screen.queryByTestId('memory-tool-source')).toBeNull();
  });

  it('renders independently across multiple sequential memory tool calls', () => {
    const { unmount: unmountFirst } = renderWidget({
      providerToolCallId: 'call-1',
      arguments: { query: 'first query' },
      result: JSON.stringify({ facts: [{ sourcePath: 'facts/a.md', text: 'fact A' }] }),
    });
    expect(screen.getByTestId('memory-tool-query').textContent).toContain('first query');
    expect(screen.getAllByTestId('memory-tool-source')).toHaveLength(1);
    unmountFirst();

    renderWidget({
      providerToolCallId: 'call-2',
      arguments: { query: 'second query' },
      result: JSON.stringify({
        facts: [
          { sourcePath: 'facts/b.md', text: 'fact B' },
          { sourcePath: 'facts/c.md', text: 'fact C' },
        ],
      }),
    });
    expect(screen.getByTestId('memory-tool-query').textContent).toContain('second query');
    expect(screen.getAllByTestId('memory-tool-source')).toHaveLength(2);
  });

  it('caps each snippet so a single oversized fact cannot dump unbounded content', () => {
    const hugeText = 'x'.repeat(5000);
    renderWidget({
      arguments: { query: 'huge fact' },
      result: JSON.stringify({ facts: [{ sourcePath: 'facts/huge.md', text: hugeText }] }),
    });

    const source = screen.getByTestId('memory-tool-source');
    // Well under the raw fact length -- the safeguard truncates to a fixed
    // display budget rather than rendering the full stored text.
    expect(source.textContent!.length).toBeLessThan(400);
  });

  it('renders a sanitized error instead of the raw tool failure payload', () => {
    renderWidget({
      arguments: { query: 'broken query' },
      result: 'Error: engine unavailable',
      isError: true,
    });

    expect(screen.getByTestId('memory-tool-error').textContent).toContain('engine unavailable');
    expect(screen.queryByTestId('memory-tool-source')).toBeNull();
  });

  it('returns null when there is no tool call to render', () => {
    const { container } = render(
      <MemoryToolWidget
        message={{ toolCall: undefined } as any}
        sessionId="session-1"
        isExpanded={false}
        onToggle={() => {}}
      />
    );
    expect(container.firstChild).toBeNull();
  });
});

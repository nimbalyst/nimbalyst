import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import type { CanvasDocument } from '../CanvasDocument';
import { readCanvasNavigation } from '../canvasNavigation';
import { CanvasNavigationPanel } from '../CanvasNavigationPanel';

vi.mock('@xyflow/react', () => ({
  Panel: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));
afterEach(cleanup);

function board(navigation: unknown): CanvasDocument {
  return {
    nodes: ['files', 'agent', 'editor', 'tree'].map((id) => ({
      id,
      type: 'text',
      text: id,
      x: 0,
      y: 0,
      width: 100,
      height: 100,
      'x-nimbalyst': { label: id },
    })),
    edges: [],
    'x-nimbalyst': { navigation },
  };
}
const navigation = [
  { nodeId: 'files' },
  { nodeId: 'editor', parentId: 'files' },
  { nodeId: 'tree', parentId: 'files' },
  { nodeId: 'agent' },
];

describe('canvas screen navigation', () => {
  it('ignores malformed, duplicate and removed references, preserving explicit order', () => {
    const result = readCanvasNavigation(
      board([
        null,
        {},
        { nodeId: 'removed' },
        ...navigation,
        { nodeId: 'files' },
      ])
    );
    expect(result.map((item) => item.nodeId)).toEqual([
      'files',
      'editor',
      'tree',
      'agent',
    ]);
    expect(result[1].parentId).toBe('files');
  });
  it('recovers missing parents and breaks cycles without infinite ancestry', () => {
    const result = readCanvasNavigation(
      board([
        { nodeId: 'files', parentId: 'agent' },
        { nodeId: 'agent', parentId: 'files' },
        { nodeId: 'editor', parentId: 'removed' },
        { nodeId: 'tree', parentId: 'tree' },
      ])
    );
    const byId = new Map(result.map((item) => [item.nodeId, item]));
    for (const item of result) {
      const seen = new Set([item.nodeId]);
      let parent = item.parentId;
      while (parent) {
        expect(seen.has(parent)).toBe(false);
        seen.add(parent);
        parent = byId.get(parent)!.parentId;
      }
    }
    expect(byId.get('editor')?.parentId).toBeNull();
    expect(byId.get('tree')?.parentId).toBeNull();
  });
  it('steps through siblings, drills into children and returns through Up without editing the document', () => {
    const document = board(navigation),
      before = JSON.stringify(document);
    const onNavigate = vi.fn(),
      onOverview = vi.fn();
    render(
      <CanvasNavigationPanel
        document={document}
        onNavigate={onNavigate}
        onOverview={onOverview}
      />
    );
    fireEvent.click(screen.getByRole('button', { name: 'Next screen' }));
    expect(onNavigate).toHaveBeenLastCalledWith('files');
    fireEvent.click(screen.getByRole('button', { name: 'Next screen' }));
    expect(onNavigate).toHaveBeenLastCalledWith('agent');
    expect(
      (screen.getByRole('button', { name: 'Next screen' }) as HTMLButtonElement)
        .disabled
    ).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Previous screen' }));
    fireEvent.change(
      screen.getByRole('combobox', { name: 'Explore child view' }),
      { target: { value: 'editor' } }
    );
    expect(onNavigate).toHaveBeenLastCalledWith('editor');
    fireEvent.click(screen.getByRole('button', { name: 'Next screen' }));
    expect(onNavigate).toHaveBeenLastCalledWith('tree');
    fireEvent.click(screen.getByRole('button', { name: 'Up' }));
    expect(onNavigate).toHaveBeenLastCalledWith('files');
    fireEvent.click(screen.getByRole('button', { name: 'Up' }));
    expect(onOverview).toHaveBeenCalledOnce();
    expect(JSON.stringify(document)).toBe(before);
  });
  it('recovers when the current screen is removed and keeps controls out of boards without a manifest', () => {
    const onNavigate = vi.fn(),
      onOverview = vi.fn();
    const { rerender } = render(
      <CanvasNavigationPanel
        document={board(navigation)}
        onNavigate={onNavigate}
        onOverview={onOverview}
      />
    );
    fireEvent.change(screen.getByRole('combobox'), {
      target: { value: 'editor' },
    });
    const next = board(navigation);
    next.nodes = next.nodes?.filter((node) => node.id !== 'editor');
    rerender(
      <CanvasNavigationPanel
        document={next}
        onNavigate={onNavigate}
        onOverview={onOverview}
      />
    );
    expect((screen.getByRole('combobox') as HTMLSelectElement).value).toBe('');
    fireEvent.click(screen.getByRole('button', { name: 'Next screen' }));
    expect(onNavigate).toHaveBeenLastCalledWith('files');
    rerender(
      <CanvasNavigationPanel
        document={board(undefined)}
        onNavigate={onNavigate}
        onOverview={onOverview}
      />
    );
    expect(screen.queryByRole('navigation')).toBeNull();
  });
  it('does not bubble navigation keystrokes to board shortcuts', () => {
    const onKeyDown = vi.fn();
    render(
      <div onKeyDown={onKeyDown}>
        <CanvasNavigationPanel
          document={board(navigation)}
          onNavigate={vi.fn()}
          onOverview={vi.fn()}
        />
      </div>
    );
    fireEvent.keyDown(screen.getByRole('combobox'), { key: 'ArrowDown' });
    expect(onKeyDown).not.toHaveBeenCalled();
  });
});

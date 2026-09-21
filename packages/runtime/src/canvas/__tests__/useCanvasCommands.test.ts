/**
 * Two claims that no amount of looking at the board would reveal.
 *
 * **Escape stops at the first step that did something.** The chain is
 * deactivate card, cancel drag, clear selection, return to select, close panel
 * (complication 6). A version that runs every step looks identical in a
 * screenshot and quietly throws away the user's selection on the Escape they
 * pressed to close a comment composer.
 *
 * **An arrange is one write.** `alignNodes` returns a patch per card and the
 * runner folds them into a single document, because `applyLocalDocument` wraps
 * one document diff in one `Y.Doc.transact` -- so six cards aligning is one
 * transaction and one Cmd+Z. Committing per patch would undo an arrangement one
 * card at a time, which is the bug this asserts against.
 */
import { renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import type { CanvasAnyNode, CanvasDocument } from '../CanvasDocument';
import type { CanvasCommandContext } from '../canvasCommands';
import type { CanvasKeyEvent } from '../canvasKeymap';
import {
  expandCanvasGroupSelection,
  resolveCanvasCommand,
  runCanvasEscape,
  useCanvasCommands,
  type CanvasCommandDeps,
} from '../useCanvasCommands';

describe('runCanvasEscape', () => {
  it('stops at the first step that reports it did something', () => {
    const calls: string[] = [];
    const step = (name: string, did: boolean) => () => {
      calls.push(name);
      return did;
    };
    const handled = runCanvasEscape({
      deactivateCard: step('card', false),
      cancelDrag: step('drag', false),
      clearSelection: step('selection', true),
      returnToSelectTool: step('tool', true),
      closePanel: step('panel', true),
    });
    expect(handled).toBe(true);
    expect(calls).toEqual(['card', 'drag', 'selection']);
  });

  it('reports that nothing happened when no step applied', () => {
    const never = () => false;
    expect(
      runCanvasEscape({
        deactivateCard: never,
        cancelDrag: never,
        clearSelection: never,
        returnToSelectTool: never,
        closePanel: never,
      })
    ).toBe(false);
  });
});

function board(): CanvasDocument {
  return {
    nodes: [
      { id: 'a', type: 'text', text: 'a', x: 0, y: 0, width: 100, height: 60 },
      {
        id: 'b',
        type: 'text',
        text: 'b',
        x: 200,
        y: 40,
        width: 100,
        height: 60,
      },
      {
        id: 'c',
        type: 'text',
        text: 'c',
        x: 400,
        y: 80,
        width: 100,
        height: 60,
      },
    ],
    edges: [],
  } as unknown as CanvasDocument;
}

function deps(
  document: CanvasDocument,
  commit: (next: CanvasDocument) => void
): CanvasCommandDeps {
  const noop = () => {};
  return {
    documentRef: { current: document },
    document,
    selectedIds: new Set(['a', 'b', 'c']),
    setSelectedIds: noop,
    readOnly: false,
    activeNodeId: null,
    tool: 'select',
    setTool: noop,
    commit,
    camera: {
      fitAll: noop,
      fitSelection: noop,
      zoomIn: noop,
      zoomOut: noop,
      zoomTo: noop,
      savedView: noop,
    },
    addCard: noop,
    togglePanelPref: noop,
    escape: {
      deactivateCard: () => false,
      cancelDrag: () => false,
      clearSelection: () => false,
      returnToSelectTool: () => false,
      closePanel: () => false,
    },
  };
}

describe('useCanvasCommands', () => {
  it('applies an align batch as a single commit', () => {
    const document = board();
    const commit = vi.fn();
    const { result } = renderHook(() =>
      useCanvasCommands(deps(document, commit))
    );

    result.current.run('align-top');

    expect(commit).toHaveBeenCalledTimes(1);
    const next = commit.mock.calls[0][0] as CanvasDocument;
    expect((next.nodes ?? []).map((node) => node.y)).toEqual([0, 0, 0]);
    // The x values are untouched, so this really is one align and not a move.
    expect((next.nodes ?? []).map((node) => node.x)).toEqual([0, 200, 400]);
  });

  it('leaves a locked card where it is', () => {
    const document = board();
    (document.nodes ?? [])[1]['x-nimbalyst'] = { locked: true };
    const commit = vi.fn();
    const { result } = renderHook(() =>
      useCanvasCommands(deps(document, commit))
    );

    result.current.run('align-top');

    const next = commit.mock.calls[0][0] as CanvasDocument;
    expect((next.nodes ?? []).map((node) => node.y)).toEqual([0, 40, 0]);
  });

  it('refuses every editing command on a read-only board', () => {
    const commit = vi.fn();
    const { result } = renderHook(() =>
      useCanvasCommands({ ...deps(board(), commit), readOnly: true })
    );

    result.current.run('align-top');
    result.current.run('delete');
    result.current.run('duplicate');

    expect(commit).not.toHaveBeenCalled();
  });
});

/** A board with a frame, a card inside it, and one card outside. */
function framedBoard(): CanvasDocument {
  return {
    nodes: [
      {
        id: 'frame',
        type: 'group',
        x: 0,
        y: 0,
        width: 400,
        height: 300,
        label: 'Inbox',
      },
      { id: 'inside', type: 'text', text: 'in', x: 20, y: 20, width: 100, height: 60 },
      { id: 'outside', type: 'text', text: 'out', x: 600, y: 0, width: 100, height: 60 },
    ],
    edges: [{ id: 'e1', fromNode: 'inside', toNode: 'outside' }],
  } as unknown as CanvasDocument;
}

describe('expandCanvasGroupSelection', () => {
  it('pulls in the rest of a group when one member is selected', () => {
    const nodes = [
      { id: 'a', 'x-nimbalyst': { group: 'g1' } },
      { id: 'b', 'x-nimbalyst': { group: 'g1' } },
      { id: 'c', 'x-nimbalyst': { group: 'g2' } },
      { id: 'd' },
    ] as unknown as CanvasDocument['nodes'];

    expect([...expandCanvasGroupSelection(new Set(['a']), nodes ?? [])].sort())
      .toEqual(['a', 'b']);
  });

  it('returns the same set when nothing is grouped', () => {
    const selected = new Set(['d']);
    const nodes = [{ id: 'd' }] as unknown as CanvasDocument['nodes'];
    expect(expandCanvasGroupSelection(selected, nodes ?? [])).toBe(selected);
  });
});

describe('frames carry their contents', () => {
  it('nudges the cards inside a selected frame', () => {
    const document = framedBoard();
    const commit = vi.fn();
    const { result } = renderHook(() =>
      useCanvasCommands({
        ...deps(document, commit),
        selectedIds: new Set(['frame']),
      })
    );

    result.current.run('nudge-right-10');

    expect(commit).toHaveBeenCalledTimes(1);
    const next = commit.mock.calls[0][0] as CanvasDocument;
    const byId = new Map((next.nodes ?? []).map((node) => [node.id, node]));
    expect(byId.get('frame')?.x).toBe(10);
    expect(byId.get('inside')?.x).toBe(30);
    // The card outside the frame was never part of the gesture.
    expect(byId.get('outside')?.x).toBe(600);
  });

  it('duplicates the cards inside a selected frame', () => {
    const document = framedBoard();
    const commit = vi.fn();
    const { result } = renderHook(() =>
      useCanvasCommands({
        ...deps(document, commit),
        selectedIds: new Set(['frame']),
      })
    );

    result.current.run('duplicate');

    const next = commit.mock.calls[0][0] as CanvasDocument;
    expect((next.nodes ?? []).length).toBe(5);
    expect(
      (next.nodes ?? []).filter((node) => node.type === 'group').length
    ).toBe(2);
  });
});

describe('delete', () => {
  it('removes a selected edge as well as selected cards', () => {
    const document = framedBoard();
    const commit = vi.fn();
    const { result } = renderHook(() =>
      useCanvasCommands({
        ...deps(document, commit),
        selectedIds: new Set(['outside', 'e1']),
      })
    );

    result.current.run('delete');

    expect(commit).toHaveBeenCalledTimes(1);
    const next = commit.mock.calls[0][0] as CanvasDocument;
    expect((next.nodes ?? []).map((node) => node.id)).toEqual([
      'frame',
      'inside',
    ]);
    expect(next.edges ?? []).toEqual([]);
  });

  it('removes a selected edge when no card is selected', () => {
    const document = framedBoard();
    const commit = vi.fn();
    const { result } = renderHook(() =>
      useCanvasCommands({
        ...deps(document, commit),
        selectedIds: new Set(['e1']),
      })
    );

    result.current.run('delete');

    const next = commit.mock.calls[0][0] as CanvasDocument;
    expect((next.nodes ?? []).length).toBe(3);
    expect(next.edges ?? []).toEqual([]);
  });
});

/**
 * The two keys the registry's `enabled` rules would otherwise swallow. Both are
 * resolved by re-asking `canvasKeymap` with a probe selection, so the guards
 * that matter -- a hot card, a focused textarea, Alt -- stay where they are.
 */
describe('resolveCanvasCommand', () => {
  const nodes = (framedBoard().nodes ?? []) as readonly CanvasAnyNode[];

  const ctx = (over: Partial<CanvasCommandContext> = {}): CanvasCommandContext => ({
    nodes,
    selection: [],
    readOnly: false,
    activeCardId: null,
    tool: 'select',
    ...over,
  });

  const key = (over: Partial<CanvasKeyEvent>): CanvasKeyEvent => ({
    key: '',
    code: '',
    metaKey: false,
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    ...over,
  });

  const shiftTwo = key({ key: '2', code: 'Digit2', shiftKey: true });

  it('falls back from an empty fit-selection to fit-all', () => {
    expect(resolveCanvasCommand(shiftTwo, ctx(), 0)).toBe('fit-all');
  });

  it('still fits the selection when there is one', () => {
    expect(
      resolveCanvasCommand(shiftTwo, ctx({ selection: [nodes[2]] }), 0)
    ).toBe('fit-selection');
  });

  it('deletes a selected edge with nothing else selected', () => {
    expect(resolveCanvasCommand(key({ key: 'Backspace' }), ctx(), 1)).toBe(
      'delete'
    );
    expect(resolveCanvasCommand(key({ key: 'Backspace' }), ctx(), 0)).toBe(null);
  });

  it('leaves an active card\'s keyboard alone', () => {
    expect(
      resolveCanvasCommand(shiftTwo, ctx({ activeCardId: 'inside' }), 0)
    ).toBe(null);
  });
});

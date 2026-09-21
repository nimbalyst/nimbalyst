/**
 * The context menu's two shapes, and the rule that keeps them short.
 *
 * The menu is generated from the command registry, so the interesting claim is
 * that a command whose `enabled` predicate says no is *absent* rather than
 * greyed -- "Group" on a single card is the case that catches a regression back
 * to a hand-written item list. The clipboard items are the other half: nothing
 * in the canvas implements copy or paste yet, so the menu must not advertise
 * them until a host passes the callbacks -- and for Cut and Paste, which
 * mutate, the callbacks existing is not the same as the board being writable.
 */
import type { ComponentProps } from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { CanvasContextMenu } from '../CanvasContextMenu';
import type { CanvasCommandContext } from '../canvasCommands';
import type { CanvasAnyNode } from '../CanvasDocument';

function node(id: string): CanvasAnyNode {
  return {
    id,
    type: 'text',
    text: id,
    x: 0,
    y: 0,
    width: 100,
    height: 80,
  } as CanvasAnyNode;
}

function renderMenu(
  kind: 'selection' | 'canvas',
  selection: CanvasAnyNode[],
  extra: Partial<ComponentProps<typeof CanvasContextMenu>> = {},
  ctxOverrides: Partial<CanvasCommandContext> = {}
) {
  const ctx: CanvasCommandContext = {
    selection,
    nodes: selection.length > 0 ? selection : [node('z')],
    readOnly: false,
    activeCardId: null,
    tool: 'select',
    ...ctxOverrides,
  };
  return render(
    <CanvasContextMenu
      anchor={{ x: 120, y: 80 }}
      kind={kind}
      ctx={ctx}
      run={vi.fn()}
      onClose={vi.fn()}
      onAddSticky={vi.fn()}
      onAddComment={vi.fn()}
      {...extra}
    />
  );
}

describe('CanvasContextMenu', () => {
  it('opens the recorded screenshot source even on a read-only board', async () => {
    const screenshot = { ...node('shot'), 'x-nimbalyst': { screen: { sourcePath: 'captures/settings.png' } } };
    const onOpenScreenshot = vi.fn();
    const onClose = vi.fn();
    renderMenu('selection', [screenshot], { onOpenScreenshot, onClose }, { readOnly: true });
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Open original screenshot' }));
    expect(onOpenScreenshot).toHaveBeenCalledWith('captures/settings.png');
    expect(onClose).toHaveBeenCalledOnce();
  });
  it('does not offer a screenshot source without provenance or for a mixed selection', () => {
    const shot = { ...node('shot'), 'x-nimbalyst': { screen: { sourcePath: 'captures/settings.png' } } };
    const { unmount } = renderMenu('selection', [node('plain')], { onOpenScreenshot: vi.fn() });
    expect(screen.queryByRole('menuitem', { name: 'Open original screenshot' })).toBeNull();
    unmount();
    renderMenu('selection', [shot, node('plain')], { onOpenScreenshot: vi.fn() });
    expect(screen.queryByRole('menuitem', { name: 'Open original screenshot' })).toBeNull();
  });
  it('renders nothing without an anchor', () => {
    const { container } = render(
      <CanvasContextMenu
        anchor={null}
        kind="canvas"
        ctx={{
          selection: [],
          nodes: [],
          readOnly: false,
          activeCardId: null,
          tool: 'select',
        }}
        run={vi.fn()}
        onClose={vi.fn()}
        onAddSticky={vi.fn()}
        onAddComment={vi.fn()}
      />
    );
    expect(container.querySelector('.canvas-context-menu')).toBeNull();
  });

  it('offers the selection shape over cards', () => {
    renderMenu('selection', [node('a'), node('b')]);
    screen.getByRole('menuitem', { name: /Duplicate/ });
    screen.getByRole('menuitem', { name: /^Group/ });
    screen.getByRole('menuitem', { name: /Align/ });
    screen.getByRole('menuitem', { name: /Bring to front/ });
    screen.getByRole('menuitem', { name: /Delete/ });
    expect(screen.queryByRole('menuitem', { name: /Add sticky/ })).toBeNull();
  });

  it('offers the canvas shape over empty board', () => {
    renderMenu('canvas', []);
    screen.getByRole('menuitem', { name: /Add sticky/ });
    screen.getByRole('menuitem', { name: /Add comment/ });
    screen.getByRole('menuitem', { name: /Select all/ });
    screen.getByRole('menuitem', { name: /Fit all/ });
    expect(screen.queryByRole('menuitem', { name: /Duplicate/ })).toBeNull();
  });

  it('omits a command the registry disables and clipboard the host cannot do', () => {
    renderMenu('selection', [node('a')]);
    // Group needs two cards; Distribute needs three.
    expect(screen.queryByRole('menuitem', { name: /^Group/ })).toBeNull();
    expect(screen.queryByRole('menuitem', { name: /Distribute/ })).toBeNull();
    expect(screen.queryByRole('menuitem', { name: /^Copy/ })).toBeNull();
    expect(screen.queryByRole('menuitem', { name: /^Cut/ })).toBeNull();
  });

  it('shows clipboard items once the host passes the callbacks', () => {
    renderMenu('selection', [node('a')], {
      onCopy: vi.fn(),
      onCut: vi.fn(),
    });
    screen.getByRole('menuitem', { name: /^Copy/ });
    screen.getByRole('menuitem', { name: /^Cut/ });
  });

  // A host that supplies the clipboard callbacks once keeps supplying them
  // after the board turns read-only; the callbacks alone are not permission.
  // Copy reads, so it stays; Cut and Paste mutate, so they must not.
  it('drops the mutating clipboard items on a read-only board', () => {
    renderMenu(
      'selection',
      [node('a')],
      { onCopy: vi.fn(), onCut: vi.fn() },
      { readOnly: true }
    );
    screen.getByRole('menuitem', { name: /^Copy/ });
    expect(screen.queryByRole('menuitem', { name: /^Cut/ })).toBeNull();
  });

  it('drops Paste, Add sticky and Add comment on a read-only board', () => {
    renderMenu('canvas', [], { onPaste: vi.fn() }, { readOnly: true });
    expect(screen.queryByRole('menuitem', { name: /^Paste/ })).toBeNull();
    expect(screen.queryByRole('menuitem', { name: /Add sticky/ })).toBeNull();
    expect(screen.queryByRole('menuitem', { name: /Add comment/ })).toBeNull();
    // Read-only still gets the two navigation commands.
    screen.getByRole('menuitem', { name: /Select all/ });
  });

  // Same rule as the selection bar: a menu that opens without moving focus
  // cannot be driven from the keyboard at all.
  it('moves focus to the first item on open and walks it with ArrowDown', async () => {
    renderMenu('canvas', []);
    const items = screen.getAllByRole('menuitem');
    expect(items[0].textContent).toContain('Add sticky');
    await waitFor(() => expect(document.activeElement).toBe(items[0]));

    fireEvent.keyDown(items[0], { key: 'ArrowDown' });
    await waitFor(() => expect(document.activeElement).toBe(items[1]));
  });

  // ArrowDown must walk the root list even when it lands on a submenu row.
  // floating-ui's `nested` mode decides which key opens a submenu from the
  // *parent's* orientation, and with no orientation to read it accepts both
  // axes -- so ArrowDown on "Align" opened the submenu instead of moving on.
  it('walks past a submenu row with ArrowDown instead of opening it', async () => {
    renderMenu('selection', [node('a'), node('b')]);

    const align = screen.getByRole('menuitem', { name: /^Align/ });
    await waitFor(() => expect(document.activeElement).not.toBe(document.body));

    // Walk down until Align has focus, then once more.
    for (let step = 0; step < 8 && document.activeElement !== align; step += 1) {
      fireEvent.keyDown(document.activeElement as HTMLElement, {
        key: 'ArrowDown',
      });
      await waitFor(() => expect(document.activeElement).not.toBeNull());
    }
    expect(document.activeElement).toBe(align);

    fireEvent.keyDown(align, { key: 'ArrowDown' });

    await waitFor(() =>
      expect(document.activeElement).toBe(
        screen.getByRole('menuitem', { name: /^Tidy/ })
      )
    );
    expect(align.getAttribute('aria-expanded')).toBe('false');
    expect(
      screen.queryAllByRole('menuitem').filter((i) => i.textContent === 'Left')
    ).toHaveLength(0);
  });

  it('returns focus to the submenu trigger when Escape closes it', async () => {
    renderMenu('selection', [node('a'), node('b')]);
    const align = screen.getByRole('menuitem', { name: /^Align/ });
    fireEvent.click(align);

    await waitFor(() =>
      expect(
        screen.getAllByRole('menuitem').filter((i) => i.textContent === 'Left')
      ).toHaveLength(1)
    );

    fireEvent.keyDown(document.activeElement as HTMLElement, { key: 'Escape' });

    await waitFor(() => expect(document.activeElement).toBe(align));
    expect(
      screen.queryAllByRole('menuitem').filter((i) => i.textContent === 'Left')
    ).toHaveLength(0);
  });

  it('opens a submenu and lands focus on its first item', async () => {
    renderMenu('selection', [node('a'), node('b')]);
    fireEvent.click(screen.getByRole('menuitem', { name: /^Align/ }));

    await waitFor(() => {
      const submenuItems = screen
        .getAllByRole('menuitem')
        .filter((item) => item.textContent === 'Left');
      expect(submenuItems).toHaveLength(1);
      expect(document.activeElement).toBe(submenuItems[0]);
    });
  });
});

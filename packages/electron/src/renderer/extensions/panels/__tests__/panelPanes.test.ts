// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { addPanelPaneToggleHandler, getPanelPanes, setPanelPanes, togglePanelPane } from '../panelPanes';

describe('panelPanes', () => {
  it('relays only declared panes, so an undeclared toggle falls back to the host default', () => {
    const handler = vi.fn();
    const unsubscribe = addPanelPaneToggleHandler('ext.a', handler);
    setPanelPanes('ext.a', { left: { label: 'Roster', collapsed: false } });

    expect(togglePanelPane('ext.a', 'left')).toBe(true);
    expect(handler).toHaveBeenCalledWith('left');
    // No right pane declared: the gutter/shortcut must keep its old behavior.
    expect(togglePanelPane('ext.a', 'right')).toBe(false);
    expect(togglePanelPane('ext.other', 'left')).toBe(false);
    unsubscribe();
  });

  it('keeps a declaration dormant until a handler exists, and drops it with the last handler', () => {
    setPanelPanes('ext.b', { left: { label: 'Roster', collapsed: true } });
    expect(getPanelPanes('ext.b')).toBeUndefined();
    expect(togglePanelPane('ext.b', 'left')).toBe(false);

    const first = addPanelPaneToggleHandler('ext.b', vi.fn());
    const second = addPanelPaneToggleHandler('ext.b', vi.fn());
    expect(getPanelPanes('ext.b')?.left?.collapsed).toBe(true);

    first();
    expect(getPanelPanes('ext.b')).toBeDefined();
    second();
    // An unmounted panel must not leave title-bar buttons behind, even after re-subscribing.
    addPanelPaneToggleHandler('ext.b', vi.fn());
    expect(getPanelPanes('ext.b')).toBeUndefined();
  });
});

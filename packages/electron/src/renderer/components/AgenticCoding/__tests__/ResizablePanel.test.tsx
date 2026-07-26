// @vitest-environment jsdom
import React from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { ResizablePanel } from '../ResizablePanel';

afterEach(() => cleanup());

const noop = () => {};

function renderPanel(props: Partial<React.ComponentProps<typeof ResizablePanel>> = {}) {
  return render(
    <ResizablePanel
      leftPanel={<div data-testid="left-panel">left</div>}
      rightPanel={<div data-testid="right-panel">right</div>}
      leftWidth={200}
      onWidthChange={noop}
      {...props}
    />
  );
}

describe('ResizablePanel', () => {
  it('renders the left panel and resize divider when expanded', () => {
    renderPanel();
    expect(screen.queryByTestId('left-panel')).not.toBeNull();
    expect(screen.queryByTestId('agent-history-resize-handle')).not.toBeNull();
  });

  it('unmounts the left panel when collapsed (default)', () => {
    renderPanel({ collapsed: true });
    expect(screen.queryByTestId('left-panel')).toBeNull();
    expect(screen.queryByTestId('agent-history-resize-handle')).toBeNull();
  });

  it('keeps the left panel mounted at width 0 when collapsed with keepLeftMounted', () => {
    // Regression: the "+ New" launcher is portaled from the sidebar into the
    // window chrome, so the sidebar must stay mounted through a collapse or the
    // launcher disappears. It is hidden (width 0), and the resize divider goes.
    renderPanel({ collapsed: true, keepLeftMounted: true });
    const left = screen.queryByTestId('left-panel');
    expect(left).not.toBeNull();
    expect(screen.queryByTestId('agent-history-resize-handle')).toBeNull();
    const container = left!.closest('.resizable-panel-left') as HTMLElement;
    expect(container.style.width).toBe('0px');
  });
});

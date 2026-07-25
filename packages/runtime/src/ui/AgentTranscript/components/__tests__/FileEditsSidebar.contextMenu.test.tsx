import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { FileEditsSidebar } from '../FileEditsSidebar';
import type { FileEditSummary } from '../../types';

const fileEdits: FileEditSummary[] = [
  {
    filePath: '/workspace/src/app.ts',
    linkType: 'edited',
    linesAdded: 3,
    linesRemoved: 1,
    operation: 'edit',
  } as FileEditSummary,
];

function renderSidebar() {
  return render(
    <FileEditsSidebar
      fileEdits={fileEdits}
      workspacePath="/workspace"
      onCopyPath={vi.fn()}
      onRevealInFinder={vi.fn()}
    />
  );
}

describe('FileEditsSidebar context menu positioning', () => {
  it('renders the context menu in a portal outside the sidebar so it escapes overflow containers', () => {
    const { container } = renderSidebar();

    fireEvent.contextMenu(screen.getByText('app.ts'), { clientX: 120, clientY: 200 });

    const menu = document.querySelector('.file-edits-sidebar__context-menu');
    expect(menu).not.toBeNull();
    // FloatingPortal renders to document.body, not inside the sidebar subtree.
    expect(container.contains(menu!)).toBe(false);

    cleanup();
  });

  it('positions via floating-ui instead of hardcoding the cursor coordinates', () => {
    renderSidebar();

    // A cursor position far past the right/bottom edge would previously render the
    // menu at left: 5000px / top: 4000px and push it off screen.
    fireEvent.contextMenu(screen.getByText('app.ts'), { clientX: 5000, clientY: 4000 });

    const menu = document.querySelector('.file-edits-sidebar__context-menu') as HTMLElement;
    expect(menu).not.toBeNull();
    expect(menu.style.left).not.toBe('5000px');
    expect(menu.style.top).not.toBe('4000px');
    // floating-ui drives placement through its own positioning strategy.
    expect(menu.style.position).toBe('absolute');

    cleanup();
  });
});

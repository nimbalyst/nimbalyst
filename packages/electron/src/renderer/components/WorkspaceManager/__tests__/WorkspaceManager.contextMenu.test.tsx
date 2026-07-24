// @vitest-environment jsdom
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

const recentWorkspaces = [
  { path: '/projects/alpha', name: 'alpha', lastOpened: 1700000000000, exists: true, markdownCount: 2 },
];

(window as unknown as { electronAPI: unknown }).electronAPI = {
  getResolvedThemeSync: () => 'dark',
  onThemeChange: vi.fn(),
  workspaceManager: {
    getRecentWorkspaces: vi.fn().mockResolvedValue(recentWorkspaces),
    getWorkspaceStats: vi.fn().mockResolvedValue({ fileCount: 1, markdownCount: 1, totalSize: 10, recentFiles: [] }),
    openWorkspace: vi.fn(),
  },
};

const { WorkspaceManager } = await import('../WorkspaceManager');

afterEach(() => cleanup());

// Locate the menu by its contents rather than by class, so the assertions below
// exercise positioning rather than the marker class name.
async function openContextMenuAt(clientX: number, clientY: number) {
  const { container } = render(<WorkspaceManager />);
  const row = await screen.findByText('alpha');
  fireEvent.contextMenu(row, { clientX, clientY });
  const openProject = await screen.findByText('Open Project');
  return { menu: openProject.closest('div[style]') as HTMLElement, container };
}

describe('WorkspaceManager context menu positioning', () => {
  it('renders the context menu in a portal so it escapes overflow containers', async () => {
    const { menu, container } = await openContextMenuAt(120, 200);
    // FloatingPortal renders to document.body rather than inline in the picker.
    expect(container.contains(menu)).toBe(false);
  });

  it('positions via floating-ui instead of hardcoding the cursor coordinates', async () => {
    // A cursor near the bottom-right previously rendered the menu at
    // left: 5000px / top: 4000px and pushed it off screen.
    const { menu } = await openContextMenuAt(5000, 4000);
    expect(menu.style.left).not.toBe('5000px');
    expect(menu.style.top).not.toBe('4000px');
    expect(menu.style.position).toBe('absolute');
  });
});

// @vitest-environment jsdom
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

/**
 * #1376: the workspace scan stops at a file/depth budget, so its counts are
 * lower bounds. The main process now sends `"N+"` for a truncated markdown
 * count exactly as it always has for `fileCount`. These tests cover the half
 * the pure tests cannot: that the suffixed value survives the trip to the
 * screen instead of being coerced, rounded, or dropped.
 */

const truncated = {
  path: '/projects/big',
  name: 'big',
  lastOpened: 1700000000000,
  exists: true,
  fileCount: '1000+',
  markdownCount: '16+',
};

const complete = {
  path: '/projects/small',
  name: 'small',
  lastOpened: 1700000000000,
  exists: true,
  fileCount: 42,
  markdownCount: 7,
};

const getWorkspaceStats = vi.fn();

(window as unknown as { electronAPI: unknown }).electronAPI = {
  getResolvedThemeSync: () => 'dark',
  onThemeChange: vi.fn(),
  workspaceManager: {
    getRecentWorkspaces: vi.fn().mockResolvedValue([truncated, complete]),
    getWorkspaceStats,
    openWorkspace: vi.fn(),
  },
  tutorial: {
    getStatus: vi.fn().mockResolvedValue({ success: true, exists: false }),
    start: vi.fn(),
  },
};

const { WorkspaceManager } = await import('../WorkspaceManager');

afterEach(() => cleanup());

describe('workspace card markdown count (#1376)', () => {
  it('shows a truncated count as a lower bound, not as an exact total', async () => {
    render(<WorkspaceManager />);
    expect(await screen.findByText('16+ markdown files')).toBeTruthy();
  });

  /**
   * The control that must go the other way: an implementation that always
   * appended "+" would pass the assertion above while lying about every
   * complete scan. A finished count must still render bare.
   */
  it('shows a completed count with no suffix', async () => {
    render(<WorkspaceManager />);
    expect(await screen.findByText('7 markdown files')).toBeTruthy();
    expect(screen.queryByText('7+ markdown files')).toBeNull();
  });

  it('does not render the truncated count as "16"', async () => {
    // The pre-fix symptom, stated as the thing that must no longer appear.
    render(<WorkspaceManager />);
    await screen.findByText('16+ markdown files');
    expect(screen.queryByText('16 markdown files')).toBeNull();
  });
});

describe('workspace stats panel counts (#1376)', () => {
  it('carries both suffixed counts into the stats cards', async () => {
    getWorkspaceStats.mockResolvedValue({
      fileCount: '10000+',
      markdownCount: '16+',
      totalSize: 1024,
      recentFiles: [],
    });

    render(<WorkspaceManager />);
    fireEvent.click(await screen.findByText('big'));

    // Labelled cards, so the assertion cannot pass on a stray match elsewhere.
    const markdownCard = (await screen.findByText('Markdown Files')).parentElement;
    expect(markdownCard?.textContent).toContain('16+');

    const filesCard = (await screen.findByText('Total Files')).parentElement;
    expect(filesCard?.textContent).toContain('10000+');
  });

  it('leaves a completed scan unsuffixed in the stats cards', async () => {
    getWorkspaceStats.mockResolvedValue({
      fileCount: 42,
      markdownCount: 7,
      totalSize: 1024,
      recentFiles: [],
    });

    render(<WorkspaceManager />);
    fireEvent.click(await screen.findByText('small'));

    const markdownCard = (await screen.findByText('Markdown Files')).parentElement;
    expect(markdownCard?.textContent).toContain('7');
    expect(markdownCard?.textContent).not.toContain('+');
  });
});

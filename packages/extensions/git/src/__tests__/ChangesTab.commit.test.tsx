import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi, beforeEach } from 'vitest';

// ChangesTab reads `window.electronAPI` at module scope, so the stub has to exist
// before the import is evaluated.
const invoke = vi.hoisted(() => {
  const fn = vi.fn();
  (window as unknown as { electronAPI: unknown }).electronAPI = { invoke: fn };
  return fn;
});

import { ChangesTab } from '../components/ChangesTab';

const WORKSPACE = '/repo';

function renderTab() {
  return render(
    <ChangesTab
      workspacePath={WORKSPACE}
      withLog={(_command, operation) => operation()}
      onWorkspaceEvent={() => () => {}}
      onShowOutput={() => {}}
      fileMaskEnabled={false}
      fileMaskInput=""
    />,
  );
}

describe('ChangesTab commit', () => {
  beforeEach(() => {
    invoke.mockReset();
    invoke.mockImplementation((channel: string) => {
      if (channel === 'git:working-changes') {
        return Promise.resolve({
          // `staged.ts` is already in the repository's real index but is not selected
          // below -- the commit must not include it.
          staged: [{ path: 'src/staged.ts', status: 'M' }],
          unstaged: [{ path: 'src/picked.ts', status: 'M' }],
          untracked: [],
          conflicted: [],
        });
      }
      if (channel === 'git:commit') return Promise.resolve({ success: true, commitHash: 'abc1234' });
      return Promise.resolve(null);
    });
  });

  // Focus/peek/pin point at a path, not an index, so collapsing the directory
  // that contains the focused row used to leave keyboard actions targeting a row
  // that is no longer on screen.
  it('drops the active row when its directory is collapsed', async () => {
    const { container } = renderTab();

    const row = await screen.findByText('picked.ts');
    fireEvent.click(row);
    expect(container.querySelector('.git-changes-file-row--focused')).not.toBeNull();

    fireEvent.click(screen.getByRole('button', { name: /^Collapse src\// }));

    expect(screen.queryByText('picked.ts')).toBeNull();
    expect(container.querySelector('.git-changes-file-row--focused')).toBeNull();
  });

  it('commits exactly the selected paths, not the repository index', async () => {
    renderTab();

    const picked = await screen.findByRole('checkbox', { name: 'src/picked.ts' });
    fireEvent.click(picked);

    fireEvent.change(screen.getByPlaceholderText('Summary (required)'), {
      target: { value: 'fix: something' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Commit (1)' }));

    await waitFor(() => {
      expect(invoke).toHaveBeenCalledWith('git:commit', WORKSPACE, 'fix: something', ['src/picked.ts']);
    });
  });

  it('sends the selection to a new session when committing with AI', async () => {
    const listener = vi.fn();
    window.addEventListener('nimbalyst:commit-with-ai', listener);

    renderTab();
    fireEvent.click(await screen.findByRole('checkbox', { name: 'src/picked.ts' }));
    fireEvent.click(screen.getByRole('button', { name: /Commit with AI/ }));

    window.removeEventListener('nimbalyst:commit-with-ai', listener);
    expect((listener.mock.calls[0][0] as CustomEvent).detail).toEqual({
      workspacePath: WORKSPACE,
      files: [{ path: 'src/picked.ts', status: 'M' }],
    });
  });
});

import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, cleanup } from '@testing-library/react';
import { ClaudeRuntimeStatus } from '../ClaudeRuntimeStatus';
afterEach(cleanup);

describe('#1476 effective runtime card', () => {
  it('reads the scoped effective path, refreshes after a save, and omits the bundled version for custom executables', async () => {
    const invoke = vi.fn().mockResolvedValue({ success: true, settings: { customClaudeCodePath: '/global/claude' } });
    Object.defineProperty(window, 'electronAPI', { configurable: true, value: { invoke } });
    const view = render(<ClaudeRuntimeStatus scope="user" revision={0} />);
    await screen.findByText('/global/claude');
    expect(invoke).toHaveBeenLastCalledWith('ai:getEffectiveSettings', undefined);
    expect(screen.queryByText(/Agent SDK version:/)).toBeNull();
    invoke.mockResolvedValue({ success: true, settings: { customClaudeCodePath: '/project/wrapper' } });
    view.rerender(<ClaudeRuntimeStatus scope="project" workspacePath="/project" revision={0} />);
    await screen.findByText('/project/wrapper');
    expect(invoke).toHaveBeenLastCalledWith('ai:getEffectiveSettings', '/project');
    invoke.mockResolvedValue({ success: true, settings: { customClaudeCodePath: '' } });
    view.rerender(<ClaudeRuntimeStatus scope="project" workspacePath="/project" revision={1} />);
    await screen.findByText(/Agent SDK version:/);
    expect(screen.queryByText('/project/wrapper')).toBeNull();
    expect(invoke.mock.calls.every(([channel]) => channel === 'ai:getEffectiveSettings')).toBe(true);
  });
  it('does not present a failed settings lookup as a bundled runtime', async () => {
    Object.defineProperty(window, 'electronAPI', { configurable: true, value: { invoke: vi.fn().mockRejectedValue(new Error('Unavailable')) } });
    render(<ClaudeRuntimeStatus scope="user" revision={0} />);
    await waitFor(() => expect(screen.getByRole('alert').textContent).toBe('Unavailable'));
    expect(screen.queryByText(/bundled runtime/)).toBeNull();
  });
});

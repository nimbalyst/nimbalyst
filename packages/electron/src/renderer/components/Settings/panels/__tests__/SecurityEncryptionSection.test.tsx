// @vitest-environment jsdom
import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { SecurityEncryptionSection } from '../SecurityEncryptionSection';

vi.mock('@nimbalyst/runtime/ui/icons/MaterialSymbol', () => ({ MaterialSymbol: () => null }));
const getKeyCustodyStatus = vi.fn();
beforeEach(() => {
  getKeyCustodyStatus.mockReset();
  Object.assign(window, { electronAPI: { team: { getKeyCustodyStatus } } });
});
afterEach(cleanup);

it('does not turn failed status into migration advice', async () => {
  getKeyCustodyStatus.mockResolvedValue({ success: false, error: 'Key status unavailable' });
  render(<SecurityEncryptionSection orgId="org-a" />);
  await screen.findByText('Encryption status is unavailable right now.');
  expect(screen.queryByText('This organization uses retired encryption')).toBeNull();
});

it('does not apply a previous organization response after selection changes', async () => {
  let resolveOld!: (value: unknown) => void;
  getKeyCustodyStatus.mockImplementation((org: string) => org === 'org-a'
    ? new Promise(resolve => { resolveOld = resolve; })
    : Promise.resolve({ success: true, mode: 'server-managed' }));
  const view = render(<SecurityEncryptionSection orgId="org-a" />);
  view.rerender(<SecurityEncryptionSection orgId="org-b" />);
  await screen.findByText('Encryption active');
  await act(async () => resolveOld({ success: true, mode: 'unmigrated' }));
  expect(screen.queryByText('This organization uses retired encryption')).toBeNull();
  expect(screen.getByText('Encryption active').textContent).toBe('Encryption active');
});

it('keeps an open recovery session when the custody status is checked again', async () => {
  getKeyCustodyStatus.mockResolvedValue({ success: true, mode: 'unmigrated' });
  const recovery = vi.fn(async () => ({ success: true, overview: { orgId: 'org-a', diagnostics: null, counts: { projects: 1, items: 0, documents: 0, attachments: 0 }, blockers: [], notices: [], ready: false, saved: false, artifactName: null, operation: null, independentClient: false, identityAssignments: [] } }));
  Object.assign(window, { electronAPI: { team: { getKeyCustodyStatus, recovery } } });
  render(<SecurityEncryptionSection orgId="org-a" />);
  fireEvent.click(await screen.findByRole('button', { name: 'Recover this organization' }));
  await screen.findByText(/1 projects/);
  fireEvent.click(screen.getByRole('button', { name: 'Check status again' }));
  await waitFor(() => expect(getKeyCustodyStatus).toHaveBeenCalledTimes(2));
  await screen.findByRole('button', { name: 'Check status again' });
  expect(recovery.mock.calls.map(call => (call as unknown[])[1])).toEqual(['status']);
});

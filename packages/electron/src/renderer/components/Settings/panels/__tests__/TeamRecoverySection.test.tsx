// @vitest-environment jsdom
import React from 'react';
import { createRoot } from 'react-dom/client';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { TeamRecoverySection } from '../TeamRecoverySection';
afterEach(cleanup);

it('requires source readiness, a saved artifact, and explicit review before enabling restoration', async () => {
  const overview = { orgId: 'org', diagnostics: null, counts: { projects: 1, items: 610, documents: 610, attachments: 0 }, blockers: [{ id: 'body', reason: 'Missing current body' }], ready: false, saved: false, artifactName: null, operation: null, independentClient: false, identityAssignments: [] };
  const recovery = vi.fn(async () => ({ success: true, overview }));
  Object.assign(window, { electronAPI: { team: { recovery } } });
  render(<TeamRecoverySection orgId="org" />);
  expect(recovery).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Recover this organization' }));
  await screen.findByText('Missing current body');
  expect((screen.getByRole('button', { name: 'Start recovery' }) as HTMLButtonElement).disabled).toBe(true);
  expect(recovery.mock.calls.every(call => (call as unknown[])[1] !== 'restore')).toBe(true);
});

it('reopens a durable validating operation and enables independent verification only after importing its bundle', async () => {
  const room = { kind: 'team', id: 'org', fenced: true, restored: true, verified: false, released: false };
  const overview = { orgId: 'org', diagnostics: null, counts: { projects: 1, items: 610, documents: 610, attachments: 3 }, blockers: [], ready: true, saved: false, artifactName: null,
    operation: { phase: 'validating', rooms: [room] }, independentClient: true, identityAssignments: [] };
  const recovery = vi.fn(async (_org: string, command: string) => ({ success: true, overview: command === 'import' ? { ...overview, saved: true, artifactName: 'sources.nimrecovery' } : command === 'verify' ? { ...overview, operation: { ...overview.operation, phase: 'completed' } } : overview }));
  Object.assign(window, { electronAPI: { team: { recovery } } });
  const first = render(<TeamRecoverySection orgId="org" />);
  fireEvent.click(screen.getByRole('button', { name: 'Recover this organization' }));
  await screen.findByText(/Recovery validating/);
  first.unmount();
  render(<TeamRecoverySection orgId="org" />);
  fireEvent.click(screen.getByRole('button', { name: 'Recover this organization' }));
  await screen.findByText(/Recovery validating/);
  fireEvent.change(screen.getByLabelText('Recovery bundle passphrase'), { target: { value: 'a portable recovery passphrase' } });
  expect((screen.getByRole('button', { name: 'Verify all content and resume sync' }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(screen.getByRole('button', { name: 'Import encrypted bundle' }));
  await screen.findByText(/sources.nimrecovery/);
  fireEvent.click(screen.getByRole('button', { name: 'Verify all content and resume sync' }));
  await screen.findByText(/Recovery verified and complete/);
  expect(recovery.mock.calls.filter(([, command]) => command === 'restore')).toHaveLength(0);
});

it('shows loss of admin authority and rejects a response for a different organization', async () => {
  const recovery = vi.fn().mockResolvedValueOnce({ success: false, error: 'An organization owner or administrator must run recovery' })
    .mockResolvedValueOnce({ success: true, overview: { orgId: 'other' } });
  Object.assign(window, { electronAPI: { team: { recovery } } });
  render(<TeamRecoverySection orgId="org" />);
  fireEvent.click(screen.getByRole('button', { name: 'Recover this organization' }));
  await screen.findByText(/administrator must run recovery/);
  fireEvent.click(screen.getByRole('button', { name: 'Inspect organization' }));
  await screen.findByText(/organization changed/);
  expect(screen.queryByRole('button', { name: 'Start recovery' })).toBeNull();
});

it('resumes from the durable checkpoint returned with an interrupted action', async () => {
  const recovery = vi.fn(async () => ({ success: false, error: 'Connection interrupted; resume recovery', overview: { orgId: 'org', counts: { projects: 1, items: 1, documents: 1, attachments: 0 }, blockers: [], notices: [], saved: true, identityAssignments: [], operation: { phase: 'restoring', rooms: [{ restored: false }] }, independentClient: false } }));
  Object.assign(window, { electronAPI: { team: { recovery } } });
  render(<TeamRecoverySection orgId="org" />);
  fireEvent.click(screen.getByRole('button', { name: 'Recover this organization' }));
  await screen.findByText(/Connection interrupted/);
  fireEvent.change(screen.getByLabelText('Recovery bundle passphrase'), { target: { value: 'a portable recovery passphrase' } });
  fireEvent.click(screen.getByRole('button', { name: 'Resume recovery' }));
  await waitFor(() => expect(recovery).toHaveBeenLastCalledWith('org', 'restore', { password: 'a portable recovery passphrase' }));
});

it('sends the passphrase only to bundle commands and releases main-process state when closed', async () => {
  const overview = { orgId: 'org', diagnostics: { orgId: 'org' }, counts: { projects: 1, items: 0, documents: 0, attachments: 0 }, blockers: [], notices: [], ready: false, saved: false, artifactName: null, operation: null, independentClient: false, identityAssignments: [] };
  const recovery = vi.fn(async (..._args: unknown[]) => ({ success: true, overview }));
  Object.assign(window, { electronAPI: { team: { recovery } } });
  const view = render(<TeamRecoverySection orgId="org" />);
  fireEvent.click(screen.getByRole('button', { name: 'Recover this organization' }));
  fireEvent.change(screen.getByLabelText('Recovery bundle passphrase'), { target: { value: 'a portable recovery passphrase' } });
  for (const name of ['Inspect organization', 'Refresh recovery status', 'Export diagnostics', 'Import encrypted bundle']) {
    await waitFor(() => expect((screen.getByRole('button', { name }) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByRole('button', { name }));
  }
  await waitFor(() => expect(recovery).toHaveBeenCalledTimes(5));
  expect(recovery.mock.calls.map(call => [call[1], call[2]])).toEqual([
    ['status', {}], ['inspect', {}], ['status', {}], ['export-diagnostics', {}], ['import', { password: 'a portable recovery passphrase' }],
  ]);
  view.rerender(<TeamRecoverySection orgId="other" />);
  expect(recovery).toHaveBeenLastCalledWith('org', 'release');
  view.unmount();
  expect(recovery.mock.calls.filter(call => call[1] === 'release')).toHaveLength(1);
});

it('opens on a click that lands before the mount effects flush', async () => {
  // CI #1674: a status reply resolved outside act commits the button and wakes
  // findByRole before passive effects run; the click must not be undone by them.
  const overview = { orgId: 'org', diagnostics: null, counts: { projects: 1, items: 0, documents: 0, attachments: 0 }, blockers: [], notices: [], ready: false, saved: false, artifactName: null, operation: null, independentClient: false, identityAssignments: [] };
  const recovery = vi.fn(async (..._args: unknown[]) => ({ success: true, overview }));
  Object.assign(window, { electronAPI: { team: { recovery } } });
  const actEnvironment = (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = false;
  const container = document.body.appendChild(document.createElement('div'));
  const root = createRoot(container);
  try {
    const committed = new Promise<void>(resolve => {
      const observer = new MutationObserver(() => { observer.disconnect(); resolve(); });
      observer.observe(container, { childList: true, subtree: true });
    });
    root.render(<TeamRecoverySection orgId="org" />);
    await committed;
    (container.querySelector('button') as HTMLButtonElement).click();
    await waitFor(() => expect(container.textContent).toContain('1 projects'));
  } finally {
    root.unmount();
    container.remove();
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = actEnvironment;
  }
});

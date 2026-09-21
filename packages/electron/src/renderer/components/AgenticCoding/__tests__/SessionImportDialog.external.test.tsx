// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';

const { registrations, refresh } = vi.hoisted(() => ({ registrations: [] as any[], refresh: vi.fn() }));
vi.mock('../../../contexts/DialogContext', () => ({ registerDialog: (config: any) => registrations.push(config) }));
vi.mock('../../ProjectSelectionDialog/ProjectSelectionDialog', () => ({ ProjectSelectionDialog: () => null }));
vi.mock('../../ErrorDialog/ErrorDialog', () => ({ ErrorDialog: () => null }));
vi.mock('../../BlitzDialog/BlitzDialog', () => ({ BlitzDialog: () => null }));
vi.mock('../../../dialogs/confirmDialogRegistration', () => ({ registerConfirmDialog: () => {} }));
vi.mock('@nimbalyst/runtime/store', () => ({ store: { set: refresh } }));
vi.mock('../../../store/atoms/sessions', () => ({ refreshSessionListAtom: {} }));
import { SessionImportDialog } from '../SessionImportDialog';
import { registerDataDialogs } from '../../../dialogs/dataDialogs';
import { DIALOG_IDS } from '../../../dialogs/registry';

const summaries = ['claude-code', 'openai-codex'].map(providerId => ({
  providerId, sessionId: 'same-id', workspacePath: '/workspace', title: providerId,
  createdAt: 100, updatedAt: 100, messageCount: 1, tokenUsage: { totalTokens: 2 }, syncStatus: 'new',
}));
afterEach(() => { cleanup(); vi.clearAllMocks(); });

it('does no closed-dialog scan, then imports only the selected provider identity through the mounted caller while follow is off', async () => {
  const invoke = vi.fn().mockImplementation(async (channel: string) => channel.endsWith('scan') || channel.endsWith('scan-sessions')
    ? { success: true, sessions: summaries }
    : { success: true, results: [], successCount: 1, failureCount: 0 });
  const settingsSet = vi.fn();
  window.electronAPI = { invoke, settingsSet } as any;
  registerDataDialogs();
  const Wrapper = registrations.find(config => config.id === DIALOG_IDS.SESSION_IMPORT).component;
  const onClose = vi.fn();
  const view = render(<Wrapper isOpen={false} onClose={onClose} data={{ workspacePath: '/workspace' }} />);
  expect(invoke).not.toHaveBeenCalled();
  view.rerender(<Wrapper isOpen onClose={onClose} data={{ workspacePath: '/workspace' }} />);
  await screen.findByLabelText('Select claude-code');
  fireEvent.click(screen.getByLabelText('Select claude-code'));
  fireEvent.click(screen.getByRole('button', { name: 'Import 1 Session' }));
  await waitFor(() => expect(onClose).toHaveBeenCalledOnce());
  expect(invoke).toHaveBeenNthCalledWith(1, 'external-sessions:scan', { workspacePath: '/workspace' });
  expect(invoke).toHaveBeenLastCalledWith('external-sessions:sync', {
    sessions: [{ providerId: 'openai-codex', sessionId: 'same-id', workspacePath: '/workspace' }], workspacePath: '/workspace',
  });
  expect(refresh).toHaveBeenCalledOnce();
  expect(settingsSet).not.toHaveBeenCalled();
});

it('preserves the explicit dialog all-workspace fallback and source cwd in selection', async () => {
  const invoke = vi.fn().mockResolvedValueOnce({ success: true, sessions: [] })
    .mockResolvedValueOnce({ success: true, sessions: [{ ...summaries[1], workspacePath: '/other' }] })
    .mockResolvedValueOnce({ success: true, results: [], successCount: 1, failureCount: 0 });
  window.electronAPI = { invoke } as any;
  registerDataDialogs();
  const Wrapper = registrations.find(config => config.id === DIALOG_IDS.SESSION_IMPORT).component;
  const onClose = vi.fn();
  render(<Wrapper isOpen onClose={onClose} data={{ workspacePath: '/workspace' }} />);
  fireEvent.click(await screen.findByRole('button', { name: 'Import 1 Session' }));
  await waitFor(() => expect(onClose).toHaveBeenCalledOnce());
  expect(invoke).toHaveBeenLastCalledWith('external-sessions:sync', { sessions: [{ providerId: 'openai-codex', sessionId: 'same-id', workspacePath: '/other' }], workspacePath: '/workspace' });
  expect(invoke).toHaveBeenNthCalledWith(2, 'external-sessions:scan', { workspacePath: undefined });
});

it('keeps the mounted dialog open when a batch reports an individual import failure', async () => {
  window.electronAPI = { invoke: vi.fn().mockImplementation(async (channel: string) => channel === 'external-sessions:scan'
    ? { success: true, sessions: summaries }
    : { success: true, results: [], successCount: 1, failureCount: 1 }) } as any;
  registerDataDialogs();
  const Wrapper = registrations.find(config => config.id === DIALOG_IDS.SESSION_IMPORT).component;
  const onClose = vi.fn();
  render(<Wrapper isOpen onClose={onClose} data={{ workspacePath: '/workspace' }} />);
  fireEvent.click(await screen.findByRole('button', { name: 'Import 2 Sessions' }));
  await screen.findByText('Failed to import sessions');
  expect(onClose).not.toHaveBeenCalled();
});


it.each([null, undefined])('hides unknown aggregates (%s) while retaining explicitly known zero totals', async (unknown) => {
  window.electronAPI = { invoke: vi.fn().mockResolvedValue({ success: true, sessions: [
    { ...summaries[0], title: 'Unknown totals', messageCount: unknown, tokenUsage: unknown },
    { ...summaries[1], title: 'Known zero', messageCount: 0, tokenUsage: { totalTokens: 0 } },
  ] }) } as any;
  render(<SessionImportDialog isOpen onClose={() => {}} onImport={async () => {}} currentWorkspacePath="/workspace" />);
  const unknownRow = (await screen.findByLabelText('Select Unknown totals')).closest('.session-import-session-item') as HTMLElement;
  const zeroRow = screen.getByLabelText('Select Known zero').closest('.session-import-session-item') as HTMLElement;
  expect(within(unknownRow).queryByText(/messages|tokens/)).toBeNull();
  within(zeroRow).getByText('0 messages');
  within(zeroRow).getByText('0 tokens');
});

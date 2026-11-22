// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MigrationConsentDialog } from '../MigrationConsentDialog';

afterEach(cleanup);

const READY = { success: true, ok: true, pgliteDirBytes: 5 * 1024 ** 3, freeBytes: 40 * 1024 ** 3, requiredBytes: 10 * 1024 ** 3 };

function mockInvoke(preflight: unknown, start: unknown = { success: true }) {
  const invoke = vi.fn(async (channel: string) => {
    if (channel === 'db:migration:preflight') return preflight;
    if (channel === 'db:migration:start') return start;
    return { success: true };
  });
  window.electronAPI = { invoke } as any;
  return invoke;
}

it('records the answer when the user declines, so the prompt never shows again', async () => {
  const invoke = mockInvoke(READY);
  const onAnswer = vi.fn();
  const onClose = vi.fn();
  render(<MigrationConsentDialog isOpen onClose={onClose} onAnswer={onAnswer} />);

  fireEvent.click(await screen.findByRole('button', { name: 'Not now' }));

  expect(invoke).toHaveBeenCalledWith('db:migration:answer-consent-prompt');
  expect(invoke).not.toHaveBeenCalledWith('db:migration:start');
  expect(onAnswer).toHaveBeenCalledWith(false);
  expect(onClose).toHaveBeenCalled();
});

it('records the answer and runs the migration when the user accepts', async () => {
  const invoke = mockInvoke(READY);
  const onAnswer = vi.fn();
  render(<MigrationConsentDialog isOpen onClose={vi.fn()} onAnswer={onAnswer} />);

  fireEvent.click(await screen.findByRole('button', { name: 'Migrate now' }));

  await screen.findByRole('button', { name: 'Restart now' });
  expect(invoke).toHaveBeenCalledWith('db:migration:answer-consent-prompt');
  expect(invoke).toHaveBeenCalledWith('db:migration:start');
  expect(onAnswer).toHaveBeenCalledWith(true);
});

it('records nothing when preflight refuses, so a later launch asks again', async () => {
  const invoke = mockInvoke({ ...READY, ok: false, reason: 'Not enough free disk space.' });
  const onAnswer = vi.fn();
  render(<MigrationConsentDialog isOpen onClose={vi.fn()} onAnswer={onAnswer} />);

  await screen.findByText(/Not enough free disk space/);
  expect(screen.queryByRole('button', { name: 'Migrate now' })).toBeNull();
  await waitFor(() => expect(invoke).toHaveBeenCalledWith('db:migration:preflight'));
  expect(invoke).not.toHaveBeenCalledWith('db:migration:answer-consent-prompt');
  expect(onAnswer).not.toHaveBeenCalled();
});

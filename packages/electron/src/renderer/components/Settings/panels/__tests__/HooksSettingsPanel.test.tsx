/**
 * The hook settings page lists each file's hooks and opens the editor on the
 * right hook. After the editor closes it reads the files again.
 */

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { expect, it, vi } from 'vitest';

import { DIALOG_IDS } from '../../../../dialogs/registry';
import { HooksSettingsPanel } from '../HooksSettingsPanel';

const open = vi.fn();
vi.mock('@nimbalyst/runtime/ui/icons/MaterialSymbol', () => ({ MaterialSymbol: () => null }));
vi.mock('../../../../contexts/DialogContext', () => ({ dialogRef: { current: { open: (...args: unknown[]) => open(...args) } } }));

const WS = '/work/app';
const files: Record<string, string> = {
  localSettings: '{ "hooks": { "PreToolUse": [{ "matcher": "Bash", "hooks": [{ "type": "command", "command": "echo first" }] }] } }',
};
const invoke = vi.fn((channel: string, _ws: string, source: string) =>
  Promise.resolve(channel === 'hook-editor:open' ? { filePath: `${WS}/${source}.json`, exists: true, text: files[source] ?? '', paused: [] } : undefined),
);
Object.defineProperty(window, 'electronAPI', { value: { invoke }, configurable: true });

it('opens the editor on the clicked hook and reads the files again after it closes', async () => {
  render(<HooksSettingsPanel workspacePath={WS} />);
  fireEvent.click(await screen.findByTestId('hooks-edit-localSettings-PreToolUse/0/0'));
  expect(open).toHaveBeenCalledWith(
    DIALOG_IDS.HOOK_EDITOR,
    expect.objectContaining({ workspacePath: WS, source: 'localSettings', selectId: 'PreToolUse/0/0', focusPalette: false }),
  );

  files.localSettings = '{ "hooks": { "Stop": [{ "hooks": [{ "type": "command", "command": "echo done" }] }] } }';
  open.mock.calls[0][1].onClosed();
  await waitFor(() => expect(screen.queryByTestId('hooks-edit-localSettings-PreToolUse/0/0')).toBeNull());
  expect(screen.getByTestId('hooks-edit-localSettings-Stop/0/0')).not.toBeNull();
});

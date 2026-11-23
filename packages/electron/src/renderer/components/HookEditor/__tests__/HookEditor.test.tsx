/**
 * The hook editor screen, rendered for real. The five hook-editor channels
 * answer from a map of fake files, so each test can change a file "on disk".
 */

import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';

import type { SaveRequest } from '../../../../main/services/hookEditor/HookFileService';
import { NOT_PLAIN_JSON_REASON, UNREADABLE_EVENT_REASON } from '../../../../shared/hookEditor/hookDocument';
import { SAVE_CONFLICT_REASON } from '../../../../shared/hookEditor/savePlan';
import { settingsThenEntry } from '../../../../shared/hookEditor/thenBlocks';
import { HookEditor } from '../HookEditor';
import { HookEditorDialog } from '../HookEditorDialog';
import { READ_FAILED_REASON, SWITCH_TAB_REASON } from '../hookEditorState';

vi.mock('@nimbalyst/runtime/ui/icons/MaterialSymbol', () => ({ MaterialSymbol: () => null }));

const WS = '/work/app';
const LOCAL = `{
  "model": "opus",
  "hooks": {
    "PreToolUse": [
      { "matcher": "Bash", "hooks": [{ "type": "command", "command": "echo first" }] }
    ]
  }
}
`;
const files: Record<string, string> = {};
const handlers = new Map<string, (...args: any[]) => unknown>();
const invoke = vi.fn((channel: string, ...args: unknown[]) => Promise.resolve(handlers.get(channel)?.(...args)));
const send = vi.fn();

beforeEach(() => {
  for (const name of Object.keys(files)) delete files[name];
  handlers.clear();
  invoke.mockClear();
  send.mockReset();
  handlers.set('hook-editor:open', (_ws: string, source: string) => ({
    filePath: `${WS}/.claude/${source}.json`,
    exists: (files[source] ?? '') !== '',
    text: files[source] ?? '',
    paused: [],
  }));
  handlers.set('hook-editor:check', () => []);
  handlers.set('hook-editor:list-backups', () => []);
  Object.defineProperty(window, 'electronAPI', { value: { invoke, send }, configurable: true });
});

function renderEditor(onClose: () => void = () => {}) {
  return render(<HookEditor workspacePath={WS} source="localSettings" selectId={null} focusPalette={false} onClose={onClose} />);
}

it('shows why a broken or unreadable file cannot open, and restores a backup before any edit', async () => {
  files.localSettings = '{ "hooks": ';
  const open = handlers.get('hook-editor:open')!;
  handlers.set('hook-editor:open', (ws: string, source: string) => {
    if (source === 'projectSettings') throw new Error('EACCES');
    return open(ws, source);
  });
  handlers.set('hook-editor:list-backups', () => [{ name: 'b1', savedAt: '2026-10-09T14:05:07Z' }]);
  handlers.set('hook-editor:restore', () => {
    files.localSettings = LOCAL;
    return { status: 'restored', text: LOCAL, backupName: 'b2', pruneWarning: null };
  });
  renderEditor();
  expect((await screen.findByTestId('hook-open-problem')).textContent).toContain(NOT_PLAIN_JSON_REASON);
  fireEvent.click(await screen.findByTestId('hook-restore-b1'));
  fireEvent.click(screen.getByTestId('hook-restore-confirm'));
  await waitFor(() => expect(screen.queryByTestId('hook-open-problem')).toBeNull());
  expect(invoke).toHaveBeenCalledWith('hook-editor:restore', WS, 'localSettings', 'b1');
  expect(screen.getByTestId('hook-json-text').textContent).toContain('echo first');

  // A file that cannot be read at all shows why, not an empty canvas.
  fireEvent.click(screen.getByTestId('hook-file-tab-projectSettings'));
  expect(screen.getByTestId('hook-open-problem').textContent).toContain(READ_FAILED_REASON);
});

it('does not show the Checks results of one file while another file, a broken one, is open', async () => {
  files.localSettings = LOCAL;
  files.userSettings = '{ "hooks": ';
  handlers.set('hook-editor:check', () => [{ check: 'json', status: 'passed', problems: [] }]);
  renderEditor();
  fireEvent.click(await screen.findByTestId('hook-side-tab-checks'));
  await screen.findByText(/valid JSON: passed/);
  fireEvent.click(screen.getByTestId('hook-file-tab-userSettings'));
  await screen.findByTestId('hook-open-problem');
  expect(screen.queryByText(/passed/)).toBeNull();
});

/** Picks a block in the "Do this" dropdown. */
function pickBlock(id: string) {
  fireEvent.click(screen.getByTestId('hook-do-input'));
  fireEvent.click(screen.getByTestId(`hook-do-option-${id}`));
}

/** Picks an event in the "When" dropdown and clicks Add. */
function addWhen(event: string) {
  fireEvent.click(screen.getByTestId('hook-when-input'));
  fireEvent.click(screen.getByTestId(`hook-when-option-${event}`));
  fireEvent.click(screen.getByTestId('hook-when-add'));
}

/** Selects the Bash group and adds "Run a command" with the palette. */
async function addSecondHook() {
  fireEvent.click(await screen.findByTestId('hook-group-PreToolUse/0'));
  pickBlock('runCommand');
  fireEvent.click(screen.getByTestId('hook-do-add'));
  fireEvent.change(await screen.findByTestId('hook-ask-command'), { target: { value: 'echo second' } });
  fireEvent.click(screen.getByTestId('hook-ask-add'));
  await waitFor(() => expect(screen.getByTestId('hook-json-text').textContent).toContain('echo second'));
}

it('adds a hook from the palette, keeps the file tab while unsaved, and undoes a delete', async () => {
  files.localSettings = LOCAL;
  renderEditor();
  await addSecondHook();

  fireEvent.click(screen.getByTestId('hook-file-tab-userSettings'));
  expect(screen.getByTestId('hook-notice').textContent).toBe(SWITCH_TAB_REASON);

  fireEvent.click(screen.getByTestId('hook-delete-PreToolUse/0/1'));
  expect(screen.getByTestId('hook-json-text').textContent).not.toContain('echo second');
  fireEvent.click(screen.getByTestId('hook-undo-toast'));
  expect(screen.getByTestId('hook-json-text').textContent).toContain('echo second');
});

/** The sentences in the open Review panel, one per change. */
function reviewSentences(): string[] {
  return within(screen.getByTestId('hook-review-panel')).getAllByRole('listitem').map((item) => item.textContent ?? '');
}

it('pauses a hook into the tray, undoes the pause, turns it back on, and saves the paused list', async () => {
  files.localSettings = LOCAL;
  const saves: SaveRequest[] = [];
  handlers.set('hook-editor:save', (_ws: string, request: SaveRequest) => {
    saves.push(request);
    files.localSettings = request.newText;
    return { status: 'saved', text: request.newText, backupName: 'b', pruneWarning: null };
  });
  renderEditor();
  // The hook's form is open, so the test can see that a pause closes it and a turn back on does not bring it back.
  await openHook('PreToolUse/0/0');
  await screen.findByTestId('hook-field-command');

  fireEvent.click(screen.getByTestId('hook-pause-PreToolUse/0/0'));
  expect(screen.getByTestId('hook-json-text').textContent).not.toContain('echo first');
  expect(screen.getByTestId('hook-paused-tray').textContent).toContain('echo first');
  expect(screen.queryByTestId('hook-field-command')).toBeNull();
  fireEvent.click(screen.getByTestId('hook-review'));
  expect(reviewSentences()).toEqual([expect.stringMatching(/^Pauses "/)]);
  fireEvent.click(screen.getByText('Back'));

  // Undo puts the hook back and leaves nothing to review.
  fireEvent.click(screen.getByTestId('hook-undo'));
  expect(screen.getByTestId('hook-json-text').textContent).toContain('echo first');
  expect(screen.queryByTestId('hook-paused-tray')).toBeNull();
  expect((screen.getByTestId('hook-review') as HTMLButtonElement).disabled).toBe(true);

  fireEvent.click(screen.getByTestId('hook-pause-PreToolUse/0/0'));
  fireEvent.click(screen.getByTestId('hook-review'));
  fireEvent.click(screen.getByTestId('hook-save'));
  await waitFor(() => expect(screen.queryByTestId('hook-unsaved-count')).toBeNull());
  expect(saves).toHaveLength(1);
  expect(saves[0].paused).toEqual([{ event: 'PreToolUse', matcher: 'Bash', entry: { type: 'command', command: 'echo first' } }]);
  expect(saves[0].newText).not.toContain('echo first');

  fireEvent.click(screen.getByTestId('hook-resume-0'));
  expect(screen.getByTestId('hook-json-text').textContent).toContain('echo first');
  expect(screen.queryByTestId('hook-paused-tray')).toBeNull();
  expect(screen.queryByTestId('hook-field-command')).toBeNull();
  fireEvent.click(screen.getByTestId('hook-review'));
  expect(reviewSentences()).toEqual([expect.stringMatching(/^Turns back on "/)]);
});

it('shows a paused hook that is already in the file, and clears it from the tray without a second copy', async () => {
  files.localSettings = LOCAL;
  const open = handlers.get('hook-editor:open')!;
  handlers.set('hook-editor:open', async (ws: string, source: string) => ({
    ...((await open(ws, source)) as object),
    paused: [{ event: 'PreToolUse', matcher: 'Bash', entry: { type: 'command', command: 'echo first' } }],
  }));
  const saves: SaveRequest[] = [];
  handlers.set('hook-editor:save', (_ws: string, request: SaveRequest) => {
    saves.push(request);
    files.localSettings = request.newText;
    return { status: 'saved', text: request.newText, backupName: 'b', pruneWarning: null };
  });
  renderEditor();
  const tray = await screen.findByTestId('hook-paused-tray');
  expect(tray.textContent).toContain('Already in the file');
  expect(screen.getByTestId('hook-resume-0').textContent).toBe('Remove from tray');

  fireEvent.click(screen.getByTestId('hook-resume-0'));
  expect(screen.queryByTestId('hook-paused-tray')).toBeNull();
  // Undo brings the "Remove from tray" row back, and nothing is left to save.
  fireEvent.click(screen.getByTestId('hook-undo'));
  expect(screen.getByTestId('hook-resume-0').textContent).toBe('Remove from tray');
  expect(screen.queryByTestId('hook-unsaved-count')).toBeNull();
  fireEvent.click(screen.getByTestId('hook-resume-0'));
  expect(screen.queryByTestId('hook-paused-tray')).toBeNull();
  expect(screen.getAllByTestId(/^hook-block-PreToolUse\//)).toHaveLength(1);
  fireEvent.click(screen.getByTestId('hook-review'));
  expect(reviewSentences()).toEqual(['Takes "Run a command" off the paused list. It is already in the file.']);
  fireEvent.click(screen.getByTestId('hook-save'));
  await waitFor(() => expect(saves).toHaveLength(1));
  expect(saves[0].newText.match(/echo first/g)).toHaveLength(1);
  expect(saves[0].paused).toEqual([]);
});

it('shows hooks paused before this launch, and refuses to turn one back on into an unreadable event', async () => {
  files.localSettings = LOCAL.replace('"hooks": {', '"hooks": {\n    "Stop": "not a list",');
  const pausedAtOpen = [
    { event: 'Stop', matcher: null, entry: { type: 'command', command: 'echo later' } },
    { event: 'PreToolUse', matcher: 'Bash', entry: { type: 'command', command: 'echo kept' } },
  ];
  const open = handlers.get('hook-editor:open')!;
  handlers.set('hook-editor:open', async (ws: string, source: string) => ({
    ...((await open(ws, source)) as object),
    paused: source === 'localSettings' ? pausedAtOpen : [],
  }));
  const saves: SaveRequest[] = [];
  handlers.set('hook-editor:save', (_ws: string, request: SaveRequest) => {
    saves.push(request);
    files.localSettings = request.newText;
    return { status: 'saved', text: request.newText, backupName: 'b', pruneWarning: null };
  });
  renderEditor();
  const tray = await screen.findByTestId('hook-paused-tray');
  expect(tray.textContent).toContain('echo later');
  expect(tray.textContent).toContain('echo kept');

  // The tray follows the open file tab: the other file has nothing paused, so no tray shows there.
  fireEvent.click(screen.getByTestId('hook-file-tab-userSettings'));
  await waitFor(() => expect(screen.queryByTestId('hook-paused-tray')).toBeNull());
  fireEvent.click(screen.getByTestId('hook-file-tab-localSettings'));
  expect((await screen.findByTestId('hook-paused-tray')).textContent).toContain('echo later');

  // Stop holds text, not a list, so a hook cannot go back into it. The tray keeps the hook and the notice says why.
  expect(screen.queryByTestId('hook-notice')).toBeNull();
  fireEvent.click(screen.getByTestId('hook-resume-0'));
  expect(screen.getByTestId('hook-notice').textContent).toBe(UNREADABLE_EVENT_REASON);
  expect(screen.getByTestId('hook-paused-tray').textContent).toContain('echo later');
  expect(screen.getByTestId('hook-json-text').textContent).not.toContain('echo later');

  // An ordinary edit and save keeps the paused list the file opened with.
  await addSecondHook();
  fireEvent.click(screen.getByTestId('hook-review'));
  fireEvent.click(screen.getByTestId('hook-save'));
  await waitFor(() => expect(screen.queryByTestId('hook-unsaved-count')).toBeNull());
  expect(saves).toHaveLength(1);
  expect(saves[0].paused).toEqual(pausedAtOpen);

  fireEvent.click(screen.getByTestId('hook-resume-1'));
  expect(screen.getByTestId('hook-json-text').textContent).toContain('echo kept');
  expect(screen.getByTestId('hook-paused-tray').textContent).toContain('echo later');
  expect(screen.getByTestId('hook-paused-tray').textContent).not.toContain('echo kept');
});

it('says a settings file Then block fails open, how the AI must answer, and which file turned hooks off', async () => {
  const thenEntry = settingsThenEntry('PreToolUse', { answer: 'permission', decision: 'deny', message: 'Not here.' });
  files.localSettings = JSON.stringify({ hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [thenEntry, { type: 'prompt', prompt: 'Is this safe?' }] }] } });
  files.userSettings = '{ "disableAllHooks": true }';
  renderEditor();
  await openHook('PreToolUse/0/0');
  await screen.findByTestId('hook-field-decision');
  expect(screen.getByTestId('hook-fails-open-note').textContent).toContain('fails open');

  // The AI hook form says what the answer must look like. The Then block form does not.
  await openHook('PreToolUse/0/1');
  await screen.findByText(/The AI answers "ok", or "not ok" with a reason\./);
  expect(screen.queryByTestId('hook-fails-open-note')).toBeNull();

  await waitFor(() => expect(screen.getByTestId('hook-hooks-off').textContent).toBe(`Hooks are off in ${WS}/.claude/userSettings.json. Nothing in this file runs.`));
});

it('lets Escape close only an open popover, and keeps a refused web address in the popover with its reason', async () => {
  files.localSettings = LOCAL;
  const onClose = vi.fn();
  renderEditor(onClose);
  fireEvent.click(await screen.findByTestId('hook-group-PreToolUse/0'));
  // A real click leaves the focus on the palette button, so Escape starts there.
  pickBlock('runCommand');
  const button = screen.getByTestId('hook-do-add');
  act(() => button.focus());
  fireEvent.click(button);
  await screen.findByTestId('hook-ask-command');
  fireEvent.keyDown(button, { key: 'Escape' });
  expect(onClose).not.toHaveBeenCalled();
  await waitFor(() => expect(screen.queryByTestId('hook-ask-command')).toBeNull());

  // The popover takes the focus, so Escape and typing go to it.
  pickBlock('sendToWeb');
  fireEvent.click(screen.getByTestId('hook-do-add'));
  const url = await screen.findByTestId('hook-ask-url');
  await waitFor(() => expect(document.activeElement).toBe(url));
  fireEvent.change(url, { target: { value: 'example.com' } });
  fireEvent.click(screen.getByTestId('hook-ask-add'));
  expect((screen.getByTestId('hook-ask-url') as HTMLTextAreaElement).value).toBe('example.com');
  expect(screen.getByTestId('hook-ask-reason').textContent).not.toBe('');
  expect(screen.getByTestId('hook-json-text').textContent).not.toContain('example.com');
});

it('lets Escape in a text box only leave the box, keeps Escape working after a margin click, and asks before it drops changes', async () => {
  files.localSettings = LOCAL;
  const onClose = vi.fn();
  render(
    <HookEditorDialog isOpen onClose={onClose} data={{ workspacePath: WS, source: 'localSettings', selectId: null, focusPalette: false, onClosed: () => {} }} />,
  );
  fireEvent.click((await screen.findByTestId('hook-block-PreToolUse/0/0')).firstElementChild!);
  const field = screen.getByTestId('hook-field-command');
  act(() => field.focus());
  fireEvent.change(field, { target: { value: 'echo typed' } });

  // Escape in a text box only leaves the box. The typed text goes into the hook, and the editor stays open.
  fireEvent.keyDown(field, { key: 'Escape' });
  expect(onClose).not.toHaveBeenCalled();
  expect(screen.queryByTestId('hook-close-anyway')).toBeNull();
  await waitFor(() => expect(screen.getByTestId('hook-json-text').textContent).toContain('echo typed'));

  // In the app, a click on the dark margin moves the focus to the page. The test does that by hand, then clicks.
  act(() => (document.activeElement as HTMLElement).blur());
  fireEvent.mouseDown(document.querySelector('.hook-editor-dialog')!);
  expect(document.activeElement).toBe(screen.getByTestId('hook-editor'));

  fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
  expect(screen.getByTestId('hook-close-anyway')).not.toBeNull();
  expect(onClose).not.toHaveBeenCalled();
  fireEvent.click(screen.getByTestId('hook-close-anyway'));
  expect(onClose).toHaveBeenCalledTimes(1);
});

it('trims a typed "Only when" text, never writes an empty one, and shows the file value again after an undo', async () => {
  // A matcher that is not one of the tool chips, so the group shows a text box.
  files.localSettings = LOCAL.replace('"Bash"', '"mcp__db__.*"');
  renderEditor();
  const box = () => screen.getByTestId('hook-matcher-PreToolUse/0') as HTMLInputElement;
  const json = () => screen.getByTestId('hook-json-text').textContent ?? '';

  fireEvent.change(await screen.findByTestId('hook-matcher-PreToolUse/0'), { target: { value: '  mcp__x__.*  ' } });
  fireEvent.blur(box());
  await waitFor(() => expect(json()).toContain('"matcher": "mcp__x__.*"'));

  fireEvent.click(screen.getByTestId('hook-undo'));
  expect(json()).toContain('"matcher": "mcp__db__.*"');
  expect(box().value).toBe('mcp__db__.*');

  fireEvent.change(box(), { target: { value: '' } });
  fireEvent.blur(box());
  await waitFor(() => expect(json()).not.toContain('"matcher"'));
});

it('keeps the focus on a chip after a click, undoes from the chip, and redoes from the page', async () => {
  files.localSettings = LOCAL;
  renderEditor();
  const json = () => screen.getByTestId('hook-json-text').textContent ?? '';
  // A real click focuses the chip. The chip row stays in place, so the focus stays on the chip.
  const chip = await screen.findByTestId('hook-chip-PreToolUse/0-Read');
  act(() => chip.focus());
  fireEvent.click(chip);
  expect(document.activeElement).toBe(chip);
  expect(json()).toContain('"matcher": "Bash|Read"');

  fireEvent.keyDown(chip, { key: 'z', metaKey: true });
  expect(json()).toContain('"matcher": "Bash"');

  // The Undo button can turn off while it has the focus. Then the focus falls to the page, and a key there still reaches the editor.
  act(() => (document.activeElement as HTMLElement).blur());
  fireEvent.keyDown(document.body, { key: 'z', metaKey: true, shiftKey: true });
  expect(json()).toContain('"matcher": "Bash|Read"');
  expect(document.activeElement).toBe(screen.getByTestId('hook-editor'));
});

/** Opens a hook form by a click on its row. */
async function openHook(id: string) {
  fireEvent.click((await screen.findByTestId(`hook-block-${id}`)).firstElementChild!);
}

it('undoes from the time limit slider and the carry-on checkbox, while a text box keeps its own undo', async () => {
  files.localSettings = LOCAL.replace('"hooks": [{ "type": "command", "command": "echo first" }]', '"hooks": [{ "type": "command", "command": "echo first" }, { "type": "prompt", "prompt": "Is this safe?" }]');
  renderEditor();
  const json = () => screen.getByTestId('hook-json-text').textContent ?? '';
  await openHook('PreToolUse/0/0');
  const field = screen.getByTestId('hook-field-command');
  fireEvent.focus(field);
  fireEvent.change(field, { target: { value: 'echo changed' } });
  fireEvent.blur(field);
  await waitFor(() => expect(json()).toContain('echo changed'));

  // In a text box, Cmd+Z is the box's own undo, so the hook is left alone.
  fireEvent.keyDown(field, { key: 'z', metaKey: true });
  expect(json()).toContain('echo changed');

  // A slider has no typed text to undo, so Cmd+Z undoes the last hook change.
  const slider = screen.getByTestId('hook-field-timeout');
  fireEvent.keyDown(slider, { key: 'z', metaKey: true });
  expect(json()).toContain('echo first');
  expect(json()).not.toContain('echo changed');
  fireEvent.keyDown(slider, { key: 'z', metaKey: true, shiftKey: true });
  expect(json()).toContain('echo changed');

  // The same holds for the checkbox on an AI prompt hook.
  await openHook('PreToolUse/0/1');
  fireEvent.keyDown(screen.getByTestId('hook-field-continueOnBlock'), { key: 'z', metaKey: true });
  expect(json()).toContain('echo first');
  expect(json()).not.toContain('echo changed');

  // A hook with no time limit shows the default and says why the file leaves it out.
  await openHook('PreToolUse/0/0');
  const timeLabel = () => screen.getByTestId('hook-field-timeout').parentElement!.textContent ?? '';
  expect(timeLabel()).toContain('the file leaves it out');
  expect(json()).not.toContain('timeout');
  expect(screen.queryByTestId('hook-timeout-default')).toBeNull();

  // After one drag, the file holds the time limit and a button offers the way back.
  fireEvent.change(screen.getByTestId('hook-field-timeout'), { target: { value: '30' } });
  fireEvent.pointerUp(screen.getByTestId('hook-field-timeout'));
  await waitFor(() => expect(json()).toContain('"timeout": 30'));
  expect(screen.getByTestId('hook-timeout-default').textContent).toBe('Use the default');
  expect(timeLabel()).not.toContain('the file leaves it out');

  // The button removes the key, so the file is clean again.
  fireEvent.click(screen.getByTestId('hook-timeout-default'));
  await waitFor(() => expect(json()).not.toContain('timeout'));
  expect(timeLabel()).toContain('the file leaves it out');
  expect(screen.queryByTestId('hook-timeout-default')).toBeNull();

  // Dragging back to exactly the default value also removes the key.
  fireEvent.change(screen.getByTestId('hook-field-timeout'), { target: { value: '30' } });
  fireEvent.pointerUp(screen.getByTestId('hook-field-timeout'));
  await waitFor(() => expect(json()).toContain('"timeout": 30'));
  fireEvent.change(screen.getByTestId('hook-field-timeout'), { target: { value: '600' } });
  fireEvent.pointerUp(screen.getByTestId('hook-field-timeout'));
  await waitFor(() => expect(json()).not.toContain('timeout'));
});

it('closes a palette popover when an undo happens, so Escape reaches the editor again', async () => {
  files.localSettings = LOCAL;
  const onClose = vi.fn();
  renderEditor(onClose);
  await addSecondHook();
  fireEvent.click(screen.getByTestId('hook-group-PreToolUse/0'));
  pickBlock('runCommand');
  const button = screen.getByTestId('hook-do-add');
  fireEvent.click(button);
  await screen.findByTestId('hook-ask-command');

  // Cmd+Z on the palette button undoes the added hook. The popover belonged to the old state, so it closes.
  fireEvent.keyDown(button, { key: 'z', metaKey: true });
  expect(screen.getByTestId('hook-json-text').textContent).not.toContain('echo second');
  await waitFor(() => expect(screen.queryByTestId('hook-ask-command')).toBeNull());
  // Nothing is left unsaved, so Escape closes the editor at once.
  fireEvent.keyDown(screen.getByTestId('hook-editor'), { key: 'Escape' });
  expect(onClose).toHaveBeenCalledTimes(1);
});

it('closes the open hook form when another file tab is shown', async () => {
  files.localSettings = LOCAL;
  files.userSettings = LOCAL.replace('echo first', 'echo from user');
  renderEditor();
  await openHook('PreToolUse/0/0');
  await screen.findByTestId('hook-field-command');

  // The other file has a hook at the same place. It must not open just because the place matches.
  fireEvent.click(screen.getByTestId('hook-file-tab-userSettings'));
  await waitFor(() => expect(screen.getByTestId('hook-json-text').textContent).toContain('echo from user'));
  expect(screen.queryByTestId('hook-field-command')).toBeNull();
});

it('shows the file value again in a text box after a refused or no-change edit', async () => {
  // A matcher that is not one of the tool chips, so the group shows a text box.
  files.localSettings = LOCAL.replace('"Bash"', '"mcp__db__.*"');
  renderEditor();
  await openHook('PreToolUse/0/0');

  // A hook must keep a command, so the edit is refused. The box goes back to the old command, and the notice says why.
  const field = screen.getByTestId('hook-field-command') as HTMLInputElement;
  fireEvent.focus(field);
  fireEvent.change(field, { target: { value: '' } });
  fireEvent.blur(field);
  expect(screen.getByTestId('hook-notice').textContent).not.toBe('');
  expect(field.value).toBe('echo first');

  // Spaces around the same matcher change nothing, so there is no Undo step. The box shows the file's text.
  const box = screen.getByTestId('hook-matcher-PreToolUse/0') as HTMLInputElement;
  fireEvent.change(box, { target: { value: 'mcp__db__.*  ' } });
  fireEvent.blur(box);
  expect(screen.queryByTestId('hook-unsaved-count')).toBeNull();
  expect((screen.getByTestId('hook-undo') as HTMLButtonElement).disabled).toBe(true);
  expect(box.value).toBe('mcp__db__.*');
});

it('keeps an open hook form open when a chip or Undo changes the matcher', async () => {
  files.localSettings = LOCAL;
  renderEditor();
  fireEvent.click((await screen.findByTestId('hook-block-PreToolUse/0/0')).firstElementChild!);
  await screen.findByTestId('hook-field-command');
  // A chip is a control inside the Only when row. Using it must not move the selection to the group.
  fireEvent.click(screen.getByTestId('hook-chip-PreToolUse/0-Read'));
  expect(screen.getByTestId('hook-json-text').textContent).toContain('"matcher": "Bash|Read"');
  screen.getByTestId('hook-field-command');
  fireEvent.click(screen.getByTestId('hook-undo'));
  expect(screen.getByTestId('hook-json-text').textContent).toContain('"matcher": "Bash"');
  screen.getByTestId('hook-field-command');
});

it('opens a hook form from the keyboard, and keeps its next field in place when the first field saves', async () => {
  files.localSettings = LOCAL;
  renderEditor();
  fireEvent.keyDown((await screen.findByTestId('hook-block-PreToolUse/0/0')).firstElementChild!, { key: 'Enter' });
  const second = await screen.findByTestId('hook-field-statusMessage');

  const first = screen.getByTestId('hook-field-command');
  fireEvent.focus(first);
  fireEvent.change(first, { target: { value: 'echo changed' } });
  fireEvent.blur(first);

  await waitFor(() => expect(screen.getByTestId('hook-json-text').textContent).toContain('echo changed'));
  expect(second.isConnected).toBe(true);
});

it('stops a save when the file changed on disk, reloads it without the old steps, and then saves', async () => {
  files.localSettings = LOCAL;
  const saves: SaveRequest[] = [];
  handlers.set('hook-editor:save', (_ws: string, request: SaveRequest) => {
    saves.push(request);
    if (saves.length === 1) return { status: 'refused', reason: SAVE_CONFLICT_REASON, checks: [] };
    files.localSettings = request.newText;
    return { status: 'saved', text: request.newText, backupName: 'b', pruneWarning: 'Old backups were not cleaned up.' };
  });
  renderEditor();
  await addSecondHook();

  // Another program changes the file after it was opened.
  files.localSettings = LOCAL.replace('"opus"', '"sonnet"');
  fireEvent.click(screen.getByTestId('hook-review'));
  fireEvent.click(screen.getByTestId('hook-save'));
  expect((await screen.findByTestId('hook-save-reason')).textContent).toBe(SAVE_CONFLICT_REASON);

  fireEvent.click(screen.getByTestId('hook-reload'));
  await waitFor(() => expect(screen.getByTestId('hook-json-text').textContent).toContain('sonnet'));
  expect(screen.queryByTestId('hook-unsaved-count')).toBeNull();
  expect((screen.getByTestId('hook-undo') as HTMLButtonElement).disabled).toBe(true);

  await addSecondHook();
  fireEvent.click(screen.getByTestId('hook-review'));
  fireEvent.click(screen.getByTestId('hook-save'));
  await waitFor(() => expect(screen.queryByTestId('hook-unsaved-count')).toBeNull());
  expect(saves).toHaveLength(2);
  expect(saves[1].openedText).toContain('sonnet');
  expect(saves[1].newText).toContain('echo second');
  // The review closes after a save, so a warning from the save shows in the notice bar.
  expect(screen.getByTestId('hook-notice').textContent).toBe('Old backups were not cleaned up.');
});

it('shows why a failed check stopped a save, offers Restore when a save fails midway, and warns after the file reloads', async () => {
  files.localSettings = LOCAL;
  let saveCount = 0;
  handlers.set('hook-editor:save', () =>
    ++saveCount === 1
      ? { status: 'refused', reason: 'A check failed. Nothing was saved.', checks: [{ check: 'json', status: 'failed', problems: ['Bad'] }] }
      : { status: 'failedOfferRestore', reason: 'The file could not be written.', backupName: 'b1' },
  );
  handlers.set('hook-editor:list-backups', () => [{ name: 'b1', savedAt: '2026-10-09T14:05:07Z' }]);
  handlers.set('hook-editor:restore', () => {
    files.localSettings = LOCAL.replace('"opus"', '"sonnet"');
    return { status: 'restored', text: files.localSettings, backupName: 'b2', pruneWarning: 'Old backups were not cleaned up.' };
  });
  renderEditor();
  await addSecondHook();

  // The Review panel closes to show the failed check, so the reason shows in the notice bar.
  fireEvent.click(screen.getByTestId('hook-review'));
  fireEvent.click(screen.getByTestId('hook-save'));
  await waitFor(() => expect(screen.queryByTestId('hook-review-panel')).toBeNull());
  expect(screen.getByTestId('hook-notice').textContent).toBe('A check failed. Nothing was saved.');
  fireEvent.click(screen.getByTestId('hook-side-tab-json'));

  fireEvent.click(screen.getByTestId('hook-review'));
  fireEvent.click(screen.getByTestId('hook-save'));
  expect((await screen.findByTestId('hook-save-reason')).textContent).toBe('The file could not be written.');
  fireEvent.click(await screen.findByTestId('hook-restore-b1'));
  fireEvent.click(screen.getByTestId('hook-restore-confirm'));

  await waitFor(() => expect(screen.getByTestId('hook-json-text').textContent).toContain('sonnet'));
  expect(screen.queryByTestId('hook-review-panel')).toBeNull();
  // The restore notice comes first, and the warning from the restore follows it.
  await waitFor(() => expect(screen.getByTestId('hook-notice').textContent).toMatch(/^Restored the backup from .+\. The version it replaced is now a backup too\. Old backups were not cleaned up\.$/));
});

it('lists the backups of a valid file in the Backups tab, restores one, and says so in the notice', async () => {
  files.localSettings = LOCAL;
  const savedAt = '2026-10-09T14:05:07Z';
  handlers.set('hook-editor:list-backups', () => [{ name: 'b1', savedAt }]);
  handlers.set('hook-editor:restore', () => {
    files.localSettings = LOCAL.replace('"opus"', '"sonnet"');
    handlers.set('hook-editor:list-backups', () => [{ name: 'b2', savedAt }, { name: 'b1', savedAt }]);
    return { status: 'restored', text: files.localSettings, backupName: 'b2', pruneWarning: null };
  });
  renderEditor();
  await screen.findByTestId('hook-json-text');
  expect(screen.queryByTestId('hook-open-problem')).toBeNull();

  fireEvent.click(screen.getByTestId('hook-side-tab-backups'));
  fireEvent.click(await screen.findByTestId('hook-restore-b1'));
  // With nothing unsaved, the confirm step has no warning about lost changes.
  await screen.findByTestId('hook-restore-confirm');
  expect(screen.queryByTestId('hook-restore-unsaved')).toBeNull();
  fireEvent.click(screen.getByText('Cancel'));

  // With an unsaved change, the confirm step says the restore replaces it, before the user confirms.
  fireEvent.click(screen.getByTestId('hook-side-tab-json'));
  await addSecondHook();
  fireEvent.click(screen.getByTestId('hook-side-tab-backups'));
  fireEvent.click(await screen.findByTestId('hook-restore-b1'));
  expect(screen.getByTestId('hook-restore-unsaved').textContent).toBe('You have 1 change not saved in this file. Restore replaces it.');
  fireEvent.click(screen.getByTestId('hook-restore-confirm'));

  expect(invoke).toHaveBeenCalledWith('hook-editor:restore', WS, 'localSettings', 'b1');
  // The notice names the backup by the same date and time text its row shows.
  await waitFor(() =>
    expect(screen.getByTestId('hook-notice').textContent).toBe(
      `Restored the backup from ${new Date(savedAt).toLocaleString()}. The version it replaced is now a backup too.`,
    ),
  );
  // The file was read again, so the JSON shows the restored text.
  fireEvent.click(screen.getByTestId('hook-side-tab-json'));
  expect(screen.getByTestId('hook-json-text').textContent).toContain('sonnet');
  // The Backups tab reads its list again, so the version the restore replaced shows up.
  fireEvent.click(screen.getByTestId('hook-side-tab-backups'));
  await screen.findByTestId('hook-restore-b2');
});

it('says there are no backups yet in the Backups tab, and keeps the tab shut while the review is open', async () => {
  files.localSettings = LOCAL;
  renderEditor();
  await addSecondHook();
  fireEvent.click(screen.getByTestId('hook-side-tab-backups'));
  expect((await screen.findByTestId('hook-restore-panel')).textContent).toContain('No backups yet. Nimbalyst makes one before every save.');
  fireEvent.click(screen.getByTestId('hook-review'));
  expect((screen.getByTestId('hook-side-tab-backups') as HTMLButtonElement).disabled).toBe(true);
});

it('shows events in the palette order whatever the file order, and starts a picked "When" with an example hook', async () => {
  const SESSION_FIRST = `{
  "hooks": {
    "SessionStart": [{ "matcher": "startup", "hooks": [{ "type": "command", "command": "echo hi" }] }],
    "PreToolUse": [{ "matcher": "Read", "hooks": [{ "type": "command", "command": "echo read" }] }]
  }
}
`;
  files.localSettings = SESSION_FIRST;
  const first = renderEditor();
  const json = () => screen.getByTestId('hook-json-text').textContent ?? '';
  const before = (a: string, b: string) => Boolean(screen.getByTestId(a).compareDocumentPosition(screen.getByTestId(b)) & Node.DOCUMENT_POSITION_FOLLOWING);
  await screen.findByTestId('hook-event-SessionStart');

  // The canvas follows the palette order. The file keeps its own order and its ids.
  expect(before('hook-event-PreToolUse', 'hook-event-SessionStart')).toBe(true);
  expect(json().indexOf('"SessionStart"')).toBeLessThan(json().indexOf('"PreToolUse"'));
  expect(screen.getByTestId('hook-block-PreToolUse/0/0')).toBeDefined();
  expect(screen.queryByTestId('hook-unsaved-count')).toBeNull();

  // Picking an event that has a group with another "Only when" adds a new last group. The old group stays.
  // Typing narrows the list to the matching events, and Enter picks the first match.
  const whenInput = screen.getByTestId('hook-when-input');
  // A click on the box opens the list, and a second click closes it.
  fireEvent.click(whenInput);
  screen.getByTestId('hook-when-option-SessionStart');
  fireEvent.click(whenInput);
  expect(screen.queryByTestId('hook-when-option-SessionStart')).toBeNull();
  fireEvent.change(whenInput, { target: { value: 'pretool' } });
  expect(screen.queryByTestId('hook-when-option-SessionStart')).toBeNull();
  fireEvent.keyDown(whenInput, { key: 'Enter' });
  fireEvent.click(screen.getByTestId('hook-when-add'));
  expect((await screen.findByTestId('hook-field-command') as HTMLInputElement).value).toBe("echo 'PreToolUse hook ran'");
  expect(screen.getByTestId('hook-unsaved-count').textContent).toBe('1 change not saved');
  expect(json()).toContain('"matcher": "Bash"');
  expect(json()).toContain('"matcher": "Read"');
  expect(screen.getByTestId('hook-block-PreToolUse/1/0')).toBeDefined();
  fireEvent.click(screen.getByTestId('hook-undo'));
  expect(screen.queryByTestId('hook-unsaved-count')).toBeNull();
  expect(json()).not.toContain('"Bash"');
  first.unmount();

  // A new event lands in its own slot, before the event the file already has, with the example "Only when" and command.
  files.localSettings = SESSION_FIRST.replace(/,\n    "PreToolUse".*\n/, '\n');
  renderEditor();
  await screen.findByTestId('hook-event-SessionStart');
  addWhen('PreToolUse');
  expect((await screen.findByTestId('hook-field-command') as HTMLInputElement).value).toBe("echo 'PreToolUse hook ran'");
  expect(before('hook-event-PreToolUse', 'hook-event-SessionStart')).toBe(true);
  expect(json()).toContain("echo 'PreToolUse hook ran'");
  expect(json()).toContain('"matcher": "Bash"');

  // SessionStart already has a group with "startup". The starter joins that group as a second hook, and its form opens.
  addWhen('SessionStart');
  expect((await screen.findByTestId('hook-field-command') as HTMLInputElement).value).toBe("echo 'SessionStart hook ran'");
  expect(screen.getByTestId('hook-unsaved-count').textContent).toBe('2 changes not saved');
  expect(screen.getByTestId('hook-block-SessionStart/0/1')).toBeDefined();
  const sessionStart = JSON.parse(json()).hooks.SessionStart;
  expect(sessionStart).toHaveLength(1);
  expect(sessionStart[0].matcher).toBe('startup');
  expect(sessionStart[0].hooks.map((hook: { command: string }) => hook.command)).toEqual(['echo hi', "echo 'SessionStart hook ran'"]);
  // The file keeps its own order: the picks never moved SessionStart behind PreToolUse.
  expect(json().indexOf('"SessionStart"')).toBeLessThan(json().indexOf('"PreToolUse"'));

  // A folded event opens when a new block is picked inside it, so the form shows.
  fireEvent.click(screen.getByLabelText('Hide the PreToolUse hooks'));
  expect(screen.queryByTestId('hook-block-PreToolUse/0/0')).toBeNull();
  addWhen('PreToolUse');
  expect((await screen.findByTestId('hook-field-command') as HTMLInputElement).value).toBe("echo 'PreToolUse hook ran'");
});

it('holds a reload, close or quit while hook changes are not saved, and lets go after undo or close', async () => {
  files.localSettings = LOCAL;
  const held = () => {
    const event = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(event);
    return event.defaultPrevented;
  };
  const { unmount } = renderEditor();
  await screen.findByTestId('hook-json-text');
  expect(held()).toBe(false);

  await addSecondHook();
  expect(send).toHaveBeenLastCalledWith('hook-editor:set-unsaved', true);
  expect(held()).toBe(true);

  fireEvent.click(screen.getByTestId('hook-undo'));
  await waitFor(() => expect(send).toHaveBeenLastCalledWith('hook-editor:set-unsaved', false));
  expect(held()).toBe(false);

  await addSecondHook();
  unmount();
  expect(send).toHaveBeenLastCalledWith('hook-editor:set-unsaved', false);
  expect(held()).toBe(false);
});

it('closes the open hook form after a hook is dragged to a new place', async () => {
  files.localSettings = LOCAL.replace(
    '"hooks": [{ "type": "command", "command": "echo first" }]',
    '"hooks": [{ "type": "command", "command": "echo first" }, { "type": "command", "command": "echo second" }, { "type": "command", "command": "echo third" }]',
  );
  // jsdom has no layout, so each block gets a fixed place on the page. The keyboard drag needs places to move between.
  const tops: Record<string, number> = { 'hook-block-PreToolUse/0/0': 0, 'hook-block-PreToolUse/0/1': 100, 'hook-block-PreToolUse/0/2': 200, 'hook-group-end-PreToolUse/0': 400 };
  const original = Element.prototype.getBoundingClientRect;
  Element.prototype.getBoundingClientRect = function () {
    const top = tops[(this as HTMLElement).dataset?.testid ?? ''] ?? 1000;
    return { x: 0, y: top, top, left: 0, width: 100, height: 20, right: 100, bottom: top + 20, toJSON: () => ({}) } as DOMRect;
  };
  try {
    renderEditor();
    const json = () => screen.getByTestId('hook-json-text').textContent ?? '';
    await openHook('PreToolUse/0/1');
    expect((await screen.findByTestId('hook-field-command') as HTMLInputElement).value).toBe('echo second');

    // Move the first hook out into a group of its own. The second and third hooks move up one place.
    const grip = screen.getByTestId('hook-grip-PreToolUse/0/0');
    act(() => grip.focus());
    fireEvent.keyDown(grip, { code: 'Space', key: ' ' });
    fireEvent.keyDown(document, { code: 'ArrowDown', key: 'ArrowDown' });
    fireEvent.keyDown(document, { code: 'ArrowDown', key: 'ArrowDown' });
    // The drag library moves the pointer position on a timer, so the drop waits for it.
    await act(() => new Promise((resolve) => setTimeout(resolve, 100)));
    fireEvent.keyDown(document, { code: 'Space', key: ' ' });
    await waitFor(() => expect(JSON.parse(json()).hooks.PreToolUse).toHaveLength(2));

    // The place PreToolUse/0/1 now holds the third hook. Its form must not open in the place of the one the user had open.
    expect(screen.queryByTestId('hook-field-command')).toBeNull();
  } finally {
    Element.prototype.getBoundingClientRect = original;
  }
});

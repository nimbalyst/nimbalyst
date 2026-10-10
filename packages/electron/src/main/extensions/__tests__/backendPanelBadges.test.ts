// @vitest-environment node
/**
 * Host side of `ctx.services.panels.setGutterBadge`: a backend module can badge
 * only panels its own manifest declares, the badge is broadcast under the
 * module's extension and workspace, and it is replayable until cleared.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const sent: Array<{ channel: string; payload: unknown }> = [];
vi.mock('electron', () => ({
  BrowserWindow: {
    getAllWindows: () => [
      {
        isDestroyed: () => false,
        webContents: { send: (channel: string, payload: unknown) => sent.push({ channel, payload }) },
      },
    ],
  },
  ipcMain: { handle: vi.fn(), on: vi.fn(), removeHandler: vi.fn() },
}));

import {
  _resetBackendPanelGutterBadges,
  clearBackendPanelGutterBadgesForModule,
  listBackendPanelGutterBadges,
  setBackendPanelGutterBadge,
} from '../backendPanelBadges';

let extensionPath: string;
const ctx = () => ({ extensionId: 'com.example.owner', moduleId: 'core', workspacePath: '/ws', extensionPath });

beforeEach(() => {
  sent.length = 0;
  _resetBackendPanelGutterBadges();
  extensionPath = fs.mkdtempSync(path.join(os.tmpdir(), 'panel-badges-'));
  fs.writeFileSync(
    path.join(extensionPath, 'manifest.json'),
    JSON.stringify({ id: 'com.example.owner', contributions: { panels: [{ id: 'desk' }] } })
  );
});

afterEach(() => fs.rmSync(extensionPath, { recursive: true, force: true }));

describe('setBackendPanelGutterBadge', () => {
  it('broadcasts a badge for its own panel under the full panel id and keeps it for replay', async () => {
    await setBackendPanelGutterBadge(ctx(), 'desk', 3.7, 'warning');
    const update = { workspacePath: '/ws', panelId: 'com.example.owner.desk', value: 3, tone: 'warning' };
    expect(sent).toEqual([{ channel: 'extension-panels:gutter-badge', payload: update }]);
    expect(listBackendPanelGutterBadges()).toEqual([update]);

    await setBackendPanelGutterBadge(ctx(), 'desk', null, undefined);
    expect(sent[1].payload).toMatchObject({ panelId: 'com.example.owner.desk', value: null });
    expect(listBackendPanelGutterBadges()).toEqual([]);
  });

  it('rejects a panel the calling extension does not declare, including another extension\'s full id', async () => {
    await expect(setBackendPanelGutterBadge(ctx(), 'com.other.ext.panel', 1, undefined)).rejects.toThrow(
      /not declared by extension com\.example\.owner/
    );
    await expect(setBackendPanelGutterBadge(ctx(), 'roster', 1, undefined)).rejects.toThrow(/not declared/);
    expect(sent).toEqual([]);
    expect(listBackendPanelGutterBadges()).toEqual([]);
  });

  it('clears only the stopped module\'s badges in its workspace', async () => {
    await setBackendPanelGutterBadge(ctx(), 'desk', 1, undefined);
    await setBackendPanelGutterBadge({ ...ctx(), workspacePath: '/ws2' }, 'desk', 2, undefined);
    sent.length = 0;
    clearBackendPanelGutterBadgesForModule('com.example.owner', 'core', '/ws');
    expect(sent.map((s) => s.payload)).toEqual([
      { workspacePath: '/ws', panelId: 'com.example.owner.desk', value: null, tone: 'default' },
    ]);
    expect(listBackendPanelGutterBadges().map((b) => b.workspacePath)).toEqual(['/ws2']);
  });
});

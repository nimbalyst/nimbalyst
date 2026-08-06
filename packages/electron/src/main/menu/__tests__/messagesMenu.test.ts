import { describe, expect, it, vi } from 'vitest';

import { KeyboardShortcuts as SharedShortcuts } from '../../../shared/KeyboardShortcuts';
// The menu-local copy, already converted to Electron's CmdOrCtrl accelerators.
import { KeyboardShortcuts } from '../KeyboardShortcuts';

/**
 * The Messages menu the organization window contributes to the shared
 * application menu.
 *
 * `Menu.setApplicationMenu` installs one menu for the whole app, so this
 * submenu is only in the template while the org window is focused, and the two
 * accelerators it borrows go back to Agent Mode and Find the moment it leaves.
 * Both halves of that trade are asserted here.
 */

const sendOrgWindowCommand = vi.fn((_command: string) => true);

vi.mock('../../window/TeamManagementWindow', () => ({
  sendOrgWindowCommand: (command: string) => sendOrgWindowCommand(command),
}));

vi.mock('../../services/analytics/AnalyticsService', () => ({
  AnalyticsService: { getInstance: () => ({ sendEvent: vi.fn() }) },
}));

describe('Messages menu', () => {
  it('exposes every messaging command with its documented accelerator', async () => {
    const { buildMessagesMenu } = await import('../messagesMenu');
    const menu = buildMessagesMenu();

    expect(menu.label).toBe('Messages');
    const items = menu.submenu
      .filter((item: any) => item.type !== 'separator')
      .map((item: any) => [item.label, item.accelerator]);

    expect(items).toEqual([
      ['New Message...', KeyboardShortcuts.orgWindow.newMessage],
      ['Go to Inbox', KeyboardShortcuts.orgWindow.goToInbox],
      ['Search Messages', KeyboardShortcuts.orgWindow.searchMessages],
      ['Next Conversation', KeyboardShortcuts.orgWindow.nextConversation],
      ['Previous Conversation', KeyboardShortcuts.orgWindow.previousConversation],
      ['Mark All as Read', KeyboardShortcuts.orgWindow.markAllRead],
    ]);
  });

  it('sends each item to the organization window rather than the focused one', async () => {
    const { buildMessagesMenu } = await import('../messagesMenu');
    const menu = buildMessagesMenu();
    sendOrgWindowCommand.mockClear();

    const click = (label: string) => menu.submenu
      .find((item: any) => item.label === label)!
      .click();

    await click('New Message...');
    await click('Next Conversation');
    await click('Mark All as Read');

    expect(sendOrgWindowCommand.mock.calls.map(([command]) => command)).toEqual([
      'newMessage',
      'nextConversation',
      'markAllRead',
    ]);
  });

  it('borrows Cmd+K and Cmd+F from the commands that own them elsewhere', () => {
    // The swap in createApplicationMenu is only sound while these agree; if
    // Agent Mode or Find moves, the Messages menu has to move with it.
    expect(SharedShortcuts.orgWindow.newMessage).toBe(SharedShortcuts.view.agentMode);
    expect(SharedShortcuts.orgWindow.searchMessages).toBe(SharedShortcuts.edit.find);
  });

  it('has no accelerator that collides with another org-window command', () => {
    const accelerators = Object.values(SharedShortcuts.orgWindow);
    expect(new Set(accelerators).size).toBe(accelerators.length);
  });
});

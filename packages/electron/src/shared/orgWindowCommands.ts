/**
 * The messaging commands the organization window accepts, shared by the native
 * Messages menu (main process) and the window's own keyboard handling.
 *
 * The application menu is a single global menu, so main can only reach these
 * through the org window's `webContents`; the renderer runs the identical
 * command set locally so the flow works even where a native accelerator never
 * fires (Windows/Linux with the strip hidden behind the custom title bar).
 */

export const ORG_WINDOW_COMMAND_CHANNEL = 'org-window:command';

export const ORG_WINDOW_COMMANDS = [
  'newMessage',
  'searchMessages',
  'markAllRead',
  'nextConversation',
  'previousConversation',
  'goToInbox',
] as const;

export type OrgWindowCommand = (typeof ORG_WINDOW_COMMANDS)[number];

export function isOrgWindowCommand(value: unknown): value is OrgWindowCommand {
  return typeof value === 'string'
    && (ORG_WINDOW_COMMANDS as readonly string[]).includes(value);
}

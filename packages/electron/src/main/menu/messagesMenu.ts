import { KeyboardShortcuts } from './KeyboardShortcuts';
import { sendOrgWindowCommand } from '../window/TeamManagementWindow';
import { AnalyticsService } from '../services/analytics/AnalyticsService';
import type { OrgWindowCommand } from '../../shared/orgWindowCommands';

/**
 * The Messages menu, present only while the organization window is focused.
 *
 * `Menu.setApplicationMenu` installs one menu for the whole app, so this is how
 * a window-specific menu is done: the whole submenu leaves the template when
 * focus moves elsewhere, and the accelerators it borrows (`Cmd+K` from Agent
 * Mode, `Cmd+F` from Find) go back to their owners at the same moment. Leaving
 * the items in place but disabled would not do — a disabled item still swallows
 * its accelerator, so the project window would lose both keys for good.
 *
 * Every item addresses the org window directly rather than `getFocusedWindow()`:
 * the org window is not in the `windows` / `windowStates` maps the rest of this
 * menu resolves through, which is exactly why none of those items ever worked
 * while it was key.
 */
export function buildMessagesMenu(): any {
    const command = (
        label: string,
        accelerator: string,
        id: OrgWindowCommand,
        action: string,
    ) => ({
        label,
        accelerator,
        click: async () => {
            AnalyticsService.getInstance().sendEvent('menu_action_used', {
                menu: 'messages',
                action,
                hasKeyboardEquivalent: true,
            });
            sendOrgWindowCommand(id);
        },
    });

    return {
        label: 'Messages',
        submenu: [
            command('New Message...', KeyboardShortcuts.orgWindow.newMessage, 'newMessage', 'new_message'),
            { type: 'separator' },
            command('Go to Inbox', KeyboardShortcuts.orgWindow.goToInbox, 'goToInbox', 'go_to_inbox'),
            command('Search Messages', KeyboardShortcuts.orgWindow.searchMessages, 'searchMessages', 'search_messages'),
            { type: 'separator' },
            command('Next Conversation', KeyboardShortcuts.orgWindow.nextConversation, 'nextConversation', 'next_conversation'),
            command('Previous Conversation', KeyboardShortcuts.orgWindow.previousConversation, 'previousConversation', 'previous_conversation'),
            { type: 'separator' },
            command('Mark All as Read', KeyboardShortcuts.orgWindow.markAllRead, 'markAllRead', 'mark_all_read'),
        ],
    };
}

import type { ComponentProps, MouseEventHandler } from 'react';
/**
 * Browser documents are real links; desktop hosts retain their open action.
 *
 * In the browser a plain click runs the host's open action, which navigates the
 * current tab, while a modified click (cmd, ctrl, shift, middle) is left to the
 * browser so a second tab opens the way it does in any web app. The link never
 * carries `target="_blank"`: inside Nimbalyst's in-app browser every popup is
 * forwarded to the system browser, so a forced new tab sent each document
 * click out of the app.
 *
 * A row that has its own menu opens it on right-click, on the link itself:
 * that is where a right-click lands in a real browser, so a handler only on
 * the trailing actions button left the browser's link menu in its place. The
 * button shows only on hover or keyboard focus, like the shared docs list's row
 * actions: on every row at once it read as clutter.
 */
export declare function SharedDocumentLink({ href, onClick, onContextMenu, ...props }: Omit<ComponentProps<'a'>, 'href' | 'onClick' | 'onContextMenu'> & {
    href?: string | null;
    onClick?: MouseEventHandler<HTMLElement>;
    onContextMenu?: MouseEventHandler<HTMLElement>;
}): import("react").JSX.Element;

import type { ComponentProps, MouseEvent, MouseEventHandler } from 'react';
import { MaterialSymbol } from '@nimbalyst/runtime/ui/icons/MaterialSymbol';

/** A left click with no modifier: the one activation the host handles itself. */
function isPlainActivation(event: MouseEvent<HTMLElement>): boolean {
  return event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey;
}

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
export function SharedDocumentLink({ href, onClick, onContextMenu, ...props }: Omit<ComponentProps<'a'>, 'href' | 'onClick' | 'onContextMenu'> & { href?: string | null; onClick?: MouseEventHandler<HTMLElement>; onContextMenu?: MouseEventHandler<HTMLElement> }) {
  if (href) {
    const link = (
      <a
        {...props}
        href={href}
        onClick={(event) => {
          event.stopPropagation();
          if (!isPlainActivation(event)) return;
          event.preventDefault();
          onClick?.(event);
        }}
        onContextMenu={onContextMenu}
      />
    );
    if (!onContextMenu) return link;
    return <span className="shared-document-link-row group relative block">
      {link}
      <button
        type="button"
        className="shared-document-actions absolute right-1 top-1/2 flex -translate-y-1/2 items-center justify-center rounded border-none bg-transparent p-0.5 text-[var(--nim-text-faint)] opacity-0 transition-opacity hover:bg-[var(--nim-bg-hover)] hover:text-[var(--nim-text)] focus-visible:opacity-100 group-hover:opacity-100"
        aria-label="Document actions"
        title="More actions"
        onClick={(event) => { event.preventDefault(); event.stopPropagation(); onContextMenu(event); }}
      >
        <MaterialSymbol icon="more_horiz" size={16} />
      </button>
    </span>;
  }
  return <button {...props as ComponentProps<'button'>} type="button" onClick={(event) => { event.stopPropagation(); onClick?.(event); }} onContextMenu={onContextMenu} />;
}

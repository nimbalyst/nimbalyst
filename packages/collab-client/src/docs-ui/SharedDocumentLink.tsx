import type { ComponentProps, MouseEvent, MouseEventHandler } from 'react';

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
      />
    );
    if (!onContextMenu) return link;
    return <span className="shared-document-link-row relative block">
      {link}
      <button type="button" className="shared-document-actions absolute right-1 top-1/2 -translate-y-1/2 rounded px-1 bg-[var(--nim-bg)]" aria-label="Document actions" onClick={(event) => { event.preventDefault(); event.stopPropagation(); onContextMenu(event); }}>⋯</button>
    </span>;
  }
  return <button {...props as ComponentProps<'button'>} type="button" onClick={(event) => { event.stopPropagation(); onClick?.(event); }} onContextMenu={onContextMenu} />;
}

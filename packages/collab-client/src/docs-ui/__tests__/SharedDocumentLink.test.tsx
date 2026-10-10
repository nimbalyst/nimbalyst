import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { SharedDocumentLink } from '../SharedDocumentLink';

afterEach(cleanup);
it('opens through the host on a plain click, leaves modified clicks to the browser, and opens its own menu on right-click', () => {
  const open = vi.fn();
  const menu = vi.fn();
  render(<SharedDocumentLink href="/org/acme/project/a/document/b?blockId=q" onClick={open} onContextMenu={menu}>Question</SharedDocumentLink>);
  const link = screen.getByRole('link');
  // No forced new tab: inside the in-app browser a popup leaves the app.
  expect(link.getAttribute('target')).toBeNull();
  expect(link.getAttribute('href')).toContain('?blockId=q');
  fireEvent.click(link, { ctrlKey: true });
  fireEvent.click(link, { metaKey: true });
  fireEvent.click(link, { button: 1 });
  expect(open).not.toHaveBeenCalled();
  // A plain click is the host's: default prevented, open action run once.
  expect(fireEvent.click(link)).toBe(false);
  expect(open).toHaveBeenCalledTimes(1);
  // The right-click lands on the link, not on the actions button beside it.
  fireEvent.contextMenu(link);
  expect(menu).toHaveBeenCalledTimes(1);
});

/**
 * The Pages tab strip of this window, for code that runs outside React. Pages
 * mode publishes its strip per workspace; the agent's Set type reads it to put
 * the new typed page in the place of an open tab of the converted page, so
 * nobody keeps typing into a page that just went to Trash.
 */
import { useEffect, useRef } from 'react';
import type { useTabsActions } from '../../contexts/TabsContext';

export type PagesTabStrip = ReturnType<typeof useTabsActions>;

const strips = new Map<string, () => PagesTabStrip>();

export function usePublishPagesTabStrip(workspacePath: string, tabsActions: PagesTabStrip): void {
  // The actions object is rebuilt each render; publish a reader of the latest.
  const latest = useRef(tabsActions);
  latest.current = tabsActions;
  useEffect(() => {
    const read = () => latest.current;
    strips.set(workspacePath, read);
    return () => {
      if (strips.get(workspacePath) === read) strips.delete(workspacePath);
    };
  }, [workspacePath]);
}

/** The workspace's Pages tab strip, or null when Pages mode is not mounted. */
export function pagesTabStrip(workspacePath: string): PagesTabStrip | null {
  return strips.get(workspacePath)?.() ?? null;
}

/** Test seam: publish a strip without rendering Pages mode. */
export function setPagesTabStripForTest(workspacePath: string, strip: PagesTabStrip | null): void {
  if (strip) strips.set(workspacePath, () => strip);
  else strips.delete(workspacePath);
}

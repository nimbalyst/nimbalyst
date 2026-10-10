/**
 * The component side of `blockActions`: offers the actions whose handler is
 * set (a falsy entry is not offered right now). Handlers are read when an
 * action runs, so they can close over the latest render's state.
 */

import { useEffect, useRef } from 'react';
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext';
import type { NodeKey } from 'lexical';

import { registerBlockActions } from './blockActions';

export type BlockActionHandlers = Readonly<Record<string, (() => void) | null | undefined | false>>;

export function useBlockActions(nodeKey: NodeKey, handlers: BlockActionHandlers): void {
  const [editor] = useLexicalComposerContext();
  const latest = useRef(handlers);
  latest.current = handlers;
  useEffect(() => registerBlockActions(editor, nodeKey, {
    available: () => Object.keys(latest.current).filter((action) => typeof latest.current[action] === 'function'),
    run: (action) => {
      const handler = latest.current[action];
      if (typeof handler === 'function') handler();
    },
  }), [editor, nodeKey]);
}

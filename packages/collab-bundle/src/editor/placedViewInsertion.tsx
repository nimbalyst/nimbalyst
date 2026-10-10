/**
 * Placing views from the browser editor's slash menu: a table per type, a 2x2
 * for a type with two number fields, and the decisions and open questions
 * lists, the same entries the desktop publishes.
 *
 * Desktop finds a page's scope from its document path; here the mount knows
 * it: a team-room mount's page is that project's, so the inserted link is that
 * project's console view link (Decision 23). The insert command is registered
 * per editor with that scope, and only on a team-room mount whose host lists
 * its types (`placedViewTypes`).
 *
 * The slash-menu store is global, so entries are published while a capable
 * editor is mounted, the most recently mounted one's types winning, and
 * withdrawn when the last one unmounts.
 */

import React from 'react';
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext';
import { COMMAND_PRIORITY_EDITOR } from 'lexical';

import { registerExtensionEditorComponent } from '@nimbalyst/runtime/editor/extensions/extensionEditorComponentsStore';
import { setExtensionContributions } from '@nimbalyst/runtime/editor/extensions/extensionContributionsStore';
import { $insertPlacedView, INSERT_PLACED_VIEW_COMMAND } from '@nimbalyst/runtime/editor/plugins/EmbedPlugin/placedViewInsert';
import { buildPlacedViewCommandEntries } from '@nimbalyst/runtime/editor/plugins/EmbedPlugin/placedViewCommandEntries';
import type { UserCommand } from '@nimbalyst/runtime/editor/types/PluginTypes';

import type { PlacedViewTypeSource } from './types';

const SOURCE = 'browser-placed-view-insertion';

export interface BrowserPlacedViewInsertionValue {
  scope: { orgId: string; projectId: string };
  types: PlacedViewTypeSource;
}

export const BrowserPlacedViewInsertionContext = React.createContext<BrowserPlacedViewInsertionValue | null>(null);

/** Live mounts' entries, in mount order; the last one is published. */
const published = new Map<symbol, UserCommand[]>();

function publish(): void {
  const latest = [...published.values()].at(-1);
  setExtensionContributions(SOURCE, latest ? { userCommands: latest } : undefined);
}

function PlacedViewInsertion({ value }: { value: BrowserPlacedViewInsertionValue }): null {
  const [editor] = useLexicalComposerContext();
  const { orgId, projectId } = value.scope;

  React.useEffect(() => editor.registerCommand(
    INSERT_PLACED_VIEW_COMMAND,
    (payload) => $insertPlacedView({ ...payload, scope: payload.scope ?? { orgId, projectId } }),
    COMMAND_PRIORITY_EDITOR,
  ), [editor, orgId, projectId]);

  React.useEffect(() => {
    const token = Symbol(SOURCE);
    const refresh = () => {
      published.set(token, buildPlacedViewCommandEntries(value.types.list()));
      publish();
    };
    refresh();
    const stop = value.types.subscribe(refresh);
    return () => {
      stop();
      published.delete(token);
      publish();
    };
  }, [value.types]);

  return null;
}

export function BrowserPlacedViewInsertion(): React.JSX.Element | null {
  const value = React.useContext(BrowserPlacedViewInsertionContext);
  return value ? <PlacedViewInsertion value={value} /> : null;
}

let registered = false;

/** Publish the insertion into the editor's component slot. Idempotent; see `./referenceNodes` for why it is a call. */
export function registerBrowserPlacedViewInsertion(): void {
  if (registered) return;
  registered = true;
  registerExtensionEditorComponent({ name: SOURCE, Component: BrowserPlacedViewInsertion });
}

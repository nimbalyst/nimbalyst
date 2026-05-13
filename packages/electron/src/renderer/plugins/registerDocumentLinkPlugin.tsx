/**
 * Wire up the runtime's DocumentLinkPlugin against the electron document
 * service and publish it as a renderer-contributed Lexical UI plugin.
 *
 * The plugin's headless concerns (markdown transformers, the
 * `DocumentReferenceNode` registration) flow through the extension
 * contributions stores instead of the deleted `pluginRegistry`.
 */

import React, { useMemo } from 'react';
import { defineExtension } from 'lexical';
import {
  DocumentLinkPlugin,
  DocumentReferenceNode,
  DocumentReferenceTransformer,
  LegacyDocumentReferenceTransformer,
  TypeaheadMenuPlugin,
  registerExtensionEditorComponent,
  setExtensionContributions,
  setExtensionLexicalExtension,
  useAnchorElem,
} from '@nimbalyst/runtime';
import { ElectronRendererDocumentService } from '../services/ElectronDocumentService';

const SOURCE = 'document-link';
const documentService = new ElectronRendererDocumentService();

// Custom trigger function that allows dots and hyphens in filenames so
// `@README.md` and `@settings-atomwithstorage-rewrite.excalidraw` both
// keep the typeahead open as the user types. Punctuation that would end a
// reasonable filename token (parens, brackets, quotes, etc.) still ends
// the match so the menu closes when the user moves on to other prose.
function createDocumentLinkTrigger(trigger: string, { minLength = 0, maxLength = 75 }) {
  const FILENAME_TERMINATORS = String.raw`\,\+\*\?\$\|#{}\(\)\^\[\]\\\/!%'"~=<>:;`;
  return (text: string) => {
    const validChars = '[^' + trigger + FILENAME_TERMINATORS + '\\s]';
    const regex = new RegExp(
      '(^|\\s|\\()(' +
        '[' +
        trigger +
        ']' +
        '((?:' +
        validChars +
        '){0,' +
        maxLength +
        '})' +
        ')$',
    );
    const match = regex.exec(text);
    if (match !== null) {
      const maybeLeadingWhitespace = match[1];
      const matchingString = match[3];
      if (matchingString.length >= minLength) {
        return {
          leadOffset: match.index + maybeLeadingWhitespace.length,
          matchingString,
          replaceableString: match[2],
        };
      }
    }
    return null;
  };
}

function DocumentLinkPluginWrapper() {
  const triggerFn = useMemo(
    () => createDocumentLinkTrigger('@', { minLength: 0, maxLength: 75 }),
    [],
  );
  const anchorElem = useAnchorElem();
  return (
    <DocumentLinkPlugin
      documentService={documentService}
      TypeaheadMenuPlugin={TypeaheadMenuPlugin as React.ComponentType<unknown>}
      triggerFn={triggerFn}
      anchorElem={anchorElem || undefined}
    />
  );
}

export function registerDocumentLinkPlugin(): void {
  setExtensionLexicalExtension(
    SOURCE,
    defineExtension({
      name: '@nimbalyst/document-link',
      nodes: [DocumentReferenceNode],
    }),
  );
  setExtensionContributions(SOURCE, {
    markdownTransformers: [
      // Main transformer exports as markdown links; the legacy transformer
      // imports the old `[[wikilink]]`-style format produced before the
      // CommonMark migration.
      DocumentReferenceTransformer,
      LegacyDocumentReferenceTransformer,
    ],
  });
  registerExtensionEditorComponent({
    name: SOURCE,
    Component: DocumentLinkPluginWrapper as React.ComponentType<unknown>,
  });
}

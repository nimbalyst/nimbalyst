/**
 * Round-trip harness for fenced blocks (Phase 0 of the wiki widgets plan):
 * markdown -> Lexical -> markdown -> Lexical -> markdown, through the
 * headless node and transformer sets the collab worker and CLI load. Running
 * there proves two things at once: the node is headless-safe (an unregistered
 * node aborts the conversion), and the fence is byte-stable.
 *
 * Usage from a vitest file:
 *
 *   const trip = fenceRoundTrip(markdown);
 *   expect(trip.errors).toEqual([]);
 *   expect(trip.blockTypes).toContain('chart');
 *   expect(trip.exported).toBe(markdown);
 *   expect(trip.reexported).toBe(trip.exported);
 */

import type { Transformer } from '@lexical/markdown';
import { createHeadlessEditor } from '@lexical/headless';
import { $getRoot, type Klass, type LexicalEditor, type LexicalNode } from 'lexical';

import HeadlessBodyNodes from '../../../nodes/headlessBodyNodes';
import { getHeadlessBodyTransformers } from '../../../markdown/headlessBodyTransformers';
import { $convertFromEnhancedMarkdownString } from '../../../markdown/EnhancedMarkdownImport';
import { $convertToEnhancedMarkdownString } from '../../../markdown/EnhancedMarkdownExport';

export interface FenceRoundTripResult {
  /** The type of each top-level node after the first import. */
  blockTypes: string[];
  /** The text content of each top-level node after the first import (a fenced block's body). */
  blockTexts: string[];
  /** Markdown after one import/export. */
  exported: string;
  /** Markdown after importing `exported` into a fresh editor and exporting again. */
  reexported: string;
  /** Errors Lexical reported during either conversion (e.g. "Node chart is not registered"). */
  errors: string[];
}

export interface FenceRoundTripOptions {
  nodes?: ReadonlyArray<Klass<LexicalNode>>;
  transformers?: Transformer[];
  /** Node transforms to register on each editor, e.g. the embed upgrade rule the live editor runs. */
  setup?: (editor: LexicalEditor) => void;
}

function convert(markdown: string, nodes: ReadonlyArray<Klass<LexicalNode>>, transformers: Transformer[], errors: string[], setup?: (editor: LexicalEditor) => void) {
  const editor: LexicalEditor = createHeadlessEditor({
    namespace: 'fence-round-trip',
    nodes: [...nodes],
    onError: (error: Error) => errors.push(error.message),
  });
  setup?.(editor);
  editor.update(() => {
    $convertFromEnhancedMarkdownString(markdown, transformers, undefined, true, false);
  }, { discrete: true });
  let exported = '';
  let blockTypes: string[] = [];
  let blockTexts: string[] = [];
  editor.update(() => {
    blockTypes = $getRoot().getChildren().map((child) => child.getType());
    blockTexts = $getRoot().getChildren().map((child) => child.getTextContent());
    exported = $convertToEnhancedMarkdownString(transformers, { includeFrontmatter: false, shouldPreserveNewLines: true });
  }, { discrete: true });
  return { exported, blockTypes, blockTexts };
}

export function fenceRoundTrip(markdown: string, options: FenceRoundTripOptions = {}): FenceRoundTripResult {
  const nodes = options.nodes ?? HeadlessBodyNodes;
  const transformers = options.transformers ?? getHeadlessBodyTransformers();
  const errors: string[] = [];
  const first = convert(markdown, nodes, transformers, errors, options.setup);
  const second = convert(first.exported, nodes, transformers, errors, options.setup);
  return { blockTypes: first.blockTypes, blockTexts: first.blockTexts, exported: first.exported, reexported: second.exported, errors };
}

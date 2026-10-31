/**
 * Enhanced markdown export with frontmatter support.
 * This module extends Lexical's markdown export capabilities to support:
 * - Individual node export (not just root nodes)
 * - Frontmatter metadata export from root node state
 * - Proper handling of all node types
 *
 * Replaces the previous custom implementation in nodeMarkdownExport.ts
 */

import {
  $getRoot,
  $isDecoratorNode,
  $isElementNode,
  $isLineBreakNode,
  $isRootOrShadowRoot,
  $isTextNode,
  ElementNode,
  LexicalNode,
  TextNode,
  TextFormatType
} from 'lexical';

import type {
  ElementTransformer,
  MultilineElementTransformer,
  TextFormatTransformer,
  TextMatchTransformer,
  Transformer,
} from '@lexical/markdown';

import {
  $getFrontmatter,
  serializeWithFrontmatter,
  type FrontmatterData
} from './FrontmatterUtils';

import { $getDiffState, OriginalMarkdownState } from '../plugins/DiffPlugin/core/DiffState';
import { $getState } from 'lexical';

type UnclosedFormatTag = {
  format: TextFormatType;
  tag: string;
};

/**
 * Options for enhanced markdown export.
 */
export interface EnhancedExportOptions {
  shouldPreserveNewLines?: boolean;
  includeFrontmatter?: boolean;
  /**
   * When true, exports as if all diffs were rejected:
   * - Skips 'added' nodes
   * - Includes 'removed' nodes
   * - Uses original markdown for 'modified' nodes
   * Used for creating incremental-approval baseline tags
   */
  rejectMode?: boolean;
}

/**
 * The line span a top-level block occupies in the exported markdown. Used to
 * turn a file line number (from a `file.md:653` link) back into a node that can
 * be scrolled to. 1-based and inclusive on both ends.
 */
export interface MarkdownBlockLineRange {
  nodeKey: string;
  startLine: number;
  endLine: number;
}

/** One exported top-level block, as emitted by the export loop. */
interface ExportedBlock {
  nodeKey: string;
  /** The serialized text, including any separator newline the loop prepended. */
  piece: string;
}

/**
 * Resolve the frontmatter this document exports: the stored frontmatter merged
 * with any plan/decision status node's config. Shared so the line map computes
 * the same frontmatter -- and therefore the same line offset -- as the export.
 */
function $resolveExportFrontmatter(): FrontmatterData {
  let frontmatter = $getFrontmatter() || {};

  const children = $getRoot().getChildren();
  for (const child of children) {
    // Check if this is a PlanStatusNode (by type check, since we can't import it here)
    if (child.getType() === 'plan-status') {
      // Use exportJSON to get the node's config
      const exported = (child as any).exportJSON();
      if (exported && exported.config) {
        frontmatter = { ...frontmatter, planStatus: exported.config };
      }
      break; // Only process first PlanStatusNode
    }
    // Check if this is a DecisionStatusNode
    if (child.getType() === 'decision-status') {
      const exported = (child as any).exportJSON();
      if (exported && exported.config) {
        frontmatter = { ...frontmatter, decisionStatus: exported.config };
      }
      break; // Only process first DecisionStatusNode
    }
  }

  return frontmatter;
}

function countLines(value: string): number {
  return value.split('\n').length;
}

/**
 * Map each top-level block to the lines it occupies in the exported markdown.
 *
 * Built from the same export loop that produces the file's text, so the
 * separator rules stay in one place: getting the inter-block newline or the
 * frontmatter offset wrong here shifts every block below it, and a reveal that
 * lands a few blocks early still looks plausible.
 */
export function $buildMarkdownLineMap(
  transformers: Array<Transformer>,
  options: EnhancedExportOptions = {}
): MarkdownBlockLineRange[] {
  const {
    shouldPreserveNewLines = true,
    includeFrontmatter = true,
    rejectMode = false
  } = options;

  const blocks: ExportedBlock[] = [];
  const exportMarkdown = createEnhancedMarkdownExport(
    transformers,
    shouldPreserveNewLines,
    null,
    rejectMode,
    blocks,
  );
  const body = exportMarkdown($getRoot());

  // Frontmatter is prepended after the loop runs, so measure its height by
  // difference rather than re-deriving how it is formatted.
  let offset = 0;
  if (includeFrontmatter) {
    const frontmatter = $resolveExportFrontmatter();
    offset = countLines(serializeWithFrontmatter(body, frontmatter)) - countLines(body);
  }

  // Joining N pieces with a separator of K newlines puts each piece K-1 lines
  // further down than its own height alone would imply.
  const extraSeparatorLines = (shouldPreserveNewLines ? 1 : 2) - 1;

  const ranges: MarkdownBlockLineRange[] = [];
  let line = 1 + offset;
  for (const { nodeKey, piece } of blocks) {
    const height = countLines(piece);
    // The loop prepends a bare '\n' between consecutive non-empty blocks; that
    // blank line belongs to the gap, not to the block's content.
    const leadingBlank = piece.startsWith('\n') ? 1 : 0;
    ranges.push({
      nodeKey,
      startLine: line + leadingBlank,
      endLine: line + height - 1,
    });
    line += height + extraSeparatorLines;
  }

  return ranges;
}

/**
 * Convert the entire editor to markdown string with optional frontmatter.
 * This is the primary export for full document conversion.
 */
export function $convertToEnhancedMarkdownString(
  transformers: Array<Transformer>,
  options: EnhancedExportOptions = {}
): string {
  const {
    shouldPreserveNewLines = true,
    includeFrontmatter = true,
    rejectMode = false
  } = options;

  // Get the markdown content. We always go through the custom export path
  // because exportTextFormat encodes literal `*`/`_` adjacent to emphasis as
  // HTML numeric character references rather than backslash escapes; that
  // form survives upstream's CommonMark emphasis scanner on re-import,
  // whereas upstream's own escape-based exporter does not. Single-node
  // export and rejectMode still need the custom path for unrelated reasons.
  const markdownContent = $convertNodeToEnhancedMarkdownString(
    transformers,
    $getRoot(),
    shouldPreserveNewLines,
    rejectMode,
  );

  // Add frontmatter if requested and available
  if (includeFrontmatter) {
    return serializeWithFrontmatter(markdownContent, $resolveExportFrontmatter());
  }

  return markdownContent;
}

/**
 * Convert a single node to markdown string.
 * Unlike the standard $convertToMarkdownString, this properly handles individual nodes.
 */
export function $convertNodeToEnhancedMarkdownString(
  transformers: Array<Transformer>,
  node?: ElementNode | null,
  shouldPreserveNewLines: boolean = true,
  rejectMode: boolean = false,
): string {
  const exportMarkdown = createEnhancedMarkdownExport(
    transformers,
    shouldPreserveNewLines,
    null,
    rejectMode
  );
  return exportMarkdown(node);
}

/**
 * Convert selected content to markdown string.
 * This exports only the selected nodes.
 */
export function $convertSelectionToEnhancedMarkdownString(
  transformers: Array<Transformer>,
  selection: any,
  shouldPreserveNewLines: boolean = true,
): string {
  if (!selection) {
    return '';
  }

  const nodes = selection.getNodes();
  if (nodes.length === 0) {
    return '';
  }

  const exportMarkdown = createEnhancedMarkdownExport(
    transformers,
    shouldPreserveNewLines,
    null,
  );

  const output: string[] = [];
  const processedNodes = new Set<string>();

  for (const node of nodes) {
    let exportNode = node;
    while (exportNode.getParent() && !$isRootOrShadowRoot(exportNode.getParent()!)) {
      exportNode = exportNode.getParent()!;
    }

    const key = exportNode.getKey();
    if (processedNodes.has(key)) {
      continue;
    }
    processedNodes.add(key);

    const result = exportMarkdown(exportNode);
    if (result !== null) {
      output.push(result);
    }
  }

  return output.join('\n');
}

/**
 * Create an enhanced markdown export function with the provided transformers.
 * This properly handles individual nodes and maintains compatibility with standard Lexical export.
 */
function createEnhancedMarkdownExport(
  transformers: Array<Transformer>,
  shouldPreserveNewLines: boolean = true,
  selection: any = null,
  rejectMode: boolean = false,
  /** When provided, receives one entry per exported top-level block, in order. */
  blocksOut?: ExportedBlock[],
): (node?: ElementNode | null) => string {
  const byType = transformersByType(transformers);
  const isNewlineDelimited = !byType.multilineElement.length;

  // Only use single-format transformers and put code formats at the end
  const textFormatTransformers = byType.textFormat
    .filter((transformer) => transformer.format.length === 1)
    .sort((a, b) => {
      return (
        Number(a.format.includes('code')) - Number(b.format.includes('code'))
      );
    });

  const textMatchTransformers = byType.textMatch;
  const elementTransformers = [...byType.element, ...byType.multilineElement];

  return (node) => {
    const output: string[] = [];

    // Export a specific node if provided, otherwise export the entire document
    // HACK: TableNode incorrectly reports as root/shadow, so explicitly check for it
    if (node && (!$isRootOrShadowRoot(node) || node.getType() === 'table')) {
      // Export the single node directly
      const result = exportTopLevelElements(
        node,
        elementTransformers,
        textFormatTransformers,
        textMatchTransformers,
        shouldPreserveNewLines,
        selection,
        rejectMode,
      );

      if (result !== null) {
        output.push(result);
      }
    } else {
      // Standard behavior for root nodes
      const children = (node || $getRoot()).getChildren();

      for (let i = 0; i < children.length; i++) {
        const child = children[i];
        const result = exportTopLevelElements(
          child,
          elementTransformers,
          textFormatTransformers,
          textMatchTransformers,
          shouldPreserveNewLines,
          selection,
          rejectMode,
        );

        if (result !== null) {
          const piece =
            // separate consecutive group of texts with a line break
            isNewlineDelimited &&
              i > 0 &&
              !isEmptyParagraph(child) &&
              !isEmptyParagraph(children[i - 1])
              ? '\n'.concat(result)
              : result;
          output.push(piece);
          blocksOut?.push({ nodeKey: child.getKey(), piece });
        }
      }
    }

    // Join with appropriate separator based on newline preservation
    // When preserving newlines, empty paragraphs are already represented correctly
    return output.join(shouldPreserveNewLines ? '\n' : '\n\n');
  };
}

function exportTopLevelElements(
  node: LexicalNode,
  elementTransformers: Array<ElementTransformer | MultilineElementTransformer>,
  textFormatTransformers: Array<TextFormatTransformer>,
  textMatchTransformers: Array<TextMatchTransformer>,
  shouldPreserveNewLines: boolean = false,
  selection: any = null,
  rejectMode: boolean = false,
): string | null {
  const diffState = $getDiffState(node);

  if (rejectMode) {
    // In reject mode: export as if all diffs were rejected
    if (diffState === 'added') {
      // Skip added nodes - user doesn't want them
      return null;
    }

    // For 'removed' nodes and unmodified nodes, continue with normal export
  } else {
    // Normal mode: skip removed nodes (keep added/modified)
    if (diffState === 'removed') {
      return null;
    }
  }

  for (const transformer of elementTransformers) {
    if (!transformer.export) {
      continue;
    }

    const result = transformer.export(node, (_node) =>
      exportChildren(
        _node,
        textFormatTransformers,
        textMatchTransformers,
        undefined,
        undefined,
        shouldPreserveNewLines,
        elementTransformers,
        selection,
        rejectMode,
      ),
    );

    if (result != null) {
      return result;
    }
  }

  if ($isElementNode(node)) {
    return exportChildren(
      node,
      textFormatTransformers,
      textMatchTransformers,
      undefined,
      undefined,
      shouldPreserveNewLines,
      elementTransformers,
      selection,
      rejectMode,
    );
  } else if ($isDecoratorNode(node)) {
    // Decorator nodes at top level: just return text content as fallback
    // Element transformers were already checked above (lines 192-211)
    // Text match transformers will be checked if this decorator is a child in exportChildren
    return node.getTextContent();
  } else {
    return null;
  }
}

function exportChildren(
  node: ElementNode,
  textFormatTransformers: Array<TextFormatTransformer>,
  textMatchTransformers: Array<TextMatchTransformer>,
  textContent?: string,
  textTransformer?: TextFormatTransformer | null,
  shouldPreserveNewLines: boolean = false,
  elementTransformers?: Array<ElementTransformer | MultilineElementTransformer>,
  selection: any = null,
  rejectMode: boolean = false,
  unclosedTags?: Array<UnclosedFormatTag>,
  unclosableTags?: Array<UnclosedFormatTag>,
): string {
  const output = [];
  const children = node.getChildren();
  // The block-level call owns the tag stack and closes what is left at the end.
  const ownsTagStack = unclosedTags === undefined;
  const activeUnclosedTags = unclosedTags ?? [];
  const activeUnclosableTags = unclosableTags ?? [];

  mainLoop: for (const child of children) {
    const diffState = $getDiffState(child);

    if (rejectMode) {
      // In reject mode: skip added nodes, include removed nodes
      if (diffState === 'added') {
        continue;
      }
      // For modified nodes, the original markdown is handled at the node level
      // For removed nodes, continue with normal export
    } else {
      // Normal mode: skip removed nodes
      if (diffState === 'removed') {
        continue;
      }
    }
    if ($isLineBreakNode(child)) {
      if (shouldPreserveNewLines) {
        output.push('\n');
      }
    } else if ($isTextNode(child)) {
      const textContentForTransform =
        textContent || child.getTextContent();

      if (textTransformer) {
        // TextFormatTransformer doesn't have an export method
        // This appears to be a bug in the original code
        // For now, just push the text content
        output.push(textContentForTransform);
      } else {
        // First check for text format transformers
        const hasFormatting = child.getFormat() !== 0;
        let handled = false;

        if (hasFormatting) {
          const formattedText = exportTextFormat(
            child,
            textContentForTransform,
            textFormatTransformers,
            activeUnclosedTags,
            activeUnclosableTags,
            shouldPreserveNewLines,
          );
          output.push(formattedText);
          handled = true;
        } else {
          // A plain node still has to close any format a previous sibling
          // left open (e.g. bold that ran through a link). Without this the
          // closing marker drifts to the next formatted node.
          if (activeUnclosedTags.length > 0) {
            output.push(
              exportTextFormat(
                child,
                '',
                textFormatTransformers,
                activeUnclosedTags,
                activeUnclosableTags,
                shouldPreserveNewLines,
              ),
            );
          }

          // Text matching transformers for text nodes
          for (const transformer of textMatchTransformers) {
            if (!transformer.export) {
              continue;
            }
            const result = transformer.export(
              child,
              (_node: ElementNode, textContent?: string) =>
                exportChildren(
                  _node,
                  textFormatTransformers,
                  textMatchTransformers,
                  textContent,
                  textTransformer,
                  shouldPreserveNewLines,
                  elementTransformers,
                  selection,
                  rejectMode,
                  activeUnclosedTags,
                  [
                    ...activeUnclosableTags,
                    ...activeUnclosedTags,
                  ],
                ),
              (node: TextNode, textContent: string) =>
                exportTextFormat(
                  node,
                  textContent,
                  textFormatTransformers,
                  activeUnclosedTags,
                  activeUnclosableTags,
                  shouldPreserveNewLines,
                ),
            );

            if (result != null) {
              output.push(result);
              handled = true;
              continue mainLoop;
            }
          }
        }

        if (!handled) {
          output.push(escapeLiteralBackslashes(textContentForTransform));
        }
      }
    } else if ($isElementNode(child)) {
      // A format that covers all of an inline element's text and continues
      // into the text beside it (`**[a](u) more**`) is written outside the
      // element. Lexical stores it on the link's text, so without this the
      // span would be split into `[**a**](u) **more**`. A format confined to
      // the link exports as `[**a**](u)`, the more common source form.
      if (child.isInline()) {
        output.push(
          openFormatsCoveringInline(
            child,
            textFormatTransformers,
            activeUnclosedTags,
          ),
        );
      }

      // First check if any text-match transformer handles this element node (like LINK for LinkNode)
      let handled = false;
      for (const transformer of textMatchTransformers) {
        if (!transformer.export) {
          continue;
        }
        const result = transformer.export(
          child,
          (_node: ElementNode) =>
            exportChildren(
              _node,
              textFormatTransformers,
              textMatchTransformers,
              undefined,
              undefined,
              shouldPreserveNewLines,
              elementTransformers,
              selection,
              rejectMode,
              activeUnclosedTags,
              [
                ...activeUnclosableTags,
                ...activeUnclosedTags,
              ],
            ),
          (node: TextNode, textContent: string) =>
            exportTextFormat(
              node,
              textContent,
              textFormatTransformers,
              activeUnclosedTags,
              activeUnclosableTags,
              shouldPreserveNewLines,
            ),
        );

        if (result != null) {
          output.push(result);
          handled = true;
          break;
        }
      }

      if (!handled) {
        const result = exportTopLevelElements(
          child,
          elementTransformers || [],
          textFormatTransformers,
          textMatchTransformers,
          shouldPreserveNewLines,
          selection,
          rejectMode,
        );

        if (result != null) {
          output.push(result);
        }
      }
    } else if ($isDecoratorNode(child)) {
      // Try text match transformers first (like IMAGE_TRANSFORMER)
      let handled = false;
      for (const transformer of textMatchTransformers) {
        if (!transformer.export) {
          continue;
        }
        const result = transformer.export(
          child,
          (_node: ElementNode) =>
            exportChildren(
              _node,
              textFormatTransformers,
              textMatchTransformers,
              undefined,
              undefined,
              shouldPreserveNewLines,
              elementTransformers,
              selection,
              rejectMode,
              activeUnclosedTags,
              [
                ...activeUnclosableTags,
                ...activeUnclosedTags,
              ],
            ),
          (node: TextNode, textContent: string) =>
            exportTextFormat(
              node,
              textContent,
              textFormatTransformers,
              activeUnclosedTags,
              activeUnclosableTags,
              shouldPreserveNewLines,
            ),
        );

        if (result != null) {
          output.push(result);
          handled = true;
          break;
        }
      }

      // If no text match transformer handled it, try element transformers (like MermaidNode)
      if (!handled && elementTransformers) {
        for (const transformer of elementTransformers) {
          const result = transformer.export?.(child, () => '');
          if (result != null) {
            output.push(result);
            handled = true;
            break;
          }
        }
      }

      // If still no transformer handled it, just return text content (Lexical's default behavior)
      if (!handled) {
        output.push(child.getTextContent());
      }
    }
  }

  if (ownsTagStack && activeUnclosedTags.length > 0) {
    // A format still open at the end of the block (bold ending in a link)
    // closes here; leaving it open would bleed into the next block.
    for (let i = activeUnclosedTags.length - 1; i >= 0; i--) {
      output.push(activeUnclosedTags[i].tag);
    }
    activeUnclosedTags.length = 0;
  }

  return output.join('');
}

function openFormatsCoveringInline(
  element: ElementNode,
  textTransformers: Array<TextFormatTransformer>,
  unclosedTags: Array<UnclosedFormatTag>,
): string {
  const textNodes = element.getAllTextNodes();
  if (textNodes.length === 0) {
    return '';
  }
  let opening = '';
  const seen = new Set<TextFormatType>();
  for (const transformer of textTransformers) {
    const format = transformer.format[0];
    if (format === 'code' || seen.has(format)) {
      continue;
    }
    seen.add(format);
    if (
      textNodes.every((textNode) => textNode.hasFormat(format)) &&
      !unclosedTags.find((entry) => entry.format === format) &&
      (hasTextFormat(getAdjacentText(element, true), format) ||
        hasTextFormat(getAdjacentText(element, false), format))
    ) {
      unclosedTags.push({ format, tag: transformer.tag });
      opening += transformer.tag;
    }
  }
  return opening;
}

/**
 * A backslash before ASCII punctuation is a CommonMark escape, so a literal
 * one there must be written `\\` or the importer drops it on every save.
 * Other backslashes (`C:\Users`) are literal already and stay as written.
 */
function escapeLiteralBackslashes(text: string): string {
  return text.replace(/\\(?=[!-/:-@[-`{-~])/g, '\\\\');
}

function getAdjacentText(
  element: ElementNode,
  backward: boolean,
): TextNode | null {
  const sibling = backward
    ? element.getPreviousSibling()
    : element.getNextSibling();
  if ($isTextNode(sibling)) {
    return sibling;
  }
  if ($isElementNode(sibling) && sibling.isInline()) {
    const descendant = backward
      ? sibling.getLastDescendant()
      : sibling.getFirstDescendant();
    return $isTextNode(descendant) ? descendant : null;
  }
  return null;
}

function exportTextFormat(
  node: TextNode,
  textContent: string,
  textTransformers: Array<TextFormatTransformer>,
  unclosedTags: Array<UnclosedFormatTag>,
  unclosableTags: Array<UnclosedFormatTag>,
  shouldPreserveNewLines: boolean = false,
): string {
  let output = textContent;

  if (!node.hasFormat('code')) {
    output = escapeLiteralBackslashes(output);
    if (shouldPreserveNewLines) {
      // Use HTML numeric character references for emphasis-relevant punctuation
      // (`*` and `_`) rather than backslash escapes. Upstream Lexical's
      // CommonMark emphasis scanner classifies `\` as non-punctuation, so a
      // backslash escape next to a delimiter run breaks the flanking check
      // and the surrounding emphasis fails to re-import. NCRs are inert to
      // the delimiter scanner and are unescaped back to literal characters
      // by unescapeText, so a literal `*` adjacent to bold/italic markers
      // round-trips losslessly.
      output = output
        .replace(/\*/g, '&#42;')
        .replace(/_/g, '&#95;')
        .replace(/([`~])/g, '\\$1');
    } else {
      output = output.replace(/([*_`~])/g, '\\$1');
    }
  }

  let leadingSpace: string;
  let trimmedOutput: string;
  let trailingSpace: string;
  let isWhitespaceOnly: boolean;

  if (node.hasFormat('code')) {
    // Inline code is an atomic literal span whose fence is derived from its
    // content (CommonMark: one backtick longer than the longest run inside),
    // so content containing backticks survives. Other formats wrap around it.
    // Adjacent code nodes with identical formatting (the diff editor splits a
    // span into added and unchanged parts) are one span: separate fences
    // would touch (`a``b`) and re-parse as something else.
    const prevCode = getCodeRunSibling(node, true);
    const nextCode = getCodeRunSibling(node, false);
    let runText = textContent;
    for (let n = prevCode; n; n = getCodeRunSibling(n, true)) {
      runText = n.getTextContent() + runText;
    }
    for (let n = nextCode; n; n = getCodeRunSibling(n, false)) {
      runText += n.getTextContent();
    }
    const {fence, padded} = getCodeSpanDelimiter(runText);
    const pad = padded.length > runText.length ? ' ' : '';
    leadingSpace = '';
    trimmedOutput =
      (prevCode ? '' : fence + pad) + textContent + (nextCode ? '' : pad + fence);
    trailingSpace = '';
    isWhitespaceOnly = false;
  } else {
    const match = output.match(/^(\s*)(.*?)(\s*)$/s) || ['', '', output, ''];
    leadingSpace = match[1];
    trimmedOutput = match[2];
    trailingSpace = match[3];
    isWhitespaceOnly = trimmedOutput === '';
  }

  let openingTags = '';
  let closingTagsBefore = '';
  let closingTagsAfter = '';
  const previousTextNode = getTextSibling(node, true);
  const nextTextNode = getTextSibling(node, false);
  const appliedFormats = new Set<TextFormatType>();

  for (const transformer of textTransformers) {
    const format = transformer.format[0];
    const tag = transformer.tag;

    // The code fence is emitted above, not as a static tag.
    if (format === 'code') {
      continue;
    }

    if (hasTextFormat(node, format) && !appliedFormats.has(format)) {
      appliedFormats.add(format);

      // Continuity check: use the raw format bit on the previous sibling, not
      // shouldTrackAsFormattedSibling. The latter treats whitespace-only
      // siblings as "no format", which conflates two questions: "should we
      // wrap THIS node in emphasis markers" (whitespace flanking rule), and
      // "is the format already open going into this node" (continuity).
      // Filtering whitespace-only siblings here caused duplicate `unclosedTags`
      // entries when a triple-nested format span ran across a whitespace-only
      // text node (e.g. `~~strike *italic **bold** text* inside~~`), which
      // the close loop then popped as extra closing markers, corrupting
      // emphasis output.
      // A tag open outside the enclosing inline element (see
      // openFormatsCoveringInline) already covers this node.
      if (
        !unclosableTags.find((entry) => entry.tag === tag) &&
        (!hasTextFormat(previousTextNode, format) ||
          !unclosedTags.find((entry) => entry.tag === tag))
      ) {
        unclosedTags.push({ format, tag });
        openingTags += tag;
      }
    }
  }

  // getTextSibling looks past the end of an inline parent such as a link.
  // A tag opened inside that parent cannot stay open across its boundary
  // (`[**a](u) b**` is not emphasis), so for those tags the next node does not
  // count as a continuation. Tags opened before the parent are in
  // `unclosableTags` and are closed after it instead.
  const parent = node.getParent();
  const nextLeavesInlineParent =
    nextTextNode !== null &&
    parent !== null &&
    parent.isInline() &&
    !parent.isParentOf(nextTextNode);

  for (let i = 0; i < unclosedTags.length; i++) {
    const currentTag = unclosedTags[i];
    const nodeHasFormat = hasTextFormat(node, currentTag.format);
    const nextNodeHasFormat =
      hasTextFormat(nextTextNode, currentTag.format) &&
      !(
        nextLeavesInlineParent &&
        !unclosableTags.find((entry) => entry.tag === currentTag.tag)
      );

    if (nodeHasFormat && nextNodeHasFormat) {
      continue;
    }

    const remainingTags = [...unclosedTags];
    while (remainingTags.length > i) {
      const tagToClose = remainingTags.pop();
      if (
        tagToClose &&
        unclosableTags.find((entry) => entry.tag === tagToClose.tag)
      ) {
        continue;
      }

      if (tagToClose) {
        if (!nodeHasFormat) {
          closingTagsBefore += tagToClose.tag;
        } else if (!nextNodeHasFormat) {
          closingTagsAfter += tagToClose.tag;
        }
      }
      unclosedTags.pop();
    }
    break;
  }

  if (isWhitespaceOnly && !node.hasFormat('code')) {
    return closingTagsBefore + output;
  }

  return (
    closingTagsBefore +
    leadingSpace +
    openingTags +
    trimmedOutput +
    closingTagsAfter +
    trailingSpace
  );
}

function getCodeRunSibling(node: TextNode, backward: boolean): TextNode | null {
  const sibling = backward ? node.getPreviousSibling() : node.getNextSibling();
  return $isTextNode(sibling) &&
    sibling.hasFormat('code') &&
    sibling.getFormat() === node.getFormat()
    ? sibling
    : null;
}

/** Same rule as upstream @lexical/markdown 0.53 (not exported there). */
function getCodeSpanDelimiter(content: string): {
  fence: string;
  padded: string;
} {
  const backtickRuns = content.match(/`+/g);
  const longestRun = backtickRuns
    ? Math.max(...backtickRuns.map((run) => run.length))
    : 0;
  const fence = '`'.repeat(longestRun + 1);
  const needsPadding =
    content.length === 0 ||
    content.includes('`') ||
    (/^\s/.test(content) && /\s$/.test(content));
  return { fence, padded: needsPadding ? ` ${content} ` : content };
}

function isEmptyParagraph(node: LexicalNode): boolean {
  if (!$isElementNode(node)) {
    return false;
  }

  const children = node.getChildren();
  if (children.length === 0) {
    return true;
  }

  if (children.length === 1) {
    const child = children[0];
    if ($isTextNode(child) && child.getTextContent().trim() === '') {
      return true;
    }
  }

  return false;
}

function transformersByType(transformers: Array<Transformer>) {
  const byType: {
    element: Array<ElementTransformer>;
    multilineElement: Array<MultilineElementTransformer>;
    textFormat: Array<TextFormatTransformer>;
    textMatch: Array<TextMatchTransformer>;
  } = {
    element: [],
    multilineElement: [],
    textFormat: [],
    textMatch: [],
  };

  for (const transformer of transformers) {
    const type = transformer.type;
    if (type === 'element') {
      byType.element.push(transformer as ElementTransformer);
    } else if (type === 'multiline-element') {
      byType.multilineElement.push(transformer as MultilineElementTransformer);
    } else if (type === 'text-format') {
      byType.textFormat.push(transformer as TextFormatTransformer);
    } else if (type === 'text-match') {
      byType.textMatch.push(transformer as TextMatchTransformer);
    }
  }

  return byType;
}

function getTextSibling(node: TextNode, backward: boolean): TextNode | null {
  let sibling = backward ? node.getPreviousSibling() : node.getNextSibling();

  if (!sibling) {
    const parent = node.getParent();
    if (parent?.isInline()) {
      sibling = backward ? parent.getPreviousSibling() : parent.getNextSibling();
    }
  }

  while (sibling) {
    if ($isElementNode(sibling)) {
      if (!sibling.isInline()) {
        break;
      }

      const descendant = backward
        ? sibling.getLastDescendant()
        : sibling.getFirstDescendant();
      if ($isTextNode(descendant)) {
        return descendant;
      }

      sibling = backward ? sibling.getPreviousSibling() : sibling.getNextSibling();
      continue;
    }

    if ($isTextNode(sibling)) {
      return sibling;
    }

    break;
  }

  return null;
}

function hasTextFormat(
  node: LexicalNode | null | undefined,
  format: TextFormatType,
): boolean {
  return $isTextNode(node) && node.hasFormat(format);
}

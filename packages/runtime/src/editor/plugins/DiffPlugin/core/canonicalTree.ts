import type {Transformer} from '@lexical/markdown';
import {
  $getState,
  $isDecoratorNode,
  $isElementNode,
  $isTextNode,
  type LexicalNode,
  type SerializedLexicalNode,
} from 'lexical';
import {TABLE_TRANSFORMER} from '../../TablePlugin/TableTransformer';
import {LiveNodeKeyState} from './DiffState';
import {getEditorTransformers, $convertToEnhancedMarkdownString} from '../../../markdown';

// CanonicalTreeNode is compatible with ThresholdNode (N) from ThresholdedOrderPreservingTree
// Core fields (id, type, text, attrs, children) match exactly
// Additional fields (key, liveNodeKey, serialized) are for Lexical tracking
export type CanonicalTreeNode = {
  id: number;                           // sequential ID (matches N.id)
  type: string;                         // node type (matches N.type)
  text?: string;                        // text content (matches N.text)
  attrs?: Record<string, any>;          // node attributes (matches N.attrs)
  children?: CanonicalTreeNode[];       // child nodes (matches N.children)

  // Lexical-specific fields (not in N)
  key: string;                          // Lexical node key
  liveNodeKey?: string;                 // live node tracking
  serialized: SerializedLexicalNode;   // full serialized node
};

function stableCanonicalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => stableCanonicalize(item));
  }

  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).filter(
      ([, v]) => v !== undefined,
    );

    entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));

    const result: Record<string, unknown> = {};
    for (const [key, val] of entries) {
      result[key] = stableCanonicalize(val);
    }
    return result;
  }

  return value;
}

function extractAttrs(serialized: SerializedLexicalNode): Record<string, any> | undefined {
  const {children, text, detail, format, mode, $, ...rest} =
    serialized as Record<string, unknown>;

  const attrs: Record<string, any> = {...rest};

  // CRITICAL: Normalize direction attribute
  // "ltr" and null are both left-to-right and should be treated as equivalent
  // This prevents false positives where only the direction attribute differs
  if (attrs.direction === 'ltr' || attrs.direction === null) {
    delete attrs.direction;
  }

  // CRITICAL: Exclude `detail` and `mode` for HashtagNode specifically
  // These are implementation details that shouldn't affect whether hashtag nodes are "the same":
  // - `detail`: Internal flags like IS_DIRECTIONLESS, IS_UNMERGEABLE, etc.
  // - `mode`: Editor mode (normal, token, segmented, inert)
  // This fixes the HashtagNode bug where identical hashtags (#idea) were shown as removed+added
  // just because their detail/mode attributes differed.
  //
  // We DO include `format` because it represents meaningful formatting (bold, italic, etc.)
  // that should affect node equality.
  //
  // We ONLY do this for 'hashtag' type to avoid breaking other node types (tables, etc.)
  const nodeType = (serialized as any).type as string;
  const isHashtagNode = nodeType === 'hashtag';

  // Debug logging for hashtag nodes (commented out - enable for debugging)
  // if (isHashtagNode) {
  //   console.log(`[extractAttrs] Processing hashtag node:`);
  //   console.log(`  text: "${(serialized as any).text}"`);
  //   console.log(`  detail (excluded): ${detail}`);
  //   console.log(`  format (included): ${format}`);
  //   console.log(`  mode (excluded): ${mode}`);
  //   console.log(`  other attrs:`, JSON.stringify(rest, null, 2));
  // }

  if (detail !== undefined && !isHashtagNode) {
    attrs.detail = detail;
  }
  if (format !== undefined) {
    attrs.format = format;
  }
  if (mode !== undefined && !isHashtagNode) {
    attrs.mode = mode;
  }

  // CRITICAL: Exclude $ field which contains internal metadata like liveNodeKey
  // The $ field is for internal tracking and should not affect similarity comparison

  const canonicalized = stableCanonicalize(attrs);
  return canonicalized as Record<string, any>;
}

// Normalize table separator rows to a canonical format
// This prevents false diffs from whitespace variations in table separators
// Examples: "|---|---|---|" and "| --- | --- | --- |" both normalize to "|---|---|---|"
function normalizeTableSeparator(text: string): string {
  // Match table separator pattern: |, optional spaces, dashes/colons, optional spaces, |
  const tableSepRegex = /^(\|\s*:?-+:?\s*)+\|$/;
  if (tableSepRegex.test(text)) {
    // Count the number of columns (number of | chars minus 1)
    const cols = (text.match(/\|/g) || []).length - 1;
    // Return normalized format: |---|---|...|
    const normalized = '|' + Array(cols).fill('---').join('|') + '|';
    // if (text !== normalized) {
    //   console.log('[canonicalTree] Normalizing table separator:', text, '→', normalized);
    // }
    return normalized;
  }
  return text;
}

function extractText(
  node: LexicalNode,
  serialized: SerializedLexicalNode,
): string | undefined {
  if ($isTextNode(node)) {
    const text = (serialized as any).text ?? '';
    // Normalize table separators in text nodes too
    const normalized = normalizeTableSeparator(text);
    return normalized || undefined;
  }

  if ($isDecoratorNode(node)) {
    const text = node.getTextContent();
    return text || undefined;
  }

  if ($isElementNode(node)) {
    // For element nodes with direct text children, use that text
    let directText = '';
    const children = node.getChildren();
    for (const child of children) {
      if ($isTextNode(child)) {
        directText += child.getTextContent();
      }
    }

    if (directText) {
      const normalized = normalizeTableSeparator(directText);
      return normalized || undefined;
    }

    // For element nodes without direct text (e.g., list wrapper nodes),
    // use the full text content to distinguish between different nested structures
    // This allows TOPT to match based on what's actually inside the node
    const fullText = node.getTextContent();
    if (fullText) {
      return fullText;
    }

    return undefined;
  }

  if ('text' in serialized && typeof (serialized as any).text === 'string') {
    const text = (serialized as any).text;
    const normalized = normalizeTableSeparator(text);
    return normalized || undefined;
  }

  const text = node.getTextContent();
  const normalized = normalizeTableSeparator(text);
  return normalized || undefined;
}

export function buildCanonicalTree(
  node: LexicalNode,
  idCounter: { value: number }
): CanonicalTreeNode {
  const id = idCounter.value++;
  const serialized = node.exportJSON() as SerializedLexicalNode & {
    __key?: string;
    __liveKey?: string;
  };
  const attrs = extractAttrs(serialized);
  const text = extractText(node, serialized);
  const liveNodeKey = $getState(node, LiveNodeKeyState) || undefined;

  serialized.__key = node.getKey();
  if (liveNodeKey) {
    serialized.__liveKey = liveNodeKey;
  }

  const children: CanonicalTreeNode[] = [];
  if ($isElementNode(node)) {
    for (const child of node.getChildren()) {
      children.push(buildCanonicalTree(child, idCounter));
    }
  }

  // CRITICAL FIX: Update serialized.children to match the canonical children
  // Without this, serialized nodes have empty children arrays even when the
  // CanonicalTreeNode has populated children. This causes content to disappear
  // when diff operations are applied because they use the serialized nodes.
  if ('children' in serialized && children.length > 0) {
    serialized.children = children.map(c => c.serialized);
  }

  return {
    id,
    key: node.getKey(),
    type: node.getType(),
    text,
    attrs,
    liveNodeKey,
    serialized,
    children,
  };
}

export function canonicalizeForest(
  rootChildren: LexicalNode[],
): CanonicalTreeNode[] {
  const idCounter = { value: 0 };
  return rootChildren.map((child) => buildCanonicalTree(child, idCounter));
}

export function levenshteinDistance(a: string, b: string): number {
  if (a === b) {
    return 0;
  }

  // Simple Levenshtein implementation
  const m = a.length;
  const n = b.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));

  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;

  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (a[i - 1] === b[j - 1]) {
        dp[i][j] = dp[i - 1][j - 1];
      } else {
        dp[i][j] = Math.min(
          dp[i - 1][j] + 1,     // deletion
          dp[i][j - 1] + 1,     // insertion
          dp[i - 1][j - 1] + 1  // substitution
        );
      }
    }
  }

  return dp[m][n];
}

export function getDiffTransformers(): Transformer[] {
  const transformers = getEditorTransformers();
  return transformers.includes(TABLE_TRANSFORMER)
    ? transformers
    : [...transformers, TABLE_TRANSFORMER];
}

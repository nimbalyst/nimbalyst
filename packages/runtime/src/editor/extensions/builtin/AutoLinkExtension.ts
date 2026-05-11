/**
 * Forked from `@lexical/react/LexicalAutoLinkPlugin` (and its v0.34-era
 * predecessor) so we can drop two classes of bogus auto-links that crashed
 * the editor in earlier Nimbalyst releases:
 *
 * 1. Pasted base64 image data URIs were sometimes long enough to match the
 *    URL regex and would be wrapped in giant `<a>` nodes that the diff
 *    system couldn't reconcile.
 * 2. Any `data:` URL was getting auto-linked even when the user clearly
 *    didn't want it (pasted screenshots, copied SVGs).
 *
 * Both are filtered at the matcher level so the rest of the pipeline
 * (export, history, collab) never sees the link node at all. The
 * `MAX_URL_LENGTH` is intentionally smaller than the LinkNode size limits
 * so we trip early.
 *
 * Headless extension (Phase 7.3/7.4). Replaces the prior React-component
 * `AutoLinkPlugin` mounted in Editor.tsx. The upstream
 * `@lexical/link/AutoLinkExtension` does NOT include this filter, which is
 * why we keep our fork instead of consuming the upstream extension
 * directly.
 */

import {
  $createAutoLinkNode,
  $isAutoLinkNode,
  $isLinkNode,
  AutoLinkNode,
  TOGGLE_LINK_COMMAND,
  type AutoLinkAttributes,
} from '@lexical/link';
import { mergeRegister } from '@lexical/utils';
import {
  $createTextNode,
  $getSelection,
  $isElementNode,
  $isLineBreakNode,
  $isNodeSelection,
  $isRangeSelection,
  $isTextNode,
  COMMAND_PRIORITY_LOW,
  type ElementNode,
  type LexicalEditor,
  type LexicalNode,
  TextNode,
  defineExtension,
} from 'lexical';

type ChangeHandler = (url: string | null, prevUrl: string | null) => void;

export type LinkMatcherResult = {
  attributes?: AutoLinkAttributes;
  index: number;
  length: number;
  text: string;
  url: string;
};

export type LinkMatcher = (text: string) => LinkMatcherResult | null;

// URLs longer than this are skipped -- catches base64 data URIs that
// accidentally match the URL regex.
const MAX_URL_LENGTH = 500;

export function createLinkMatcherWithRegExp(
  regExp: RegExp,
  urlTransformer: (text: string) => string = (text) => text,
): LinkMatcher {
  return (text: string) => {
    const match = regExp.exec(text);
    if (match === null) return null;
    const matchedText = match[0];
    if (matchedText.length > MAX_URL_LENGTH) return null;
    const url = urlTransformer(matchedText);
    if (url.startsWith('data:')) return null;
    return {
      index: match.index,
      length: matchedText.length,
      text: matchedText,
      url,
    };
  };
}

const URL_REGEX =
  /((https?:\/\/(www\.)?)|(www\.))[-a-zA-Z0-9@:%._+~#=]{1,256}\.[a-zA-Z0-9()]{1,6}([-a-zA-Z0-9()@:%_+.~#?&//=]*)(?<![-.+:%])/;

const EMAIL_REGEX =
  /(([^<>()[\]\\.,;:\s@"]+(\.[^<>()[\]\\.,;:\s@"]+)*)|(".+"))@((\[[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\])|(([a-zA-Z\-0-9]+\.)+[a-zA-Z]{2,}))/;

export const DEFAULT_AUTOLINK_MATCHERS: LinkMatcher[] = [
  createLinkMatcherWithRegExp(URL_REGEX, (text) =>
    text.startsWith('http') ? text : `https://${text}`,
  ),
  createLinkMatcherWithRegExp(EMAIL_REGEX, (text) => `mailto:${text}`),
];

const PUNCTUATION_OR_SPACE = /[.,;\s]/;

function isSeparator(char: string): boolean {
  return PUNCTUATION_OR_SPACE.test(char);
}

function endsWithSeparator(textContent: string): boolean {
  return isSeparator(textContent[textContent.length - 1]);
}

function startsWithSeparator(textContent: string): boolean {
  return isSeparator(textContent[0]);
}

function startsWithTLD(textContent: string, isEmail: boolean): boolean {
  if (isEmail) {
    return /^\.[a-zA-Z]{2,}/.test(textContent);
  }
  return /^\.[a-zA-Z0-9]{1,}/.test(textContent);
}

function isPreviousNodeValid(node: LexicalNode): boolean {
  let previousNode = node.getPreviousSibling();
  if ($isElementNode(previousNode)) {
    previousNode = previousNode.getLastDescendant();
  }
  return (
    previousNode === null ||
    $isLineBreakNode(previousNode) ||
    ($isTextNode(previousNode) &&
      endsWithSeparator(previousNode.getTextContent()))
  );
}

function isNextNodeValid(node: LexicalNode): boolean {
  let nextNode = node.getNextSibling();
  if ($isElementNode(nextNode)) {
    nextNode = nextNode.getFirstDescendant();
  }
  return (
    nextNode === null ||
    $isLineBreakNode(nextNode) ||
    ($isTextNode(nextNode) && startsWithSeparator(nextNode.getTextContent()))
  );
}

function isContentAroundIsValid(
  matchStart: number,
  matchEnd: number,
  text: string,
  nodes: TextNode[],
): boolean {
  const contentBeforeIsValid =
    matchStart > 0
      ? isSeparator(text[matchStart - 1])
      : isPreviousNodeValid(nodes[0]);
  if (!contentBeforeIsValid) return false;

  const contentAfterIsValid =
    matchEnd < text.length
      ? isSeparator(text[matchEnd])
      : isNextNodeValid(nodes[nodes.length - 1]);
  return contentAfterIsValid;
}

function extractMatchingNodes(
  nodes: TextNode[],
  startIndex: number,
  endIndex: number,
): [number, TextNode[], TextNode[], TextNode[]] {
  const unmodifiedBeforeNodes: TextNode[] = [];
  const matchingNodes: TextNode[] = [];
  const unmodifiedAfterNodes: TextNode[] = [];
  let matchingOffset = 0;
  let currentOffset = 0;
  const currentNodes = [...nodes];

  while (currentNodes.length > 0) {
    const currentNode = currentNodes[0];
    const currentNodeText = currentNode.getTextContent();
    const currentNodeLength = currentNodeText.length;
    const currentNodeStart = currentOffset;
    const currentNodeEnd = currentOffset + currentNodeLength;

    if (currentNodeEnd <= startIndex) {
      unmodifiedBeforeNodes.push(currentNode);
      matchingOffset += currentNodeLength;
    } else if (currentNodeStart >= endIndex) {
      unmodifiedAfterNodes.push(currentNode);
    } else {
      matchingNodes.push(currentNode);
    }
    currentOffset += currentNodeLength;
    currentNodes.shift();
  }
  return [matchingOffset, unmodifiedBeforeNodes, matchingNodes, unmodifiedAfterNodes];
}

function $createAutoLinkNode_(
  nodes: TextNode[],
  startIndex: number,
  endIndex: number,
  match: LinkMatcherResult,
): TextNode | undefined {
  const linkNode = $createAutoLinkNode(match.url, match.attributes);
  if (nodes.length === 1) {
    let remainingTextNode = nodes[0];
    let linkTextNode;
    if (startIndex === 0) {
      [linkTextNode, remainingTextNode] = remainingTextNode.splitText(endIndex);
    } else {
      [, linkTextNode, remainingTextNode] = remainingTextNode.splitText(
        startIndex,
        endIndex,
      );
    }
    const textNode = $createTextNode(match.text);
    textNode.setFormat(linkTextNode.getFormat());
    textNode.setDetail(linkTextNode.getDetail());
    textNode.setStyle(linkTextNode.getStyle());
    linkNode.append(textNode);
    linkTextNode.replace(linkNode);
    return remainingTextNode;
  } else if (nodes.length > 1) {
    const firstTextNode = nodes[0];
    let offset = firstTextNode.getTextContent().length;
    let firstLinkTextNode;
    if (startIndex === 0) {
      firstLinkTextNode = firstTextNode;
    } else {
      [, firstLinkTextNode] = firstTextNode.splitText(startIndex);
    }
    const linkNodes = [];
    let remainingTextNode;
    for (let i = 1; i < nodes.length; i++) {
      const currentNode = nodes[i];
      const currentNodeText = currentNode.getTextContent();
      const currentNodeLength = currentNodeText.length;
      const currentNodeStart = offset;
      const currentNodeEnd = offset + currentNodeLength;
      if (currentNodeStart < endIndex) {
        if (currentNodeEnd <= endIndex) {
          linkNodes.push(currentNode);
        } else {
          const [linkTextNode, endNode] = currentNode.splitText(
            endIndex - currentNodeStart,
          );
          linkNodes.push(linkTextNode);
          remainingTextNode = endNode;
        }
      }
      offset += currentNodeLength;
    }
    const selection = $getSelection();
    const selectedTextNode = selection
      ? selection.getNodes().find($isTextNode)
      : undefined;
    const textNode = $createTextNode(firstLinkTextNode.getTextContent());
    textNode.setFormat(firstLinkTextNode.getFormat());
    textNode.setDetail(firstLinkTextNode.getDetail());
    textNode.setStyle(firstLinkTextNode.getStyle());
    linkNode.append(textNode, ...linkNodes);
    if (selectedTextNode && selectedTextNode === firstLinkTextNode) {
      if ($isRangeSelection(selection)) {
        textNode.select(selection.anchor.offset, selection.focus.offset);
      } else if ($isNodeSelection(selection)) {
        textNode.select(0, textNode.getTextContent().length);
      }
    }
    firstLinkTextNode.replace(linkNode);
    return remainingTextNode;
  }
  return undefined;
}

function findFirstMatch(text: string, matchers: LinkMatcher[]): LinkMatcherResult | null {
  for (let i = 0; i < matchers.length; i++) {
    const match = matchers[i](text);
    if (match) return match;
  }
  return null;
}

function $handleLinkCreation(
  nodes: TextNode[],
  matchers: LinkMatcher[],
  onChange: ChangeHandler,
): void {
  let currentNodes = [...nodes];
  const initialText = currentNodes.map((node) => node.getTextContent()).join('');
  let text = initialText;
  let match;
  let invalidMatchEnd = 0;

  while ((match = findFirstMatch(text, matchers)) && match !== null) {
    const matchStart = match.index;
    const matchLength = match.length;
    const matchEnd = matchStart + matchLength;
    const isValid = isContentAroundIsValid(
      invalidMatchEnd + matchStart,
      invalidMatchEnd + matchEnd,
      initialText,
      currentNodes,
    );

    if (isValid) {
      const [matchingOffset, , matchingNodes, unmodifiedAfterNodes] =
        extractMatchingNodes(
          currentNodes,
          invalidMatchEnd + matchStart,
          invalidMatchEnd + matchEnd,
        );
      const actualMatchStart = invalidMatchEnd + matchStart - matchingOffset;
      const actualMatchEnd = invalidMatchEnd + matchEnd - matchingOffset;
      const remainingTextNode = $createAutoLinkNode_(
        matchingNodes,
        actualMatchStart,
        actualMatchEnd,
        match,
      );
      currentNodes = remainingTextNode
        ? [remainingTextNode, ...unmodifiedAfterNodes]
        : unmodifiedAfterNodes;
      onChange(match.url, null);
      invalidMatchEnd = 0;
    } else {
      invalidMatchEnd += matchEnd;
    }
    text = text.substring(matchEnd);
  }
}

function handleLinkEdit(
  linkNode: AutoLinkNode,
  matchers: LinkMatcher[],
  onChange: ChangeHandler,
): void {
  const children = linkNode.getChildren();
  for (let i = 0; i < children.length; i++) {
    const child = children[i];
    if (!$isTextNode(child) || !child.isSimpleText()) {
      replaceWithChildren(linkNode);
      onChange(null, linkNode.getURL());
      return;
    }
  }

  const text = linkNode.getTextContent();
  const match = findFirstMatch(text, matchers);
  if (match === null || match.text !== text) {
    replaceWithChildren(linkNode);
    onChange(null, linkNode.getURL());
    return;
  }

  if (!isPreviousNodeValid(linkNode) || !isNextNodeValid(linkNode)) {
    replaceWithChildren(linkNode);
    onChange(null, linkNode.getURL());
    return;
  }

  const url = linkNode.getURL();
  if (url !== match.url) {
    linkNode.setURL(match.url);
    onChange(match.url, url);
  }

  if (match.attributes) {
    const rel = linkNode.getRel();
    if (rel !== match.attributes.rel) {
      linkNode.setRel(match.attributes.rel || null);
      onChange(match.attributes.rel || null, rel);
    }
    const target = linkNode.getTarget();
    if (target !== match.attributes.target) {
      linkNode.setTarget(match.attributes.target || null);
      onChange(match.attributes.target || null, target);
    }
  }
}

function handleBadNeighbors(
  textNode: TextNode,
  matchers: LinkMatcher[],
  onChange: ChangeHandler,
): void {
  const previousSibling = textNode.getPreviousSibling();
  const nextSibling = textNode.getNextSibling();
  const text = textNode.getTextContent();

  if (
    $isAutoLinkNode(previousSibling) &&
    !previousSibling.getIsUnlinked() &&
    (!startsWithSeparator(text) ||
      startsWithTLD(text, previousSibling.isEmailURI()))
  ) {
    previousSibling.append(textNode);
    handleLinkEdit(previousSibling, matchers, onChange);
    onChange(null, previousSibling.getURL());
  }

  if (
    $isAutoLinkNode(nextSibling) &&
    !nextSibling.getIsUnlinked() &&
    !endsWithSeparator(text)
  ) {
    replaceWithChildren(nextSibling);
    handleLinkEdit(nextSibling, matchers, onChange);
    onChange(null, nextSibling.getURL());
  }
}

function replaceWithChildren(node: ElementNode): LexicalNode[] {
  const children = node.getChildren();
  for (let j = children.length - 1; j >= 0; j--) {
    node.insertAfter(children[j]);
  }
  node.remove();
  return children.map((child) => child.getLatest());
}

function getTextNodesToMatch(textNode: TextNode): TextNode[] {
  const textNodesToMatch = [textNode];
  let nextSibling = textNode.getNextSibling();
  while (
    nextSibling !== null &&
    $isTextNode(nextSibling) &&
    nextSibling.isSimpleText()
  ) {
    textNodesToMatch.push(nextSibling);
    if (/[\s]/.test(nextSibling.getTextContent())) break;
    nextSibling = nextSibling.getNextSibling();
  }
  return textNodesToMatch;
}

function registerAutoLink(
  editor: LexicalEditor,
  matchers: LinkMatcher[],
  onChange: ChangeHandler,
): () => void {
  if (!editor.hasNodes([AutoLinkNode])) {
    throw new Error(
      'AutoLinkExtension: AutoLinkNode is not registered on the editor.',
    );
  }
  return mergeRegister(
    editor.registerNodeTransform(TextNode, (textNode: TextNode) => {
      const parent = textNode.getParentOrThrow();
      const previous = textNode.getPreviousSibling();
      if ($isAutoLinkNode(parent) && !parent.getIsUnlinked()) {
        handleLinkEdit(parent, matchers, onChange);
      } else if (!$isLinkNode(parent)) {
        if (
          textNode.isSimpleText() &&
          (startsWithSeparator(textNode.getTextContent()) ||
            !$isAutoLinkNode(previous))
        ) {
          const textNodesToMatch = getTextNodesToMatch(textNode);
          $handleLinkCreation(textNodesToMatch, matchers, onChange);
        }
        handleBadNeighbors(textNode, matchers, onChange);
      }
    }),
    editor.registerCommand(
      TOGGLE_LINK_COMMAND,
      (payload) => {
        const selection = $getSelection();
        if (payload !== null || !$isRangeSelection(selection)) return false;
        const nodes = selection.extract();
        nodes.forEach((node) => {
          const parent = node.getParent();
          if ($isAutoLinkNode(parent)) {
            parent.setIsUnlinked(!parent.getIsUnlinked());
            parent.markDirty();
          }
        });
        return false;
      },
      COMMAND_PRIORITY_LOW,
    ),
  );
}

export interface AutoLinkConfig {
  matchers: LinkMatcher[];
  onChange: ChangeHandler | undefined;
}

export const AutoLinkExtension = defineExtension({
  name: '@nimbalyst/editor/auto-link',
  config: {
    matchers: DEFAULT_AUTOLINK_MATCHERS,
    onChange: undefined,
  } as AutoLinkConfig,
  register: (editor, config) => {
    const onChange: ChangeHandler = (url, prevUrl) => {
      config.onChange?.(url, prevUrl);
    };
    return registerAutoLink(editor, config.matchers, onChange);
  },
});

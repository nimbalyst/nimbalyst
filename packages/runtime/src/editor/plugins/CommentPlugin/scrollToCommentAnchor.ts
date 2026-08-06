import {
  $getRoot,
  $isElementNode,
  $isTextNode,
  type LexicalEditor,
  type NodeKey,
} from "lexical";

export type CommentMarkNodeMap = ReadonlyMap<string, ReadonlySet<NodeKey>>;

export function scrollToCommentAnchor(
  editor: Pick<LexicalEditor, "getEditorState" | "getElementByKey">,
  markNodeMap: CommentMarkNodeMap,
  threadId: string,
  quote: string
): boolean {
  const keys = markNodeMap.get(threadId);
  if (keys) {
    for (const key of keys) {
      const element = editor.getElementByKey(key);
      if (element) {
        element.scrollIntoView({ block: "center", behavior: "smooth" });
        return true;
      }
    }
  }

  const normalizedQuote = normalizeVisibleText(quote);
  if (!normalizedQuote) return false;

  let fallbackKey: NodeKey | null = null;
  editor.getEditorState().read(() => {
    const topLevelChildren = $getRoot().getChildren();
    const segments: Array<{ end: number; key: NodeKey; start: number }> = [];
    let text = "";

    topLevelChildren.forEach((child, childIndex) => {
      const textNodes = $isTextNode(child)
        ? [child]
        : $isElementNode(child)
        ? child.getAllTextNodes()
        : [];
      for (const textNode of textNodes) {
        const start = text.length;
        text += normalizeVisibleText(textNode.getTextContent());
        segments.push({ start, end: text.length, key: textNode.getKey() });
      }
      if (childIndex < topLevelChildren.length - 1) text += "\n";
    });

    const quoteStart = text.indexOf(normalizedQuote);
    if (quoteStart === -1) return;
    fallbackKey =
      segments.find(
        (segment) => quoteStart >= segment.start && quoteStart < segment.end
      )?.key ?? null;
  });

  if (fallbackKey) {
    const element = editor.getElementByKey(fallbackKey);
    if (element) {
      element.scrollIntoView({ block: "center", behavior: "smooth" });
      return true;
    }
  }

  return false;
}

function normalizeVisibleText(value: string): string {
  return value.replace(/\r\n?/g, "\n").replace(/\u00a0/g, " ");
}

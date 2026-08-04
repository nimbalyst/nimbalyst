import {
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  createEditor,
  type NodeKey,
} from "lexical";
import { describe, expect, it, vi } from "vitest";

import { scrollToCommentAnchor } from "../scrollToCommentAnchor";

describe("scrollToCommentAnchor", () => {
  it("falls back to the quoted document text when the comment mark is orphaned", () => {
    const editor = createEditor({
      namespace: "comment-scroll-test",
      onError: (error) => {
        throw error;
      },
    });
    const rootElement = document.createElement("div");
    document.body.append(rootElement);
    editor.setRootElement(rootElement);
    let targetKey: NodeKey | undefined;

    editor.update(
      () => {
        const paragraph = $createParagraphNode();
        paragraph.append($createTextNode("Before "));
        const target = $createTextNode("comment target");
        target.toggleFormat("bold");
        targetKey = target.getKey();
        paragraph.append(target, $createTextNode(" after"));
        $getRoot().append(paragraph);
      },
      { discrete: true }
    );

    const targetElement = targetKey ? editor.getElementByKey(targetKey) : null;
    expect(targetElement).not.toBeNull();
    if (!targetElement) throw new Error("target element was not rendered");
    targetElement.scrollIntoView = vi.fn();

    expect(
      scrollToCommentAnchor(
        editor,
        new Map(),
        "orphaned-thread",
        "comment target"
      )
    ).toBe(true);
    expect(targetElement.scrollIntoView).toHaveBeenCalledWith({
      block: "center",
      behavior: "smooth",
    });

    editor.setRootElement(null);
    rootElement.remove();
  });
});

/**
 * Headless extension that owns `DecisionNode` registration and the ```decision
 * markdown transformer.
 *
 * This node is **core, not an extension-provided node**. `@lexical/yjs` throws
 * from inside the Y.Doc observer when it meets an unregistered node type, and
 * the whole document paints blank -- so a decision block must be registered in
 * every host before any document containing one can mount. Extension activation
 * is async; a document that mounted first would blank out. Hence registration
 * here, in the built-in graph that every host imports, plus an entry in
 * `headlessBodyNodes.ts` because a decision can also live in a tracker item body
 * seeded by the main process.
 */

import {
  $getRoot,
  $getSelection,
  $insertNodes,
  $isElementNode,
  $isRangeSelection,
  COMMAND_PRIORITY_EDITOR,
  defineExtension,
  type LexicalNode,
} from "lexical";
import { mergeRegister } from "@lexical/utils";

import {
  $createDecisionNode,
  $isDecisionNode,
  DecisionNode,
  readDecisionIdFromFence,
  type DecisionPayload,
} from "../../plugins/DecisionPlugin/DecisionNode";
import { createDecisionId } from "../../plugins/DecisionPlugin/decisionFence";
import { DECISION_TRANSFORMER } from "../../plugins/DecisionPlugin/DecisionTransformer";
import { INSERT_DECISION_COMMAND } from "../../plugins/DecisionPlugin/DecisionCommands";
import { setExtensionContributions } from "../extensionContributionsStore";

const NAME = "@nimbalyst/editor/decision";

function $decisionIdAppearsBefore(target: DecisionNode, id: string): boolean {
  const stack: LexicalNode[] = [...$getRoot().getChildren()].reverse();
  while (stack.length > 0) {
    const node = stack.pop()!;
    if (node.getKey() === target.getKey()) return false;
    if (
      $isDecisionNode(node) &&
      readDecisionIdFromFence(node.getContent()) === id
    ) {
      return true;
    }
    if ($isElementNode(node)) {
      const children = node.getChildren();
      for (let index = children.length - 1; index >= 0; index -= 1) {
        stack.push(children[index]!);
      }
    }
  }
  return false;
}

export function $regenerateDuplicateDecisionId(node: DecisionNode): void {
  const content = node.getContent();
  const id = readDecisionIdFromFence(content);
  if (!id || !$decisionIdAppearsBefore(node, id)) return;
  const nextId = createDecisionId();
  node.setContent(content.replace(/^([ \t]*id:)[ \t]*.+$/m, `$1 ${nextId}`));
}

export const DecisionExtension = defineExtension({
  name: NAME,
  nodes: [DecisionNode],
  register: (editor) =>
    mergeRegister(
      editor.registerNodeTransform(
        DecisionNode,
        $regenerateDuplicateDecisionId
      ),
      editor.registerCommand(
        INSERT_DECISION_COMMAND,
        (payload: DecisionPayload) => {
          const selection = $getSelection();
          if ($isRangeSelection(selection)) {
            $insertNodes([$createDecisionNode(payload)]);
          }
          return true;
        },
        COMMAND_PRIORITY_EDITOR
      )
    ),
});

setExtensionContributions(NAME, {
  markdownTransformers: [DECISION_TRANSFORMER],
});

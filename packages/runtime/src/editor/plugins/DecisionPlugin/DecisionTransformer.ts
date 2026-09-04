/**
 * Markdown round trip for the ```decision fence.
 *
 * Registered ahead of the core `CODE` transformer -- extension transformers are
 * assembled first by `getEditorTransformers()` -- so a decision fence becomes a
 * `DecisionNode` rather than a code block. If that ordering ever inverts, every
 * decision in every document silently degrades to a YAML code block, which is
 * why the ordering has a test rather than a comment alone.
 */

import type { MultilineElementTransformer } from "@lexical/markdown";
import {
  DecisionNode,
  $createDecisionNode,
  $isDecisionNode,
} from "./DecisionNode";

const DECISION_START_REGEX = /^[ \t]*```decision[ \t]*$/;
const DECISION_END_REGEX = /[ \t]*```$/;

export const DECISION_TRANSFORMER: MultilineElementTransformer = {
  dependencies: [DecisionNode],
  export: (node) => {
    if (!$isDecisionNode(node)) return null;
    return "```decision\n" + node.getContent() + "\n```";
  },
  regExpStart: DECISION_START_REGEX,
  regExpEnd: {
    // An unterminated fence at end of file still becomes a decision. A decision
    // that renders as a broken block is recoverable; one that vanishes into a
    // code block takes the sealed record with it.
    optional: true,
    regExp: DECISION_END_REGEX,
  },
  replace: (rootNode, _children, _startMatch, _endMatch, linesInBetween) => {
    const content = linesInBetween ? linesInBetween.join("\n").trim() : "";
    rootNode.append($createDecisionNode({ content }));
  },
  type: "multiline-element",
};

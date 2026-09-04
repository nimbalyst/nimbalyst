/**
 * In-document decisions.
 *
 * Node registration and the markdown transformer are published from
 * `editor/extensions/builtin/DecisionExtension.ts`, not here -- this barrel is
 * only a re-export surface, mirroring the Mermaid and Kanban plugins.
 */

export {
  DecisionNode,
  $createDecisionNode,
  $isDecisionNode,
  readDecisionIdFromFence,
  type DecisionPayload,
  type SerializedDecisionNode,
} from "./DecisionNode";
export { DECISION_TRANSFORMER } from "./DecisionTransformer";
export {
  parseDecisionFence,
  serializeDecisionFence,
  reconcileDecisionFence,
  createDecisionId,
} from "./decisionFence";

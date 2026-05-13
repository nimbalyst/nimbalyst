/**
 * Mermaid plugin module: re-exports the node, transformer, and command
 * identity. The runtime registrations live in
 * `editor/extensions/builtin/MermaidExtension.ts`.
 */

export { MermaidNode, $createMermaidNode, $isMermaidNode } from './MermaidNode';
export { MERMAID_TRANSFORMER } from './MermaidTransformer';
export type { MermaidPayload, SerializedMermaidNode } from './MermaidNode';
export { INSERT_MERMAID_COMMAND } from './MermaidCommands';

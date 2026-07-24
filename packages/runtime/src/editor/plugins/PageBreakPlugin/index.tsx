/**
 * Page-break plugin module: re-exports the node, transformer, and command
 * identity. The runtime registrations live in
 * `editor/extensions/builtin/PageBreakExtension.ts`.
 */

export { $createPageBreakNode, PageBreakNode } from './PageBreakNode';
export { PAGE_BREAK_TRANSFORMER } from './PageBreakTransformer';
export { INSERT_PAGE_BREAK } from './PageBreakCommands';

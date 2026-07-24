# Architecture Diagrams for Decisions

Whenever an architectural change or decision is made — whether proposed by the human or the AI — create an Excalidraw diagram to visualize it and share it in the conversation. A markdown link to the `.excalidraw` file is usually sufficient because Lexical now live-renders custom-editor links inline. Apply this to decisions like:

- New module boundaries, data flow changes, or service decomposition
- Changes to IPC channels, state management patterns, or persistence layers
- New extension points, editor types, or provider integrations
- Database schema changes or migration strategies
- Significant refactors that alter how components relate to each other

## How to create the diagram

1. Create an `.excalidraw` file in `nimbalyst-local/architecture/` (e.g., `nimbalyst-local/architecture/transcript-refactor.excalidraw`).
2. Use the Excalidraw MCP tools to build a clear diagram showing the relevant components, their relationships, and data flow. Include:
   - Named boxes for each component, service, or module involved
   - Arrows showing data flow, IPC channels, or dependency direction
   - Labels on arrows describing what flows between components
   - A title or heading text element describing the decision
   - Color coding where helpful (green for new, red for removed, gray for unchanged)
3. Share the diagram in the conversation with a markdown link to the `.excalidraw` file so Lexical can render it inline.
4. Use `capture_editor_screenshot` only when visual verification is needed or the user explicitly wants a static inline image.
5. Reference the diagram file path so the user can open and edit it later.

The goal is that architectural decisions are always visually communicated, never just described in text. Prefer the live-rendered file link over duplicating the same content as a screenshot. Diagrams should be clear enough that someone unfamiliar with the decision can understand the before/after or the proposed structure at a glance.

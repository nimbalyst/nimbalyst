---
globs:
  - packages/runtime/src/editors/**/*.ts
  - packages/runtime/src/editors/**/*.tsx
  - packages/runtime/src/editor/**/*.tsx
  - packages/runtime/src/editor/**/*.ts
  - packages/electron/src/renderer/components/TabEditor/**/*
  - packages/runtime/src/extensions/editorHost.ts
  - packages/runtime/src/extensions/useEditorLifecycle.ts
  - packages/extension-sdk/src/types/editor.ts
  - packages/extensions/**/src/components/**Editor.tsx
  - packages/extensions/**/src/editors/**/*
  - packages/runtime/src/store/atoms/editors.ts
  - packages/electron/src/renderer/store/atoms/sessionEditors.ts
  - "**/*Editor*.tsx"
  - "**/*EditorHost*"
imports:
  - docs/EDITOR_STATE.md
---

When working with editors, follow the state architecture documented in the imported EDITOR_STATE.md file. Key points:
- Do NOT "lift state up" for editor content
- Editors own their content state, parent does NOT store content
- Use EditorHost for editor-host communication, not props
- Use Jotai atom families for tab/editor metadata (dirty, processing)
- Stateful editors (Monaco, Lexical, RevoGrid) cannot be re-rendered

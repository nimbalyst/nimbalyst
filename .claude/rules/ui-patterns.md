---
globs:
  - packages/electron/src/renderer/**/*.tsx
  - packages/electron/src/renderer/**/*.css
  - packages/runtime/src/editor/ui/**/*.tsx
  - packages/runtime/src/editor/**/*.css
  - packages/runtime/src/ui/**/*.tsx
  - packages/runtime/src/ui/**/*.css
  - "**/tailwind.config.*"
  - "**/postcss.config.*"
imports:
  - docs/UI_PATTERNS.md
---

When working with UI components, follow the patterns documented in the imported UI_PATTERNS.md file. Key points:
- Use `@container` queries, not `@media` queries for responsive layouts
- Use only the canonical `--nim-*` CSS variable names
- Use ternary operators for mutually exclusive Tailwind class states
- Content areas must opt-in to text selection with `select-text`

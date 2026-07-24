---
globs:
  - "**/store/**/*"
  - "**/atoms/**/*"
  - "**/*Atom*"
  - "**/*atom*"
  - "**/*.tsx"
imports:
  - docs/JOTAI.md
---

When working with Jotai atoms, follow the patterns documented in the imported JOTAI.md file. Key points:
- Use derived atoms for session state to prevent divergence
- Never use dynamic imports inside atoms
- Keep derived atoms synchronous

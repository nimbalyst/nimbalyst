---
globs:
  - packages/electron/src/renderer/help/**/*.ts
  - packages/electron/src/renderer/help/**/*.tsx
  - packages/electron/src/renderer/walkthroughs/**/*.ts
  - packages/electron/src/renderer/walkthroughs/**/*.tsx
  - packages/electron/e2e/walkthroughs/**/*.spec.ts
  - "**/HelpContent*"
  - "**/HelpTooltip*"
  - "**/Walkthrough*"
imports:
  - docs/HELP_WALKTHROUGHS.md
---

When working with help content or walkthroughs, follow the patterns documented in the imported HELP_WALKTHROUGHS.md file. Key points:
- HelpContent.ts is the centralized registry of help text, keyed by `data-testid`
- Use HelpTooltip wrapper for elements that need hover help
- Walkthrough definitions go in walkthroughs/definitions/
- Always add `data-testid` to elements that need help content

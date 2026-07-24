# AI E2E Test Inventory

## Final State: 7 files, ~45 tests

### Real AI Integration (1 file)
| File | Tests | What it tests |
| --- | --- | --- |
| ai-smoke.spec.ts | 1 | Sends one prompt to Claude Code, verifies response. Skips without API key. |

### Simulated Diff System (2 files)
Uses `simulateApplyDiff`, `simulateStreamContent`, or direct `__editorRegistry` calls.

| File | Tests | What it tests |
| --- | --- | --- |
| diff-behavior.spec.ts | 12 | Tab targeting, consecutive edits, group approval, baseline tracking, cleanup |
| diff-reliability.spec.ts | 18 | Complex diff edge cases (nested lists, tables, code blocks, streaming, special chars) |

### Session Management (1 file)
| File | Tests | What it tests |
| --- | --- | --- |
| session-management.spec.ts | ~19 | Agent mode UI, concurrent sessions, cross-mode visibility, status indicators, workstreams, child session persistence, worktree persistence |

### Input & Attachments (1 file)
| File | Tests | What it tests |
| --- | --- | --- |
| ai-input-attachments.spec.ts | 8 | Image drag/drop, paste, removal, size validation, clear after send, @mention typeahead |

### AI Features (1 file)
| File | Tests | What it tests |
| --- | --- | --- |
| ai-features.spec.ts | 3 | Claude Code session creation, context usage display, agent mode stability |

### File Operations (1 file)
| File | Tests | What it tests |
| --- | --- | --- |
| ai-file-operations.spec.ts | 5 | Bash file tracking (cat, echo, rm, mv), git state clearing after commit |

## Consolidation History

- **Phase 1**: Deleted 3 real-AI test files, added smoke test, deleted outdated READMEs (28 -> 26 files)
- **Phase 2**: Consolidated 8 simulated diff files into `diff-behavior.spec.ts` (26 -> 19 files)
- **Phase 3**: Consolidated 16 UI-only files into 4 files, deleted `model-switching.spec.ts` (entirely skipped) (19 -> 7 files)
- **Phase 4**: TBD - Add missing coverage for newer features

## Deleted/Consolidated Files (Phase 3)

Into `session-management.spec.ts`:
- agent-mode-comprehensive.spec.ts
- concurrent-sessions.spec.ts
- session-state-cross-mode.spec.ts
- session-status-indicators.spec.ts
- session-workstreams.spec.ts
- child-session-persistence.spec.ts
- worktree-session-persistence.spec.ts

Into `ai-input-attachments.spec.ts`:
- ai-image-attachment.spec.ts
- file-mention-all-types.spec.ts
- image-attachment-persistence.spec.ts

Into `ai-features.spec.ts`:
- claude-code-basic.spec.ts
- context-usage-display.spec.ts (kept UI test only, dropped real-AI tests)
- slash-command-error.spec.ts
- model-switching.spec.ts (deleted - entirely skipped)

Into `ai-file-operations.spec.ts`:
- bash-file-tracking.spec.ts
- git-state-clearing.spec.ts

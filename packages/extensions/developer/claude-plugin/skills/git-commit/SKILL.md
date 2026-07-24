---
name: git-commit
description: Create git commits using Nimbalyst's interactive commit proposal widget. ONLY use when the user explicitly clicks "Commit with AI" button or asks for "smart commit". For regular commit requests, use standard git commands instead.
---

# Git Commit Workflow in Nimbalyst

This skill is for the "Commit with AI" feature which provides an interactive commit proposal widget.

**IMPORTANT: Only use this when:**
- The user clicks the "Commit with AI" button (you'll see a message asking you to use developer_git_commit_proposal)
- The user explicitly asks for "smart commit" or "commit with AI"

**Do NOT use this for:**
- Generic commit requests like "commit this", "commit the changes", "make a commit"
- For those, use standard git commands: `git add` and `git commit`

## Required Steps

1. **Check if file context is already provided in the prompt**
   When the user clicks "Commit with AI", the prompt includes a pre-fetched list of session-edited files with uncommitted changes. If you see a file list in the prompt (lines like `- path/to/file.ts (modified)`), skip step 2 and go directly to step 3 using those files.

2. **Get session-edited files (fallback only)**
   Only if no file list was provided in the prompt:
   Call `mcp__nimbalyst__get_session_edited_files` to get ALL files you edited during this AI session, then cross-reference with git status.

3. **Propose the commit**
   Call `mcp__nimbalyst__developer_git_commit_proposal` with:
   - `filesToStage`: ALL session-edited files that have changes (do not cherry-pick a subset)
   - `commitMessage`: A well-crafted commit message following the guidelines below
   - `reasoning`: Explanation of why these files were selected

## Commit Message Guidelines

- Start with type prefix: `feat:`, `fix:`, `refactor:`, `docs:`, `test:`, `chore:`
- **Focus on IMPACT and WHY, not implementation details**
- Title describes user-visible outcome or bug fixed
- Use bullet points (dash prefix) only for multiple distinct changes
- Keep lines under 72 characters
- No emojis
- Lead with problem solved or capability added, not technique used

### Good vs Bad Examples

**BAD**: "feat: add pre-edit tagging for non-agentic AI providers"
**GOOD**: "fix: OpenAI/LMStudio diffs now persist across app restarts"

**BAD**: "refactor: extract helper function for validation"
**GOOD**: "fix: prevent crash when user input is empty"

## Important

- Do NOT run `git add` or `git commit` commands directly
- Do NOT add "Co-Authored-By" or attribution lines
- Do NOT add marketing taglines or links
- Include ALL session-edited files that have changes - the user can deselect files in the widget if needed
- The widget allows users to review, edit the message, and select/deselect files before confirming

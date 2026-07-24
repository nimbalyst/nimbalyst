---
name: commit
description: Create a git commit with concise, bullet-point commit message
---
Prepare a git commit following these steps:

1. Run `git status` and `git diff` to see changes
2. Review recent commits (`git log --oneline -5`) to match the style
3. Draft a concise commit message:
  - Start with type prefix: `feat:`, `fix:`, `refactor:`, `docs:`, `test:`, `chore:`
  - **Focus on IMPACT and WHY, not implementation details**
  - The title should describe the user-visible outcome or bug fixed
  - Use bullet points (dash prefix) only if there are multiple distinct changes
  - Keep each line under 72 characters
  - No emojis
4. Run the `developer_git_commit_proposal` tool to propose the commit to the user
  - Do NOT run `git add` - the widget handles staging when the user confirms

**Commit Message Guidelines:**
- Lead with the problem solved or capability added, not the technique used
- BAD: "feat: add pre-edit tagging for non-agentic AI providers"
- GOOD: "fix: OpenAI/LMStudio diffs now persist across app restarts"
- BAD: "refactor: extract helper function for validation"
- GOOD: "fix: prevent crash when user input is empty"
- The body can explain HOW if it's non-obvious, but title = IMPACT

**Issue Linking (for auto-close):**
- If the commit is intended to resolve a referenced issue or tracker item,
  include the tracker reference on its own line in the proposed message
- Prefer that system's canonical closing syntax, such as `Fixes #123`,
  `Closes ABC-123`, or similar
- If the correct auto-close syntax is unclear, include a neutral reference
  line (for example `Refs ABC-123`) rather than omitting the tracker

**Important:**
- Do NOT add "Co-Authored-By" or any attribution lines
- Do NOT add marketing taglines or links
- Be direct and factual
- Keep it brief - avoid unnecessary details about what wasn't changed

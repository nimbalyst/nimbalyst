---
description: Summarize my recent git commits in standup format
---
# Standup Changes Summary

Generate a concise standup-style summary of my recent git commits.

## Usage
Arguments: <time-period>
- Examples: 1d (1 day), 2d (2 days), 1w (1 week), 3d (3 days)

## Task
1. Parse the time period argument (e.g., "1d" = 1 day ago)
2. Get git commits since that time using: `git log --since="<time>" --author="$(git config user.name)" --pretty=format:"%h - %s (%cr)" --no-merges`
3. Get the actual commit details using: `git log --since="<time>" --author="$(git config user.name)" --pretty=format:"%h|%s|%b" --no-merges`
4. Summarize the changes in standup format:
  - Start with "Here's what I worked on in the last [period]:"
  - Group related changes together
  - Use concise bullet points
  - Focus on what was accomplished (features, fixes, improvements)
  - Mention any notable refactoring or infrastructure work
  - Keep it brief and conversational (standup style, not formal)
  - Don't just list commits - synthesize them into achievements

## Output Format
```
Here's what I worked on in the last [period]:

- [Achievement/feature area]: [summary of what was done]
- [Another area]: [summary]
- [Additional work]: [summary]
```

## Important
- If no commits found, say "No commits found in the last [period]"
- Focus on the "what" and "why", not technical implementation details
- Group similar commits together (e.g., multiple bug fixes, related features)
- Keep it conversational and brief - this is for standup, not a detailed report

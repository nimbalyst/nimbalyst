---
description: Comment out inappropriate logging before commit
---
# Prepare for Commit

Review the current git diff and comment out logging statements that are inappropriate for production:

## Logging to Comment Out

1. **Console.log statements** - Most console.log calls should be commented out (use proper logging service instead)
2. **Verbose debug logging** - Excessive debug statements that clutter production logs
3. **Temporary debugging code** - Any logging added just for debugging a specific issue
4. **Performance logging** - Detailed performance measurements unless critical for monitoring

## Logging to Keep

1. **Error logging** - Keep `log.error()`, `console.error()`, and error reporting
2. **Warning logging** - Keep `log.warn()` and important warnings
3. **Critical info logging** - Keep `log.info()` for significant application events
4. **Analytics events** - Keep `analyticsService.sendEvent()` calls
5. **Startup/shutdown logs** - Keep important lifecycle logging

## Instructions

1. Run `git diff` to see staged and unstaged changes
2. Look for inappropriate logging statements in the diff
3. Comment out (don't delete) inappropriate logs with explanation:
```typescript
   // Debug logging - uncomment if needed
   // console.log('some debug info:', data);
```
4. Preserve proper logging that uses the logging service (`log.info`, `log.warn`, `log.error`)
5. **Check for leftover TODOs** - Look for TODO comments that were added during development that should be resolved before commit
6. **Check for dead code** - Look for commented-out code blocks, unused variables, or unreachable code that was added
7. Show me what you found and what you're commenting out before making changes
8. Ask for confirmation before proceeding
9. After changes are approved, run `git add` for only the files that were reviewed/modified

## Code Quality Checks

### TODOs to Flag
- `// TODO:` comments added in the diff that indicate incomplete work
- `// FIXME:` comments that should be addressed before commit
- `// HACK:` or `// TEMP:` markers

### Dead Code to Flag
- Commented-out code blocks (not logging comments, but actual dead code)
- Unused imports added in the diff
- Variables declared but never used
- Unreachable code after return statements

## Plan Status Check

If a plan document (in `plans/` or `nimbalyst-local/plans/`) is being committed, quickly check its frontmatter:
- If `status` is not `completed` or `progress` is less than 100, mention this to the user
- This is just a note, not a blocker - they may be intentionally committing a partial plan

## Important Rules

- Never delete logs - comment them out so they can be restored later
- Don't touch logging in test files
- Don't touch logging that's already commented out
- Focus only on files in the current git diff
- For TODOs/dead code: flag them for review rather than automatically removing

After reviewing, ask me if I want to proceed with the changes.

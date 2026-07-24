---
description: Execute a plan document with progress tracking
---

# /implement Command

Execute a plan document while maintaining progress tracking.

## Usage

```
/implement [plan-file-path]
```

**Examples:**
- `/implement nimbalyst-local/plans/user-authentication.md`
- `/implement user-authentication.md` (assumes nimbalyst-local/plans/ directory)

## Execution Steps

1. **Read the plan file**
   - Parse the YAML frontmatter
   - Extract implementation details, acceptance criteria, and goals

2. **Generate task list**
   - Create markdown checkboxes from acceptance criteria
   - Add implementation tasks from the plan
   - Insert task list after the plan title

3. **Update plan frontmatter**
   - Set `status` to `in-development`
   - Set `startDate` to today if not set
   - Update `updated` timestamp
   - Set `progress` to 0

4. **Begin implementation**
   - Use TodoWrite for internal task tracking
   - Work through each task systematically
   - Check off tasks as completed
   - Update progress percentage

5. **Calculate progress**
   - Progress = (completed checkboxes / total) x 100
   - Round to nearest integer

6. **Final updates**
   - Set `status` to `in-review` when complete
   - Set `progress` to 100

## Task List Format

Insert after the plan title:

```markdown
## Implementation Progress

- [ ] Task 1 from acceptance criteria
- [ ] Task 2 from acceptance criteria
- [ ] Implementation task A
```

## Progress Rules

- Count ONLY tasks in "Implementation Progress" section
- Update progress after each task, not in batches
- Always update `updated` timestamp with changes

## Error Handling

- **File doesn't exist**: Ask for correct path
- **No frontmatter**: Warn about invalid plan format
- **Already completed**: Ask if user wants to re-implement
- **Blocked status**: Ask what needs unblocking

## Important Notes

- Keep plan in sync - update after each major task
- Never disable tests - fix failures instead
- Don't commit automatically unless asked
- Track blockers by updating plan status

---
description: Execute a plan document while keeping progress synchronized.
---

# /implement Command

Execute a plan document while maintaining progress tracking.

## Overview

The `/implement` command reads a plan file and begins implementation while keeping the plan document synchronized with actual progress. It extracts tasks from the plan's acceptance criteria and implementation details, tracks them as markdown checkboxes at the top of the plan, and checks them off as work is completed.

## Usage

```
/implement [plan-file-path]
```

**Examples:**
- `/implement nimbalyst-local/plans/user-authentication.md`
- `/implement user-authentication.md` (assumes nimbalyst-local/plans/ directory)

## Execution Steps

When executing this command:

1. **Read the plan file**
  - Parse the YAML frontmatter
  - Extract the implementation details, acceptance criteria, and goals

2. **Generate task list**
  - Create markdown checkboxes from acceptance criteria
  - Add any implementation tasks from the Implementation Details section
  - Insert this task list after the plan title (after the first # heading)

3. **Update plan frontmatter**
  - Set `status` to `in-development` (if currently `ready-for-development` or `draft`)
  - Set `startDate` to today if not already set
  - Update `updated` timestamp to current time (use new Date().toISOString())
  - Set `progress` to 0 initially

4. **Begin implementation**
  - Use TodoWrite to track tasks internally (for your own progress tracking)
  - Work through each task systematically
  - As each task is completed:
    - Check off the corresponding checkbox in the plan file
    - Update the `progress` percentage in frontmatter
    - Update the `updated` timestamp

5. **Calculate progress**
  - Progress = (completed checkboxes / total checkboxes) × 100
  - Round to nearest integer

6. **Final updates**
  - When all tasks complete, set `status` to `in-review`
  - Set `progress` to 100
  - Update `updated` timestamp

## Task List Format

The task list should be inserted immediately after the plan title:

```markdown
---
planStatus:
  ...
---

# [Plan Title]

## Implementation Progress

- [ ] Task 1 from acceptance criteria
- [ ] Task 2 from acceptance criteria
- [ ] Implementation task A
- [ ] Implementation task B

## Goals
...
```

## Progress Calculation Rules

- Count ONLY tasks in the "Implementation Progress" section at the top
- Do NOT count checkboxes elsewhere in the document
- Update progress after completing each task, not in batches
- Always update the `updated` timestamp when making any change to the plan

## Error Handling

If the plan file:
- **Doesn't exist**: Ask user for correct path or offer to create a new plan
- **Has no frontmatter**: Warn that this doesn't appear to be a valid plan file
- **Is already completed**: Ask user if they want to re-implement or if this was a mistake
- **Is blocked**: Ask user what needs to be unblocked before proceeding

## Important Notes

- **Keep plan in sync**: Update the plan file after completing each major task, not just at the end
- **Never disable tests**: If tests fail, fix them rather than skipping
- **Don't commit automatically**: Only commit if user explicitly requests it
- **Be thorough**: Read all sections of the plan before starting implementation
- **Track blockers**: If you encounter blockers, update plan status to `blocked` and document the issue
- **Preserve structure**: Don't modify the plan's existing structure, only add the task list and update frontmatter/checkboxes
- **Typecheck:** Run typechecks to ensure code will compile

## Integration with TodoWrite

Use TodoWrite for your own internal task tracking during implementation:
- This provides the user real-time visibility into what you're doing
- Map plan tasks to TodoWrite items
- Mark TodoWrite items complete at the same time you check off plan checkboxes

## Example Workflow

User types: `/implement user-authentication.md`

1. Read `nimbalyst-local/plans/user-authentication.md`
2. Extract acceptance criteria:
  - Users can register with email/password
  - Users can log in with email/password
  - OAuth works (Google, GitHub)
  - JWT tokens expire after 15 minutes
  - Role-based permissions work
  - All tests passing
3. Update plan file to add task list at top
4. Update frontmatter: status=in-development, progress=0, updated=now
5. Start implementing first task
6. After completing registration: check off task, update progress=17, updated=now
7. Continue through all tasks
8. When complete: status=in-review, progress=100, updated=now

## Related Commands

- `/design [description]` - Create a new plan
- `/track [type] [description]` - Track bugs, tasks, ideas, decisions

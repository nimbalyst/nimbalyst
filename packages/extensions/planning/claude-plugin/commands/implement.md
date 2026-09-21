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

2. **Link this session to the projected plan item**
   - Normalize the plan path to a workspace-relative path with `/` separators
   - Resolve the existing frontmatter projection as `fm:plan:<relative-path>` with `tracker_get`
   - Call `tracker_link_session` with the item ID returned by `tracker_get` before implementation begins
   - Do not create a second tracker item; shared/promoted plans resolve through the same projection reference

3. **Generate task list**
   - Create markdown checkboxes from acceptance criteria
   - Add implementation tasks from the plan
   - Insert task list after the plan title

4. **Update plan frontmatter**
   - Set `status` to `in-development`
   - Set `startDate` to today if not set
   - Update `updated` timestamp
   - Set `progress` to 0

5. **Begin implementation**
   - Use TodoWrite for internal task tracking
   - Work through each task systematically
   - Check off tasks as completed
   - Update progress percentage

6. **Calculate progress**
   - Progress = (completed checkboxes / total) x 100
   - Round to nearest integer

7. **Final updates**
   - Set `status` to `in-review` when complete
   - Set `progress` to 100
   - Follow the project's documentation requirements for added, significantly expanded, or removed notable capabilities. If the project maintains a feature inventory, apply its inclusion criteria: document meaningful capabilities, group supporting details, and omit routine polish such as elapsed-time counters or button placement. Report the affected section, or report "No inventory impact" with a short reason. In a parallel batch, slices send capability changes and evidence to the integrating session; that session owns the shared inventory update and applies it before the final handoff. Keep any separate commit-time changelog rule intact.

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

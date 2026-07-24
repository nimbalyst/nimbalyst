# Agent Instructions for Nimbalyst Integration

This document provides concise instructions for AI agents working with projects that use Nimbalyst's structured planning and tracking systems.

## Plan Documents

### Location and Naming
- **Directory**: All plans must be stored in the `plans/` folder at the repository root
- **File naming**: Use descriptive kebab-case names (e.g., `agentic-markdown-planning-system.md`)
- **Single source of truth**: Plans serve as the authoritative record for features, bugs, and development tasks

### Required Frontmatter
Every plan document MUST include YAML frontmatter with complete metadata:

```yaml
---
planStatus:
  planId: plan-[unique-id]        # Unique identifier for the plan
  title: [Plan Title]             # Human-readable title
  status: [status]                # See status values below
  planType: [type]                # See plan types below
  priority: low | medium | high | critical
  owner: [username]               # Primary owner/assignee
  tags:                           # Relevant tags for categorization (optional)
    - [tag1]
    - [tag2]
  created: "YYYY-MM-DD"
  updated: "YYYY-MM-DDTHH:MM:SS.sssZ"
  progress: [0-100]               # Completion percentage
  dueDate: "YYYY-MM-DD"           # Due date (optional)
  startDate: "YYYY-MM-DD"         # Start date (optional)
---
```

### Status Values
- `draft` - Initial planning phase
- `ready-for-development` - Approved and ready for implementation
- `in-development` - Currently being worked on
- `in-review` - Implementation complete, pending review
- `completed` - Successfully completed
- `rejected` - Plan has been rejected or cancelled
- `blocked` - Progress blocked by dependencies

### Plan Types
- `feature` - New feature development
- `bug-fix` - Bug fix or issue resolution
- `refactor` - Code refactoring/improvement
- `system-design` - Architecture/design work
- `research` - Research/investigation task

### Document Structure
After the frontmatter, plans should include:
1. **Title**
2. **Goals** section outlining objectives
3. **System Overview** or problem description
4. **Implementation details** as needed
5. **Acceptance criteria** when applicable

### Working with Plans
- **Creating plans**: Always include complete frontmatter when creating new plans
- **Updating plans**: Preserve user edits, append updates rather than overwriting
- **Status tracking**: Update `status`, `progress`, and `updated` fields as work progresses
- **Collaboration**: Plans support both human and agent contributors

## Inline Tracker Items

Track bugs, tasks, and ideas directly in any markdown file using inline syntax:

```markdown
- Fix login bug #bug[id:bug_abc123 status:in-progress priority:high owner:alice]
- Add dark mode #task[id:tsk_xyz789 status:to-do priority:medium]
- Research API design #idea[id:ida_def456 status:to-do]
```

Metadata attributes: `id`, `status`, `priority`, `owner`, `tags`, `due_date`


---
name: planning
description: Create structured plan documents and track work items using YAML frontmatter. Use when the user wants to plan a feature, track progress, log bugs/tasks/ideas, or organize project work.
---

# Planning and Tracking System

Nimbalyst uses structured markdown documents with YAML frontmatter for planning and tracking work.

## Plan Documents

Plans live in `nimbalyst-local/plans/` with YAML frontmatter:

```yaml
---
planStatus:
  planId: plan-[unique-identifier]
  title: [Plan Title]
  status: draft
  planType: feature
  priority: medium
  owner: [owner-name]
  stakeholders: []
  tags: []
  created: "YYYY-MM-DD"
  updated: "YYYY-MM-DDTHH:MM:SS.sssZ"
  progress: 0
---
```

### Status Values

- `draft`: Initial planning phase
- `ready-for-development`: Approved and ready to start
- `in-development`: Currently being worked on
- `in-review`: Implementation complete, pending review
- `completed`: Successfully completed
- `rejected`: Plan has been rejected
- `blocked`: Progress blocked by dependencies

### Plan Types

- `feature`: New feature development
- `bug-fix`: Bug fix or issue resolution
- `refactor`: Code refactoring/improvement
- `system-design`: Architecture/design work
- `research`: Research/investigation task
- `initiative`: Large multi-feature effort
- `improvement`: Enhancement to existing feature

## Tracking Items

Track bugs, tasks, ideas, and other items in `nimbalyst-local/tracker/`:

```markdown
- [Brief description] #[type][id:[idPrefix]_[ulid] status:[default-status] priority:medium created:YYYY-MM-DD]
```

### CRITICAL: Custom Tracker Types

**Before creating any tracker item, always check `.nimbalyst/trackers/*.yaml` in the workspace root for custom tracker type definitions.** Each YAML file defines a tracker type with:
- `type`: The type name used in `#[type][...]` syntax (e.g., `devblog-post`)
- `idPrefix`: The prefix for generated IDs (e.g., `dev` produces `dev_abc123`)
- `fields`: Available fields including status options with custom values
- `sync`: Whether items sync to the team (shared/local/hybrid)

**Always use the exact `type` name from the YAML when creating items.** Do not substitute a built-in type when a custom type matches the user's intent.

### Built-in Tracker Types

- **bugs.md**: Issues and defects (`#bug`, prefix: `bug`)
- **tasks.md**: Work items and todos (`#task`, prefix: `tsk`)
- **ideas.md**: Concepts to explore (`#idea`, prefix: `id`)
- **decisions.md**: Important decisions (`#decision`, prefix: `dec`)
- **plans.md**: Plans and features (`#plan`, prefix: `pln`)

### Custom Tracker Types (per-workspace)

Defined in `.nimbalyst/trackers/*.yaml`. Examples:
- **feature-requests.md** (`#feature-request`, prefix: `feat`)
- **tech-debt.md** (`#tech-debt`, prefix: `debt`)
- **devblog-posts.md** (`#devblog-post`, prefix: `dev`)
- Any other type defined in the workspace's YAML files

## When to Use

- **Creating plans**: When user wants to plan a feature, project, or initiative
- **Tracking items**: When user mentions bugs, tasks, ideas, or wants to log something
- **Progress updates**: When completing work, update plan status and progress
- **Implementation**: Use /implement to execute a plan with progress tracking
- **Board cleanup**: Use /session-cleanup to tidy the Sessions board -- fix session phases, mark finished work complete, and flag old sessions to archive

## File Naming

- Plans: `nimbalyst-local/plans/[descriptive-name].md` (kebab-case)
- Trackers: `nimbalyst-local/tracker/[type]s.md` (pluralize the type name)

## Best Practices

- Always check `.nimbalyst/trackers/` for custom types before using built-in types
- Keep plans focused on a single objective
- Update progress regularly as work proceeds
- Use appropriate priorities (low, medium, high, critical)
- Link related plans and tracker items
- Include stakeholders who need visibility

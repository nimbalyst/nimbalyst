# Creating Custom Trackers

## Overview

Nimbalyst lets you track anything in your workspace using custom trackers. Want to track book characters, recipes, wine collections, or research papers? Just create a YAML file.

Built-in trackers: Plans, Decisions, Bugs, Tasks, Ideas, Features, Automations
Custom trackers: Anything you want

## Quick Start

Create `.nimbalyst/trackers/character.yaml` in your workspace:

```yaml
type: character
displayName: Character
displayNamePlural: Characters
icon: person
color: "#8b5cf6"

modes:
  inline: true        # Allow #character[...] in any doc
  fullDocument: true   # Allow full profile documents

fields:
  - name: name
    type: string
    required: true
  - name: phase
    type: select
    default: draft
    options:
      - { value: draft, label: Draft }
      - { value: active, label: Active }
      - { value: complete, label: Complete }
  - name: series
    type: string
  - name: lead
    type: user

# Map semantic roles to YOUR field names
roles:
  title: name
  workflowStatus: phase
  assignee: lead
```

Restart Nimbalyst. Now type `#character` in any document.

## Schema Roles

Roles tell Nimbalyst which of your fields serve standard purposes. This is how the product knows which field to use for kanban columns, priority sorting, assignee filtering, etc. -- without assuming your fields are named `status` or `priority`.

```yaml
roles:
  title: name              # Which field is the item title?
  workflowStatus: phase    # Which field drives kanban columns and status badges?
  priority: importance      # Which field is used for priority sorting/filtering?
  assignee: lead           # Which field identifies the assigned person?
  reporter: submitter      # Which field identifies who reported the item?
  tags: categories         # Which field holds tags/labels?
  startDate: startDate     # Which field is the start date?
  dueDate: deadline        # Which field is the due date?
  progress: completion     # Which field tracks progress (0-100)?
```

All roles are optional. If a role isn't declared, Nimbalyst falls back to conventional names (`title`, `status`, `priority`, `owner`, etc.).

## Reference

### Basic Structure

```yaml
type: character              # Unique ID (lowercase, hyphenated)
displayName: Character       # Shown in UI
displayNamePlural: Characters
icon: person                 # Material Symbols icon name
color: "#8b5cf6"            # Hex color
idPrefix: chr                # ID prefix (3-4 chars)
idFormat: ulid               # ulid, uuid, or sequential
```

Icons: Browse [Material Symbols](https://fonts.google.com/icons) - use any icon name

### Modes

```yaml
modes:
  inline: true           # Allow #character[...] references
  fullDocument: true     # Allow full profile documents
```

Use inline-only for lightweight items (tags, quick notes)
Use fullDocument-only for detailed profiles (plans, comprehensive docs)
Use both for flexibility

### Fields

```yaml
fields:
  - name: title
    type: string | text | number | select | multiselect | date | datetime | boolean | user | array | object
    required: true
    default: "value"
    displayInline: true    # Show in inline tracker markers
    readOnly: false        # Prevent editing
  - name: status
    type: select
    options:
      - { value: active, label: Active, icon: check_circle, color: "#22c55e" }
```

Field types: `string`, `text`, `number`, `select`, `multiselect`, `date`, `datetime`, `boolean`, `user`, `reference`, `array`, `object`

### Sync Policy

```yaml
sync:
  mode: shared     # local (never sync), shared (always sync), hybrid (per-item choice)
  scope: project   # project (git remote) or workspace (local path)
```

### Layouts

```yaml
# Status bar (full documents)
statusBarLayout:
  - row:
    - { field: phase, width: 200 }
    - { field: importance, width: 150 }

# Inline display
inlineTemplate: "{icon} {name} ({phase})"

# Table view
tableView:
  defaultColumns: [name, phase, lead, updated]
```

### Frontmatter Format

Full-document tracker items use `trackerStatus` frontmatter:

```yaml
---
trackerStatus:
  type: character
name: Aragorn
phase: active
series: Lord of the Rings
lead: tolkien@example.com
---

# Character Profile

Aragorn, son of Arathorn...
```

The `trackerStatus` block holds only the `type` field. All other fields go at the top level of the frontmatter, making them compatible with external tools (Astro, Hugo, etc.).

## MCP Tool Usage

AI agents interact with trackers via MCP tools:

```
tracker_create:
  type: character
  title: "Aragorn"       # Mapped to the 'title' role field
  fields:                # Generic field bag for any schema field
    series: "Lord of the Rings"
    phase: active
    lead: tolkien@example.com

tracker_update:
  id: chr_abc123
  fields:
    phase: complete
    series: "LOTR Extended"
  unsetFields: [lead]    # Remove a field value

tracker_list:
  type: character
  where:                 # Generic field-level filters
    - { field: phase, op: "=", value: active }
    - { field: series, op: contains, value: "Ring" }
```

## Tips

**Naming**:
- Type: `lowercase-hyphenated`
- Display: `Title Case`
- Fields: `camelCase`
- ID prefix: `3-4 chars`

**When to use**:
- Inline: Quick refs, lightweight items
- Full docs: Detailed profiles, rich content
- Both: Flexible tracking

**Auto-managed**: Fields named `created` and `updated` are auto-managed timestamps

## Troubleshooting

**Not loading**: Check `.nimbalyst/trackers/yourtype.yaml` location, verify YAML syntax, restart app
**No typeahead**: Set `modes.inline: true`
**No status bar**: Set `modes.fullDocument: true`, use `trackerStatus:` frontmatter
**Kanban columns wrong**: Declare `roles.workflowStatus` pointing to your status field
**Priority sorting wrong**: Declare `roles.priority` pointing to your priority field

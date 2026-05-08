---
packageVersion: 1.0.0
packageId: core
---
# /track Command

Create a tracking item using the Nimbalyst tracker system.

## Usage

When the user types `/track [type] [description]`:

Where `[type]` is the tracker type (e.g., bug, task, idea, feature, decision, feedback, tech-debt, etc.)

1. Parse the type and description from the command
2. Determine priority based on description keywords:
  - "critical", "urgent", "blocking" -> critical/high
  - "nice to have", "minor", "low" -> low
  - Otherwise -> medium
3. Create the tracker item using `tracker_create`
4. Confirm to the user with the item ID and title

## How to Create

Use the `tracker_create` MCP tool:

```
tracker_create({
  type: "[type]",
  title: "[description]",
  priority: "[priority]",
  labels: ["[area]"],  // infer from context if possible
  description: "[optional longer description if the user provided extra context]"
})
```

## Supported Types

- **bug**: Issues and defects that need fixing
- **task**: Work items and todos
- **idea**: Concepts and proposals to explore
- **decision**: Important decisions and their rationale
- **feature**: Feature requests
- **feedback**: User feedback and insights
- **tech-debt**: Technical debt items

## Examples

```
/track bug Login fails on mobile Safari
/track task Update API documentation
/track idea Add dark mode support
/track feature Export to PDF functionality
/track decision Use PostgreSQL for database
/track feedback Users find settings page confusing
```

## Notes

- `tracker_create` does NOT auto-link the new item to the current session. Pass `linkSession: true` to opt in, or call `tracker_link_session` afterward.
- Use `tracker_link_session` to link an existing tracker item to the current session.

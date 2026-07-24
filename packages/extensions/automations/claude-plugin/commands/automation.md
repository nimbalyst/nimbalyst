---
description: Create or manage an automation
---

# /automation Command

Create a new scheduled automation that runs an AI-powered task on a recurring basis.

## Overview

Automations are markdown files with YAML frontmatter that define a schedule, output mode, and an AI prompt. When enabled, the automation runs at the configured schedule and writes results to the specified output location.

## File Location and Naming

**Location**: `nimbalyst-local/automations/[descriptive-name].md`

**Naming conventions**:
- Use kebab-case: `standup-summary.md`, `weekly-report.md`
- Be descriptive: The filename should clearly indicate what the automation does

## Required YAML Frontmatter

```yaml
---
automationStatus:
  id: [unique-kebab-case-id]
  title: [Human-Readable Title]
  enabled: false
  schedule:
    type: weekly
    days: [mon, tue, wed, thu, fri]
    time: "09:00"
  output:
    mode: new-file
    location: nimbalyst-local/automations/[id]/
    fileNameTemplate: "{{date}}-output.md"
  runCount: 0
---
```

## Schedule Types

### Daily
Runs once per day at the specified time.
```yaml
schedule:
  type: daily
  time: "09:00"
```

### Weekly
Runs on specific days of the week at the specified time.
```yaml
schedule:
  type: weekly
  days: [mon, tue, wed, thu, fri]
  time: "09:25"
```

Valid days: `mon`, `tue`, `wed`, `thu`, `fri`, `sat`, `sun`

### Interval
Runs at a fixed interval in minutes.
```yaml
schedule:
  type: interval
  intervalMinutes: 60
```

## Output Modes

### new-file (default)
Creates a new file for each run. Supports template variables in `fileNameTemplate`:
- `{{date}}` - Current date (YYYY-MM-DD)
- `{{time}}` - Current time (HH-MM-SS)

### append
Appends each run's output to a single file at `location`.

### replace
Overwrites the output file on each run.

## Usage

When the user types `/automation [description]`:

1. Understand what the user wants to automate
2. Generate a unique `id` from the description (kebab-case)
3. Choose an appropriate schedule type based on the description
4. Choose an appropriate output mode
5. Write a detailed AI prompt in the markdown body that will produce the desired output
6. Create the file in `nimbalyst-local/automations/` with proper frontmatter
7. Set `enabled: false` so the user can review before activating
8. Tell the user to open the file and use the document header controls to adjust the schedule and enable it

## Prompt Body

The markdown body below the frontmatter is the AI prompt that runs on each scheduled execution. Write it as clear instructions for an AI agent. Include:

- What information to gather or analyze
- What format the output should be in
- Any workspace context the AI should consider

## Example

```markdown
---
automationStatus:
  id: standup-summary
  title: Daily Standup Summary
  enabled: false
  schedule:
    type: weekly
    days: [mon, tue, wed, thu, fri]
    time: "09:25"
  output:
    mode: new-file
    location: nimbalyst-local/automations/standup-summary/
    fileNameTemplate: "{{date}}-standup.md"
  runCount: 0
---

# Daily Standup Summary

Review the git log and recent file changes in this workspace since the previous business day. Summarize:

1. **What was accomplished** - List completed work based on commits and file changes
2. **What's in progress** - Identify files with uncommitted changes or recent branches
3. **Any blockers** - Note any error logs, failing tests, or stale branches

Format as a concise standup update suitable for sharing with the team.
```

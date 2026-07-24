# Automations Extension

Schedule recurring AI-powered tasks in Nimbalyst. Automations are markdown files with YAML frontmatter that define a schedule, an AI prompt, and where to write the output. When enabled, the scheduler runs the prompt at the configured time and saves results to the output location.

## How It Works

1. Create a `.md` file in `nimbalyst-local/automations/` with an `automationStatus` YAML frontmatter block
2. Write the AI prompt in the markdown body below the frontmatter
3. Open the file in Nimbalyst -- a document header appears with schedule controls, a model selector, and a "Run" button
4. Configure the schedule and enable the automation
5. The scheduler fires at the configured times, sends the prompt to the selected AI provider, and writes results to the output directory

The extension scans `nimbalyst-local/automations/*.md` on activation and every 30 seconds for changes. It uses `setTimeout` chains (not `setInterval`) for timer precision and updates the frontmatter after each run with status, timestamps, and run count.

## Quick Start

Create `nimbalyst-local/automations/my-automation.md`:

```yaml
---
automationStatus:
  id: my-automation
  title: My Automation
  enabled: false
  schedule:
    type: daily
    time: "09:00"
  output:
    mode: new-file
    location: nimbalyst-local/automations/my-automation/
    fileNameTemplate: "{{date}}-output.md"
  runCount: 0
---

# My Automation

Your AI prompt goes here. This is the instruction the AI will execute on each run.
```

Open the file and use the document header to adjust the schedule, pick a model, and toggle it on.

## Frontmatter Reference

All fields live under the `automationStatus` key:

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `id` | string | yes | Unique kebab-case identifier |
| `title` | string | yes | Human-readable name shown in the header and session list |
| `enabled` | boolean | yes | Whether the scheduler should run this automation |
| `schedule` | object | yes | When to run (see Schedule Types below) |
| `output` | object | yes | Where and how to write results (see Output Modes below) |
| `provider` | string | no | AI provider: `claude-code`, `claude`, or `openai` |
| `model` | string | no | Model ID (e.g., `claude-code:sonnet`). Defaults to workspace default |
| `runCount` | number | yes | Number of completed runs (updated automatically) |
| `lastRun` | string | no | ISO timestamp of last run (updated automatically) |
| `lastRunStatus` | string | no | `success` or `error` (updated automatically) |
| `lastRunError` | string | no | Error message if last run failed (updated automatically) |
| `nextRun` | string | no | ISO timestamp of next scheduled run (updated automatically) |

## Schedule Types

### Daily

Runs once per day at the specified time (local timezone).

```yaml
schedule:
  type: daily
  time: "09:00"
```

### Weekly

Runs on specific days at the specified time.

```yaml
schedule:
  type: weekly
  days: [mon, tue, wed, thu, fri]
  time: "09:00"
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

### `new-file` (default)

Creates a new file for each run. The `fileNameTemplate` supports these variables:

- `{{date}}` -- current date as `YYYY-MM-DD`
- `{{time}}` -- current time as `HH-MM-SS`

```yaml
output:
  mode: new-file
  location: nimbalyst-local/automations/my-automation/
  fileNameTemplate: "{{date}}-output.md"
```

### `append`

Appends each run's output to a single `output.md` file with date headers.

```yaml
output:
  mode: append
  location: nimbalyst-local/automations/my-automation/
```

### `replace`

Overwrites a single `output.md` file on each run.

```yaml
output:
  mode: replace
  location: nimbalyst-local/automations/my-automation/
```

## Document Header

When you open an automation file, a header bar appears above the editor with:

- **Enable/disable toggle** -- start or stop scheduling
- **Schedule type selector** -- switch between daily, weekly, and interval
- **Day picker** -- select days of the week (weekly mode only)
- **Time input** -- set the run time (daily/weekly modes)
- **Interval input** -- set minutes between runs (interval mode)
- **Model selector** -- choose which AI model to use
- **Status indicator** -- shows last run time and success/error state
- **Outputs dropdown** -- lists output files with click-to-open
- **Run button** -- trigger the automation immediately regardless of schedule

Changes made in the header update the YAML frontmatter in-place.

## AI Tools

The extension registers three AI tools that any agent session can use:

### `automations.list`

Lists all automation definitions in the workspace with their name, schedule, enabled status, and run count.

### `automations.create`

Creates a new automation file with the specified id, title, prompt, schedule, and output configuration. The new automation starts disabled so the user can review it first.

Parameters: `id`, `title`, `prompt`, `schedule_type`, `time`, `days`, `interval_minutes`, `output_mode`

### `automations.run`

Manually triggers an automation by its ID or file path.

Parameters: `id` (the automation ID like `standup-summary`, or the full relative path)

## Claude Plugin

The extension also ships a `/automation` slash command via the `claude-plugin` directory. When a user types `/automation [description]` in an agent session, the agent creates a properly formatted automation file based on the description.

## Architecture

```
src/
  index.tsx              # Extension entry point (activate/deactivate, AI tools, component exports)
  components/
    AutomationDocumentHeader.tsx   # Document header React component
  frontmatter/
    parser.ts            # YAML frontmatter parsing and updating
    types.ts             # TypeScript types for automation config
  scheduler/
    AutomationScheduler.ts   # Timer management, file discovery, execution
    scheduleUtils.ts         # Next-run calculation, formatting
  output/
    OutputWriter.ts      # Writes results in new-file, append, or replace mode
  styles.css             # Document header styles
```

### Execution Flow

1. `activate()` creates an `AutomationScheduler` and an `OutputWriter`
2. The scheduler scans `nimbalyst-local/automations/*.md` for files with valid `automationStatus` frontmatter
3. For each enabled automation, it calculates the next run time and sets a `setTimeout`
4. When a timer fires, the scheduler reads the latest prompt body from the file, calls the `onFire` callback
5. The callback sends the prompt to the AI provider via `services.ai.sendPrompt()`
6. The `OutputWriter` writes the response to the configured output location
7. The scheduler updates the frontmatter with `lastRun`, `lastRunStatus`, `runCount`, and `nextRun`
8. A new timer is set for the next run

### Extension Services Used

- **filesystem**: `readFile`, `writeFile`, `fileExists`, `findFiles` -- all paths resolve relative to the workspace root
- **ui**: `showInfo`, `showWarning`, `showError` -- toast notifications for run status
- **ai**: `sendPrompt` -- sends the prompt to the configured AI provider and returns the response

## Example: Changelog Digest

See `nimbalyst-local/automations/claude-changelog-digest.md` for a working example that fetches and summarizes changelogs from Claude Code and the Claude Agent SDK daily at 8:00 AM.

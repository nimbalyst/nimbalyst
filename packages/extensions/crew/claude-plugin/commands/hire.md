---
description: Design and hire a new crew member by describing the job
---

Hire a crew member for: $ARGUMENTS

A crew member is a long-running agent with a name, a role, a personality, a schedule of shifts, and a job description. Each shift runs as an ordinary session in this project. You design the member with the user, then write it with the `crew_hire` tool.

## 1. Understand the job

If the job above is empty, ask the user what the member should do. Then look at what already exists so the new member fits in:

- Read the existing definitions in `nimbalyst-local/crew/*.md` (if any). Avoid a duplicate role, reuse the crew's quiet hours, and pick a color nobody else has.
- If the job refers to project tools, files, or conventions, check them so the job description names real things.

## 2. Ask before you guess

Use your interactive question tool, in one prompt where you can, for anything the job does not already settle:

- **When it runs**: which days and times, or an interval. Suggest a rhythm that fits the job (a daily digest, a weekday morning sweep, an hourly check).
- **How loudly it reaches the user**: `note` (feed only), `flag` (desktop notification), or `page` (desktop and phone). Default to `flag`.
- **Quiet hours**, if the crew has none yet.
- **What it may change**: read-only reporting, filing tracker items, or delegating fixes to coding sessions. Delegating needs a larger weekly budget.

Skip a question the user has already answered. Do not ask about the model unless the user brings it up.

## 3. Draft the definition

The file is YAML frontmatter under a `crew:` key, then the job as the markdown body:

```markdown
---
crew:
  name: Ada
  role: Architect
  color: "#7c6cf2"
  provider: claude-code
  model: sonnet
  personality: Calm, dry, allergic to accidental complexity. Speaks in short paragraphs and names the specific file and function.
  schedule:
    - daily: "18:30"
      prompt: Review today's merged work for architectural drift.
    - weekly:
        days: [monday, wednesday, friday]
        time: "09:00"
      prompt: Sweep the tracker for stale design decisions.
  notify:
    maxLevel: flag
    quietHours: "22:00-08:00"
  budget:
    tokensPerWeek: 60000000
    shiftsPerDay: 6
---
You are the project's architect. Each evening, read what changed today and look for problems that are cheap now and expensive later.

- ...
```

Field rules (the tool rejects anything else):

- `name` and `role` are required. `name` is a short first name; the file name is derived from it.
- `color` is a quoted hex color. `provider` defaults to `claude-code` with model `sonnet`; `openai-codex` uses `gpt-6.1-sol`.
- `schedule` is a list. Each entry has a `prompt` (what to do on that run) and exactly one timing:
  - `daily: "HH:mm"` (quoted, 24-hour, local time)
  - `weekly: { days: [monday, ...], time: "HH:mm" }` (full lowercase weekday names)
  - `interval: { minutes: N }` (at least 15)
  - `at: "2026-10-01T15:00:00Z"` (one-off ISO time)
- `notify.maxLevel` is `note`, `flag`, or `page`. `notify.quietHours` is a quoted range like `"22:00-08:00"`.
- `budget.tokensPerWeek` counts all tokens including cache reads: 60000000 fits two read-only shifts a day, and a member that delegates coding sessions needs about 150000000. `budget.shiftsPerDay` caps runs per day and defaults to 6.
- Leave out an empty schedule entry rather than writing a placeholder. A member with no schedule only runs when started by hand.

Write the body as direct instructions to the member: what each shift is for, what counts as worth flagging, what it must not do, and where it keeps any artifact it owns. Bullets, one idea each. The member already has a journal, long-term notes, and tools to flag the user and adjust its own schedule, so don't explain those.

## 4. Confirm, then hire

Show the user the full draft and ask whether to hire as is or change something. When they approve, call `crew_hire` with the whole file as `definition`. If the result is a validation error, fix the named fields and call again without asking the user, unless the fix changes something they chose.

On success, tell the user the member's name, where the file lives, and when its first shift runs. It appears in the Crew panel's roster, where they can pause it, start a shift, or open the file to edit it.

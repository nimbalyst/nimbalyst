---
name: analyze-sessions
description: Audit recent AI coding sessions to find repeated mistakes, speed losses, and missed Nimbalyst tool usage — then propose harness improvements
---
# /analyze-sessions Command

Audit recent Nimbalyst AI coding sessions and propose improvements to the **agent harness**: the rules, memory, agent-mistakes log, and CLAUDE.md guidance that shape how future sessions behave. The goal is to make subsequent sessions get the right answer faster and avoid repeating known failures.

**Read-only by default.** Produce a structured report, then use `PromptForUserInput` to let the user pick which suggested changes to apply.

## Usage

`/analyze-sessions [<time-period>|<count>|all]`

- **No argument (default)** — analyze the **current session**. If the current session is part of a workstream, analyze **every session in that workstream** instead.
- `1d`, `3d`, `1w` — sessions active within the time window
- A bare number (e.g. `20`) — most recent N sessions across the workspace
- `all` — explicitly request workspace-wide scan (capped at 30 most recent)

The default is intentionally narrow: most of the time the user runs this right after finishing a piece of work, and the most actionable signal is in the session they just finished (or the parallel sessions on the same workstream).

## What to look for

Three categories. The point is to find **patterns**, not to grade individual sessions.

### 1. Repeated mistakes

A mistake the agent makes once is a log entry. A mistake repeated across multiple sessions is a missing rule. Look for:

- The same correction from the user ("don't do X", "stop doing Y") across more than one session
- Repeated tool misuse (wrong tool reached for, same tool used incorrectly)
- Repeated misreadings of the codebase (wrong file, wrong abstraction, wrong assumption)
- Things already in `.claude/agent-mistakes.md` or `MEMORY.md` that the agent did again anyway

For each repeated mistake, decide whether it needs:
- A new entry in `.claude/agent-mistakes.md` (one-off but notable)
- A new rule file in `.claude/rules/` (recurring, deserves a permanent rule)
- A new memory entry under `/Users/ghinkle/.claude/projects/-Users-ghinkle-sources-stravu-editor/memory/` (feedback type, with **Why:** and **How to apply:**)
- An update to an existing rule/memory (the rule was written but didn't catch this variant)

### 2. Speed losses — where the right answer took too long

Where did the agent burn turns or tokens without progress? Look for:

- **Multi-turn corrections** — the user had to say "no, the other way" more than once before the agent landed the fix. Was there a signal earlier in the conversation the agent should have picked up?
- **Wide-then-narrow exploration** — the agent grepped/read 20+ files when a single targeted read would have worked. Was there context (a doc, a CLAUDE.md section, a tracker item) that pointed at the right file directly?
- **Premature implementation** — the agent started editing before understanding the constraint, then had to revert. Should `/investigate` have been invoked?
- **Stale context** — the agent referenced functions, files, or APIs that no longer exist. Is there a memory entry that's gone stale?
- **Unnecessary planning** — the agent wrote a long plan for a one-line fix. Is there a heuristic for when to skip `/design`?
- **Redundant verification** — the agent re-read or re-ran the same thing across multiple turns instead of trusting earlier output.

### 3. Underused Nimbalyst tools

The agent has a rich MCP toolset that frequently goes untouched when it would have helped. Check whether sessions used these where appropriate:

| Tool | Should have been used when… |
| --- | --- |
| `mcp__nimbalyst-extension-dev__database_query` | Agent asked the user to share DB state, or hand-rolled a guess at row contents |
| `mcp__nimbalyst-extension-dev__get_main_process_logs` / `get_renderer_debug_logs` | Agent asked the user to paste logs, or speculated about runtime behavior without checking |
| `mcp__nimbalyst-extension-dev__renderer_eval` | Agent wanted to know runtime DOM/state and asked the user to inspect manually |
| `mcp__nimbalyst-extension-dev__restart_nimbalyst` | Agent asked the user to restart after a main-process change (still requires explicit user approval, but the agent should at least offer) |
| `mcp__nimbalyst-extension-dev__extension_build` / `extension_install` / `extension_reload` / `extension_test_run` | Agent was iterating on an extension and asked the user to rebuild/reinstall manually |
| `mcp__nimbalyst-extension-dev__extension_test_ai_tool` / `extension_test_open_file` | Agent wrote an extension tool but never exercised it |
| `mcp__nimbalyst-extension-dev__get_environment_info` | Agent made code changes without verifying dev-mode is running (CLAUDE.md says to check this first) |
| `mcp__nimbalyst-mcp__capture_editor_screenshot` | Agent described a UI state in prose instead of showing it |
| `mcp__nimbalyst-mcp__display_to_user` | Agent presented tabular numeric data as a markdown table instead of a chart |
| `mcp__nimbalyst-mcp__developer_git_commit_proposal` | User said "propose a commit" / "commit this" and the agent ran `git commit` instead |
| `mcp__nimbalyst-session-context__get_session_summary` | Agent re-derived context the prior session already produced |
| `mcp__nimbalyst-mcp__AskUserQuestion` / `PromptForUserInput` | Agent buried a blocking question in chat instead of using the interactive widget |

These are *suggestions*, not commands the agent must run unprompted — but if a session would have been measurably faster with one of them, that's a harness gap.

## Step 1 — Determine scope

Resolve the inventory based on the argument (or lack thereof):

**No argument (default)**:
1. Call `mcp__nimbalyst-session-context__get_session_summary` with no `sessionId` to identify the **current** session. Note its `workstreamId` (or equivalent grouping field) if present.
2. If the current session belongs to a workstream:
   - Call `mcp__nimbalyst-session-context__get_workstream_overview` (and `get_workstream_edited_files` if useful) to enumerate every session in the workstream.
   - The inventory is **every session in that workstream**, current session included.
   - State in the report: "Workstream scope: `{workstreamName}` — {N} sessions".
3. If the current session does **not** belong to a workstream:
   - The inventory is **just the current session**.
   - State in the report: "Single-session scope: `{sessionId}` — `{title}`".
   - For a single-session run, the bar for promoting a finding to "repeated mistake" obviously can't be met — re-label that section as "Patterns inside this session" (same correction repeated within the conversation, same tool misuse twice, etc.).

**`<time-period>` argument (e.g. `1d`, `3d`, `1w`)**:
- Call `mcp__nimbalyst-session-context__list_recent_sessions` with `includeArchived: false`, filter to sessions with activity inside the window. Cap at 30; note the cap in the report if hit.

**Bare number argument (e.g. `20`)**:
- Call `list_recent_sessions` and take the most recent N. Honor the requested count exactly.

**`all` argument**:
- Same as `1w` but capped at 30 most recent active sessions.

**Always** skip the `/analyze-sessions` orchestrator session itself from the inventory (it would be analyzing its own output).

## Step 2 — Pull summaries

For each session in the inventory, call `mcp__nimbalyst-session-context__get_session_summary` to get:
- Title, phase, tags
- Files edited
- Last user prompt and last assistant response
- Total turn count if available

Run these in parallel where possible — these are independent reads.

Also read once, up front, for cross-referencing:
- `.claude/agent-mistakes.md` (full file)
- `.claude/rules/*.md` (titles and one-line descriptions are enough)
- `MEMORY.md` index (the file is already in context but re-read if needed)

## Step 3 — Classify findings

For each session, jot a short note covering:
- Did the user correct the agent? What correction? Is it already in the mistakes log or rules?
- Were there obvious speed losses (multi-turn corrections, wide grep before a single read would have worked)?
- Did the agent miss a Nimbalyst tool that would have helped?

Then **aggregate across sessions** — a finding only counts as a "repeated mistake" or "pattern" when it shows up in more than one session.

## Step 4 — Output the report

Use this structure. Be terse; one or two sentences per finding. The first heading should reflect the resolved scope (single session, workstream, time window, count, or `all`).

```
## Session analysis — {scope description, e.g. "current session 'Tracker sync fix' (12 turns)" | "workstream 'collab-v3' (4 sessions)" | "last 3 days (8 sessions)"}

### Repeated mistakes / patterns — {N}
{For multi-session scopes: "showed up in >=2 sessions"}
{For single-session scope: "patterns inside this session — same correction or tool-misuse repeated within the conversation"}
- **{short label}** — seen in {sessionIds or turn ranges}. {one-line description}.
    Existing coverage: {agent-mistakes entry / rule / memory file — or "none"}.
    Suggested action: {add rule | extend existing rule | new memory entry | update CLAUDE.md section}.

### One-off mistakes worth logging — {N}
- **{short label}** — session {sessionId}. {one-line description}.
    Suggested action: append to `.claude/agent-mistakes.md`.

### Speed losses — {N}
- **{short label}** — {sessionIds}. {what happened in 1-2 sentences}.
    Hypothesis for faster path: {1 sentence}.
    Suggested action: {new heuristic in CLAUDE.md | new rule | update agent-mistakes | none — judgment call}.

### Underused Nimbalyst tools — {N}
- **{tool name}** — {sessionIds}. Agent {did X manually / asked user for Y} when this tool would have provided it directly.
    Suggested action: {add to CLAUDE.md "Debugging with Log Access Tools"-style section | add to a rule file | nudge in agent-mistakes}.

### Sessions reviewed
{compact list: sessionId — title — turns — outcome (one of: clean, corrected once, multi-correction, abandoned)}
```

End with one summary line:
`Reviewed N sessions over <window>: X repeated mistakes, Y one-offs, Z speed losses, W tool-usage gaps.`

If there are zero findings in every category, say so plainly and stop — don't pad.

## Step 5 — Ask which suggestions to apply

Call `mcp__nimbalyst-mcp__PromptForUserInput` with one `multiSelect` field per non-empty action group. Pre-check every suggestion (`defaultChecked: true`). Skip the prompt entirely if no group has any items.

```
PromptForUserInput({
  title: "Apply harness improvements",
  intro: "Uncheck anything you don't want applied. Submit to apply the rest.",
  submitLabel: "Apply changes",
  cancelLabel: "Skip",
  fields: [
    {
      type: "multiSelect",
      id: "appendAgentMistakes",
      label: "Append to .claude/agent-mistakes.md",
      description: "One-off and pattern entries to record in the mistakes log.",
      items: [
        { id: "{stable-slug}", title: "{short label}", subtitle: "{1 line: where it happened, what to write}", defaultChecked: true }
      ]
    },
    {
      type: "multiSelect",
      id: "newRules",
      label: "Create new .claude/rules/*.md files",
      description: "Recurring patterns that deserve a permanent rule.",
      items: [
        { id: "{filename-without-ext}", title: "{rule title}", subtitle: "{1 line scope: when this rule applies}", defaultChecked: true }
      ]
    },
    {
      type: "multiSelect",
      id: "updateExistingRules",
      label: "Extend existing rules",
      description: "Rules that need a new bullet or section to cover a missed variant.",
      items: [
        { id: "{rule-filename}", title: "{rule title} -- add: {what}", subtitle: "{1 line: what variant was missed}", defaultChecked: true }
      ]
    },
    {
      type: "multiSelect",
      id: "newMemoryEntries",
      label: "Create new memory entries",
      description: "Feedback-type memories with Why / How to apply lines.",
      items: [
        { id: "{memory-filename}", title: "{memory title}", subtitle: "{1 line: the rule and why}", defaultChecked: true }
      ]
    },
    {
      type: "multiSelect",
      id: "claudeMdUpdates",
      label: "Update CLAUDE.md",
      description: "Sections that need to be added, expanded, or corrected.",
      items: [
        { id: "{section-anchor}", title: "{section name} -- {add/expand/correct}", subtitle: "{1 line: what to change}", defaultChecked: true }
      ]
    }
  ]
})
```

If the user cancels, print "No changes applied." and stop.

## Step 6 — Apply approved changes

For each selected suggestion, make the smallest edit that captures the finding. Do not over-write; do not refactor neighboring content.

- **`appendAgentMistakes`** — prepend a new dated entry to `.claude/agent-mistakes.md` following the existing format: `## YYYY-MM-DD: <one-line title>`, then **What happened**, **Fix**, **Lesson**. Reference the offending session IDs.
- **`newRules`** — create the file under `.claude/rules/<id>.md`. Keep it short — a 1-paragraph scope statement plus 3–6 bullet "Key points". Then add one line to the relevant rule-import section in `CLAUDE.md` if it isn't already wildcard-imported.
- **`updateExistingRules`** — add the new bullet/section to the existing rule. Don't rewrite the whole file.
- **`newMemoryEntries`** — write the memory file with the frontmatter (name/description/type) and the body structure required by the auto-memory system (rule, then **Why:** and **How to apply:**). Append a one-line entry to `MEMORY.md`.
- **`claudeMdUpdates`** — add or expand the named section in `CLAUDE.md` with the briefest accurate phrasing. Don't restructure unrelated parts of the file.

After each edit, print a one-line confirmation: `{kind}: {file} -- {short summary}`.

## Step 7 — Stop

Do **not**:
- Commit anything.
- Apply changes that weren't checked in the prompt.
- Re-spawn child sessions to "validate" the suggestions.
- Promote anything to "done" or `complete` phase.

## Constraints

- Read-only until the user confirms via the prompt.
- Don't open or query the PGLite database directly — use `mcp__nimbalyst-extension-dev__database_query` if you need DB state for a finding (rare for this command).
- Don't call `get_session_summary` more than `list_recent_sessions` returned. No expanding the scope mid-run.
- Don't propose adding feature flags, env-var gates, or "safety toggles" — those are anti-patterns per the user's standing feedback (see `feedback_no_unrequested_feature_flags.md`).
- When suggesting rule/memory edits, **read the existing file first** — almost every "missing rule" is actually a "rule needs one more bullet."
- Don't propose suggestions that are already covered by an existing rule/memory/agent-mistakes entry — the finding is then "the agent didn't follow X," and the fix is usually to make X more prominent (e.g. move it earlier in CLAUDE.md), not to write a second copy.
- Match scope to what the user asked. If they passed a tight window (e.g. `1d`), don't expand into older sessions.

## Notes

- Sessions that ended cleanly with no corrections are still useful — they confirm that recent rule additions are working. Mention these briefly in the "Sessions reviewed" list with `outcome: clean`.
- A finding like "agent kept making the same mistake even though it's in the rules" is the most valuable category. The fix in those cases is usually not a new rule but a stronger position for the existing rule (CLAUDE.md "Critical Rules" section, or a memory entry that fires on a more general trigger).
- If a finding only applies to one provider (e.g. Claude Code vs Opus 4.7 in the AI sidebar), note that — the harness change may be provider-specific.
- This command is for **harness improvement**, not session triage. For phase/archival cleanup, use `/session-cleanup` instead.

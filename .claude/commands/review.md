---
name: review
description: Review a design plan, an implementation, or a Nimbalyst session's work (read-only critique)
---

# Review

Critically review whatever the user points you at. This is **not** the built-in PR review command and it is **not** `/review-pr` or `/review-branch` — it is a general-purpose reviewer for design plans and implementations, including work done inside another Nimbalyst session.

## What to review

$ARGUMENTS

**Review exactly what the user named.** Do not widen the scope to the whole branch, the whole repo, or unrelated files. If the argument is ambiguous, ask one clarifying question before reading anything.

## Step 1: Resolve the target

The argument will be one of:

| Argument shape | How to resolve |
| --- | --- |
| A path to a plan/design doc (`design/**/*.md`, `nimbalyst-local/plans/*.md`) | `Read` it. Check its frontmatter (`type`, `status`) — plan docs project into `fm:<type>:<path>` tracker items. |
| A Nimbalyst session (name, id, or "the session that did X") | `mcp__nimbalyst-host__list_recent_sessions` to find it, then `get_session_summary` for what it did and `mcp__nimbalyst-host__get_session_edited_files` for what it changed. Use `get_workstream_overview` if it's part of a workstream. |
| A tracker item (`NIM-123`) | `mcp__nimbalyst-trackers__tracker_get` with `id` (not `itemId`), then follow its linked sessions/files. |
| A file, directory, or module | `Read` / `Glob` it directly. |
| Nothing | Ask what to review. Do not default to the branch diff — that's `/review-branch`. |

Do not re-derive what a sibling session already established. Prefer `get_session_summary` over re-reading every file it touched.

## Step 2: Classify the review

Once resolved, decide which of the two reviews you're doing. A session can be either — check whether it produced a plan or produced code.

- **Design review** — the target is a plan, design doc, or a planning session whose deliverable is a document. Review the *thinking*.
- **Implementation review** — the target is code, or a session that wrote code. Review the *code*, and if there is a governing plan, review the code **against** that plan.

If a session has both (planned then implemented), do the implementation review and include a "plan fidelity" section.

State at the top of your output which review you're doing and what you read to do it.

## Step 3a: Design review

Read the plan in full. Then read enough of the actual codebase to know whether the plan is grounded in reality — a design review that only reads the design doc is worthless. Check the docs the plan touches (see the documentation table in `CLAUDE.md`) and any prior decision tracker items on the topic.

Assess:

- **Problem framing** — is the stated problem the real problem? Is it solving a symptom?
- **Grounding** — do the files, functions, and behaviors the plan cites actually exist and work the way the plan claims? Cite `file:line` where the plan is wrong.
- **Approach** — is this the simplest approach that works? What alternative was not considered, and why would it be better or worse?
- **Prior art** — does something in the repo already do this? Is the plan building a parallel mechanism next to an existing one?
- **Project rules** — does it violate anything in `CLAUDE.md` or `.claude/rules/`? Specifically: personal vs team JWT, D1 vs Durable Object data placement, no env-var API keys, no dynamic imports in main, PGLite/SQLite divergence, no manual floating-element positioning, no direct IPC subscriptions in components.
- **Risk and blast radius** — persisted state, wire protocols, migrations, security boundaries, sync/collab. What breaks for a user with existing data?
- **Verification** — how would anyone know this worked? If the plan requires a restart or a manual UI flow to verify, does it name a failing-test-first step (see `.claude/rules/end-to-end-verification.md`)?
- **Sequencing** — is it decomposed so each slice is independently shippable, or is it a big-bang?
- **Gaps** — what does the plan not say that it needs to? Unanswered questions, undecided trade-offs, hand-waved steps.
- **Over-scope** — what's in the plan that shouldn't be? Speculative generality, unrequested feature flags, abstractions with one caller.

## Step 3b: Implementation review

Read the actual changes. For a session target, use its edited-files list; for a path target, read that code. Also read the surrounding code — a diff read in isolation hides duplication and convention drift.

Assess:

- **Correctness** — does it do what it claims? Walk the real control flow, including error paths and early returns. Give concrete failure scenarios (inputs/state → wrong output), not vague worries.
- **Plan fidelity** — if there's a governing plan, what did the implementation skip, change, or add without saying so? Silent deviations are the finding, not the deviation itself.
- **Completeness** — every callsite updated? Grep for siblings of the pattern that was changed. Half-migrated code is the most common defect here.
- **Tests** — behavioral changes ship with a unit test (`CLAUDE.md` critical rule). Is there one, does it actually exercise the changed behavior, and would it fail without the fix?
- **Reuse and DRY** — does this duplicate an existing utility? Is there a helper it should have used (e.g. `relationshipFieldStorage.ts` for tracker relationship fields)?
- **Project rules** — the same `CLAUDE.md` / `.claude/rules/` checklist as the design review, plus: N+1 queries, `TIMESTAMPTZ`, `camelCase` on the wire, stable kebab-case DOM markers, no `localStorage` in the renderer.
- **Error handling** — fail fast, or log-and-continue masking? Does the change sit inside a `try/catch` that would swallow it silently?
- **Swallowed verification** — did the session claim "fixed" without observing red→green? Say so plainly.
- **Cleanup** — debug logging left on, dead code, unused imports, TODOs, stray files.

Do not report style nits, speculative refactors, or anything you could not defend with a concrete consequence.

## Step 4: Output

Keep it compact. Findings ranked most-severe first. Every finding gets a `file:line` and a concrete consequence.

```markdown
## Reviewing
[What you reviewed and how you resolved it — plan path, session name, tracker key. One line.]

## Verdict
[2-3 sentences. Is this sound, sound-with-fixes, or does it need rework? Be direct — a review that hedges everything is not a review.]

## Findings

### Blocking
[Things that are wrong and must change. Empty section means say "None."]
- **[Short claim]** — `file.ts:42` — [what breaks, concretely]

### Worth fixing
- **[Short claim]** — `file.ts:42` — [consequence]

### Questions
[Things you couldn't determine from what you read, and what would answer them.]

## What's good
[Briefly. Only if genuinely notable — skip if there's nothing to say.]
```

Then call `AskUserQuestion` offering: apply the blocking fixes, apply everything, revise the plan, or stop here.

## Rules

- **Read-only by default.** Do not edit code or plan docs until the user picks an action in step 4. Reading, grepping, `git log`/`git diff`/`git show`, log tools, and database queries are all fine.
- **Do not commit.**
- **Run your own observation commands.** Logs, database, `curl`, `wrangler tail`, `gh` — you have direct tool access. Never ask the user to paste output.
- **Be specific or say nothing.** "Consider adding error handling" is noise. "`applyRemoteItem` at `x.ts:88` trusts `data->'labelsMap'` is an object; on SQLite it's a JSON string, so labels get dropped" is a review.
- **Verify before asserting.** If you claim the plan contradicts the codebase, open the file and confirm it. A confidently wrong review costs more than no review.
- **Fan out wide reads to an `Explore` agent** and keep only the conclusion — don't pull twenty files into the main context.
- **No emojis. No effort or time estimates. No status tables padded with checkmarks.**

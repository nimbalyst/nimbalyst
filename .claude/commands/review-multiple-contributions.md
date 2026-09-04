---
name: review-multiple-contributions
description: Spawn parallel /review-contribution sessions for a batch of PRs, throttled to N at a time, with a final summary table
---

Dispatch one Nimbalyst session per PR to run `/review-contribution` against that PR. Throttle so only `N` sessions run at once. When every review is done, emit one summary table covering all PRs.

This command does **not** review any PR itself. It is pure dispatch + aggregation. The actual reviewing happens inside each spawned session via the `/review-contribution` slash command, which has its own no-touch-the-working-directory rules.

## Argument syntax

`/review-multiple-contributions <PR list> [using <model>] [max <N> at a time]`

At least one PR is required. If `$ARGUMENTS` is empty or no PR identifiers can be parsed, stop and ask for a PR list.

Examples of inputs you must handle:

- `/review-multiple-contributions 123 456 789`
- `/review-multiple-contributions PRs 123, 456, 573 using opus`
- `/review-multiple-contributions #123 #456 max 5 at a time`
- `/review-multiple-contributions https://github.com/owner/repo/pull/123, https://github.com/owner/repo/pull/456 using sonnet`
- `/review-multiple-contributions 100 101 102 103 104 105 106 107 108 109 max 4 in parallel`

## Parsing $ARGUMENTS

Extract three things:

1. **PR identifiers** -- a list of strings. Accept bare numbers (`123`), hash-prefixed (`#123`), and full GitHub PR URLs. Ignore filler words like `PRs`, `and`, commas, and any phrase you consume for the model or concurrency below. Preserve original order. Deduplicate. If zero are found, stop and ask the user for a PR list.
2. **Model** (optional) -- the text immediately following the keyword `using`, up to the next clause or end of input.
3. **Concurrency** (optional) -- a number adjacent to `max`, `at a time`, `at once`, or `in parallel`. Default to **3**. Clamp to `[1, 10]`.

### Model resolution

Map common shorthand to provider-prefixed identifiers. If the input already contains a colon, treat it as `provider:model` and pass through.

| Input (case-insensitive) | Resolved model |
| --- | --- |
| `opus`, `opus-1m` | `claude-code:opus` |
| `opus-4-6`, `opus 4.6`, `opus4.6` | `claude-code:opus-4-6` |
| `sonnet`, `sonnet-4-5`, `sonnet 4.5` | `claude-code:sonnet` |
| `haiku`, `haiku-4-5` | `claude-code:haiku` |
| `gpt-5`, `codex` | `openai-codex:gpt-5` |
| anything containing `:` | pass through unchanged |

If a model was given but does not match any of the above and has no `:`, stop and use the `AskUserQuestion` tool to confirm the resolved identifier before spawning anything. Do not guess.

If **no model was given**, omit the `model` field on `spawn_session` and set `inheritModel: true`. This makes the spawned reviews use the same model as this dispatcher session, which is the behavior the user expects.

## Workflow

### 1. Fetch PR titles up front

Before spawning anything, fetch the title of every PR **in parallel** so session names are scannable in the sidebar:

```bash
gh pr view <pr> --json title -q .title
```

Run all `gh pr view` calls in a single message as parallel `Bash` tool calls. Cache the results.

### 2. Spawn the first batch

Launch up to `concurrency` sessions immediately. For each PR, call `mcp__nimbalyst-meta-agent__spawn_session` with:

- **`prompt`** -- the literal string below, with no preamble, no instructions, no "please run", no "use the /review-contribution command":

  ```
  /review-contribution <PR#>
  ```

  The prompt MUST start with the slash command on its first line so the spawned session executes the command. Phrasing like "use the `/review-contribution` command" or "please run /review-contribution for PR 123" is **wrong** -- those would be processed as natural language, not as a command invocation. Just the slash command, just the PR number.

- **`title`** -- `"Review PR <#> - <pr title>"`, e.g. `"Review PR 256 - github marketplace install"`. Use the title you fetched in step 1.
- **`isolated`** -- `true`. Each review is its own top-level session in the sidebar, not parented under this dispatcher.
- **`notifyOnComplete`** -- `true`. You will be woken when each spawned session terminates, which is how you know to launch the next one from the queue.
- **`model`** -- the resolved `provider:model` string from parsing, OR omit it and set `inheritModel: true` if the user did not specify a model.

Spawn requests within a batch can be issued as parallel tool calls in a single message.

After spawning the first batch, end your turn. The next user-visible message will be a completion notification.

### 3. Throttle and refill

Track three buckets in your reasoning (you do not need a scratchpad file -- your conversation history is the state):

- **queued** -- PRs not yet spawned
- **in-flight** -- PRs whose spawned session has not yet terminated
- **done** -- PRs whose spawned session has terminated (any terminal status: completed, errored, cancelled)

On each wake-up from a completion notification:

1. Call `mcp__nimbalyst-meta-agent__list_spawned_sessions` to refresh status for every session you have spawned.
2. Move any newly-terminal sessions from **in-flight** to **done**.
3. While `in-flight.length < concurrency` AND `queued.length > 0`, spawn the next PR from **queued** (same parameters as step 2). You can spawn multiple in parallel if more than one slot just opened.
4. If `queued.length === 0` AND `in-flight.length === 0`, proceed to step 4 (Summary).
5. Otherwise end your turn and wait for the next completion.

If your context has drifted and you cannot reconstruct the buckets, you can rebuild them from `list_spawned_sessions` + the original argument list: any original PR with no corresponding spawned session is queued; non-terminal spawned sessions are in-flight; terminal ones are done.

### 4. Summary

Once every review is complete, fetch `mcp__nimbalyst-meta-agent__get_session_result` for each spawned session and emit a single table:

| PR | Title | Verdict | Blockers | Session |
| --- | --- | --- | --- | --- |
| #123 | github marketplace install | SAFE | 0 | `<session-id>` |
| #456 | refactor preload bundling | NEEDS REVIEW | 2 | `<session-id>` |

How to populate each column:

- **Verdict** -- parse `SAFE`, `NEEDS REVIEW`, `RISKY`, or `BLOCK` from the review session's final agent response. The `/review-contribution` output format always includes a `**[SAFE | NEEDS REVIEW | RISKY | BLOCK]**` line near the top. If you cannot find one, use `ERROR`.
- **Blockers** -- count of items in that review's `## Blockers` section. The string `**None.**` means `0`.
- **Session** -- the spawned session ID so the user can click through.

After the table, list each blocker-bearing review with a short bullet (`#NNN: <one-line summary>`) so the user knows which reviews to read first. Do not paste full review bodies into the summary -- those live in their respective sessions.

If any session failed to produce a verdict, surface that explicitly:

> 1 review session errored: `#789` -- click through to inspect.

## Hard rules

- **Never** write a prompt that describes the slash command. The spawned session's prompt must start with the literal characters `/review-contribution `.
- **Never** spawn more than `concurrency` sessions in flight at once.
- **Never** touch the working directory or invoke `gh pr checkout`, `git checkout`, `git fetch`, or any write operation. The dispatcher only runs `gh pr view <pr> --json title -q .title` (read-only) and the spawned sessions inherit `/review-contribution`'s own no-touch rules.
- **Never** post comments, approvals, or review decisions on GitHub from either the dispatcher or the spawned sessions.
- **Never** review a PR inline yourself by reading its diff. The whole point of dispatching is to let parallel sessions do the work. Your job is parse + spawn + throttle + summarize.

# Claude context-overhead manual test

This harness measures the first-turn context cost of Nimbalyst's Claude Code addendum, MCP servers, and extension plugins against a matched raw Claude Code control. It uses the real Claude CLI and Anthropic API; each non-dry run consumes real account quota and may incur cost.

All profiles deliberately share the same prompt, model, working directory, ToolSearch setting, permission mode, and empty user MCP configuration:

- `raw` loads no Nimbalyst MCP servers, addendum, or extension plugins.
- `addendum` loads only the current `buildClaudeCodeSystemPrompt()` output.
- `core` loads only the core MCP endpoint containing the eager core tools.
- `platform-mcp` loads the host, trackers, and situational MCP endpoints.
- `extension-mcp` loads extension MCP endpoints plus extension-dev when available.
- `all-mcp` loads all of the preceding MCP groups without addendum or plugins.
- `plugins` loads only configured extension plugin directories.
- `full` loads the complete Nimbalyst profile. The historical `nimbalyst` argument remains an alias for `full`.

The proxy records byte-exact segment sizes plus estimated tokens at four UTF-8 bytes per token. Actual `contextTokens` from Anthropic usage remain authoritative. Fingerprints are HMAC-SHA256 values keyed with a random secret that exists only for the proxy process, so they can identify byte drift within one experiment without exposing reusable hashes of private prompt text.

## Prerequisites

- Run commands from the repository root.
- Be signed in with the current Claude Code CLI. The default binary is `~/.claude/local/claude`; set `CLAUDE_BIN` to override it.
- Start Nimbalyst before using `nimbalyst` mode. The runner reads the live, user-only `mcp-endpoint.json` descriptor and does not modify Claude settings.
- Install repository dependencies so `npx tsx` can import the runtime prompt.

## Validate configuration without an API call

```bash
for profile in raw addendum core platform-mcp extension-mcp all-mcp plugins full; do
  CLAUDE_CONTEXT_MODEL=haiku CLAUDE_CONTEXT_MAX_BUDGET_USD=0.25 \
    npx tsx scripts/manual-tests/claude-context-overhead/run.ts "$profile" --dry-run
done
```

Dry-run output contains no MCP bearer token. Check the Claude binary, model, MCP server names, extension-dev port, plugin directories, and addendum size.

## Run the ablation matrix

Start the structural proxy in one terminal:

```bash
node scripts/manual-tests/claude-context-overhead/proxy.mjs
```

Keep the same proxy process alive across every case so its fingerprints are comparable. In another terminal, run each profile at least twice. Every case must pass its dry run before the first paid call.

```bash
for repeat in 1 2; do
  for profile in raw addendum core platform-mcp extension-mcp all-mcp plugins full; do
    CLAUDE_CONTEXT_MODEL=haiku \
    CLAUDE_CONTEXT_MAX_BUDGET_USD=0.25 \
    CLAUDE_CONTEXT_RUN_LABEL="r$repeat" \
      npx tsx scripts/manual-tests/claude-context-overhead/run.ts "$profile"
  done
done
```

Summarize actual usage separately from structural estimates:

```bash
node scripts/manual-tests/claude-context-overhead/analyze.mjs \
  /tmp/nimbalyst-claude-context-proxy.jsonl \
  > /tmp/nimbalyst-claude-context-analysis.json
```

For an unregistered live SDK session, list the request families first and then select the target family's HMAC fingerprint:

```bash
node scripts/manual-tests/claude-context-overhead/analyze-live.mjs \
  /tmp/nimbalyst-claude-context-proxy.jsonl
node scripts/manual-tests/claude-context-overhead/analyze-live.mjs \
  /tmp/nimbalyst-claude-context-proxy.jsonl FAMILY_FINGERPRINT
```

The runner writes full Claude stream output to case- and repeat-specific files such as:

- `/tmp/claude-context-overhead-raw-r1.jsonl`
- `/tmp/claude-context-overhead-full-r1.jsonl`

The proxy appends experiment registrations, structural request summaries, and completed usage records to `/tmp/nimbalyst-claude-context-proxy.jsonl`. It records no prompt previews, bearer tokens, or full tool descriptions. Stop it with Ctrl-C after the matrix.

Each request record contains:

- Per-tool bytes, estimated tokens, server membership, order, a whole-schema fingerprint, and fingerprints for every schema leaf.
- Tool and server order fingerprints plus the exact public tool-name membership of each server.
- Per-system-block and per-initial-message-segment bytes, estimated tokens, cache-control type/TTL placement, whole-segment fingerprints, and fingerprints for every private leaf.
- Relevant request-option sizes and fingerprints; only a small allowlist of non-private scalar values such as model and max tokens is emitted directly.
- A privacy-safe comparison with the preceding request, including changed tool schema paths, system blocks, message segments, request options, tool order, and server order.
- A process-scoped request-family fingerprint derived from model plus private request metadata. Live shared-proxy comparisons are isolated by request family and lane so concurrent Nimbalyst sessions cannot contaminate one another's diffs. The metadata itself is never logged.

Run the focused privacy and drift tests with:

```bash
node --test scripts/manual-tests/claude-context-overhead/request-summary.test.mjs
```

## Overrides

- `CLAUDE_BIN`: Claude executable path.
- `CLAUDE_CONTEXT_MODEL`: model alias; defaults to `fable`.
- `CLAUDE_CONTEXT_MAX_BUDGET_USD`: CLI safety cap; defaults to `2`.
- `CLAUDE_CONTEXT_PROMPT`: matched single-turn prompt; defaults to `Reply with only OK.`. The runner logs only its byte size and SHA-256 fingerprint.
- `CLAUDE_CONTEXT_TOOL_SEARCH`: set to `false` for a separately matched ToolSearch-off comparison; defaults to `true`.
- `CLAUDE_CONTEXT_RUN_LABEL`: safe label used to correlate repeats and output files.
- `CLAUDE_CONTEXT_PROXY_URL`: proxy URL; defaults to `http://127.0.0.1:8377`.
- `CLAUDE_CONTEXT_PROXY_LOG`: proxy summary path.
- `NIMBALYST_MCP_DESCRIPTOR`: live MCP descriptor path.
- `NIMBALYST_CONTEXT_SESSION_ID`: optional real Nimbalyst session id for reproducing session-dependent schemas such as live workspace tag counts. The runner logs only that a provided id was used and its fingerprint. Omit it for isolated overhead measurements.
- `NIMBALYST_CONTEXT_HAS_SESSION_NAMING`, `NIMBALYST_CONTEXT_OUT_OF_BAND_NAMING`, and `NIMBALYST_CONTEXT_TRACKERS_ENABLED`: set any to `false` for a controlled system-addendum flag comparison.
- `NIMBALYST_CONTEXT_WORKTREE_PATH`: include a worktree block; only its fingerprint is logged in the run summary.
- `NIMBALYST_CONTEXT_VOICE_MODE`: set to `true` to include the voice-mode block.
- `NIMBALYST_EXTENSION_DEV_PORT`: override extension-dev MCP port detection.
- `NIMBALYST_EXTENSION_MCP_NAMES`: comma-separated extension MCP short names.
- `NIMBALYST_PLUGIN_DIRS`: platform-delimited plugin-directory override.

The built-in extension-name list is a snapshot of the normal development profile. If extensions are added or disabled, use the two override variables so the manual run matches the target session's connected MCP/plugin set.

## Reference result

On 2026-07-21, Claude Code 2.1.210 with `fable` measured:

- Matched raw control: 43,178 context tokens.
- Nimbalyst with 21 connected MCP servers, 303 tools, and extension plugins: 56,250 context tokens.
- Nimbalyst-only delta: 13,072 tokens (30.3%).

Treat these as a historical NIM-1988 checkpoint, not a fixed budget. CLI, prompt, MCP, extension, and repository-context changes can all move the result.

The next controlled matrix, exact byte bill of materials, drift findings, and ranked opportunities are recorded in [RESULTS-2026-07-21.md](./RESULTS-2026-07-21.md).

## Interpretation constraints

- Do not add per-segment four-byte estimates and claim that sum as saved context. Tool framing, tokenization, and SDK-injected content make the heuristic non-additive.
- Use `contextTokens` for measured savings. Use byte and estimated-token reports to rank likely contributors and identify exact drift.
- Isolated profile deltas can include interactions. In particular, plugin directories can add skills, commands, and tools, while ToolSearch can replace eager schemas with an SDK-generated deferred-tool listing. `all-mcp - raw` therefore need not equal `core + platform-mcp + extension-mcp`.
- A ToolSearch-off result is a separate matched experiment. Never compare a ToolSearch-on Nimbalyst profile against a ToolSearch-off raw control.
- Keep the proxy process alive when investigating `tools_changed` or `system_changed`; its HMAC key is intentionally not persisted across restarts.

For a live Agent SDK session, temporarily route Claude Code's `ANTHROPIC_BASE_URL` through the proxy using the Claude Code environment-variable setting, then restore the prior setting immediately after the run. Use an explicit `claude-code:haiku` child, keep its prompts minimal, and compare only records with its request-family fingerprint. This setting is user-global, so do not leave it enabled and expect unrelated Claude sessions to appear concurrently in the log.

Main-process schema changes must be loaded before a live validation. Confirm the observed tool bytes/fingerprint match the source-built schema; a run against an older still-running MCP server is a pre-fix control, not post-fix evidence.

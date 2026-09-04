---
name: audit-updates
description: Triage npm audit findings and produce a prioritized, supply-chain-cautious package-update plan, then apply approved batches
---
Triage the repo's `npm audit` output and dependency drift, then produce a **prioritized, risk-annotated update plan** that fixes real security exposure while avoiding supply-chain traps (compromised fresh releases, unnecessary major bumps, install-script risk).

**This command is two-phase.** Phase 1 investigates and reports a plan — it makes NO changes. Then STOP and wait for explicit user direction. Phase 2 applies the approved updates in small batches, verifying between each. Never edit `package.json`, run `npm install`, or commit during Phase 1.

## Repo facts (don't re-derive)

- Single root `package-lock.json`; npm **workspaces** (not pnpm). Run `npm audit` from the repo root — it covers all workspaces.
- Workspaces: `packages/electron`, `packages/runtime`, `packages/cli`, `packages/core`, `packages/collab-protocol`, `packages/collab-adapters`, `packages/ios`, `packages/android`, `packages/extension-sdk`, `packages/extensions/*`, `packages/marketplace`. Additional package.json files exist for `browser-extension` and `opencode-plugin`.
- **Preserve `peer: true` flags in `package-lock.json`** — some `npm install` configs strip them and break CI for optional native binaries (esbuild platform packages, SDK native deps). Diff the lockfile and restore any stripped `peer: true` before finishing.
- The root `overrides` block pins some deps (e.g. `@anthropic-ai/claude-agent-sdk`). An override must be bumped in lockstep or the upgrade is silently neutered. Never revert `@anthropic-ai/claude-agent-sdk` below 0.2.113.
- Both SDKs ship platform binaries via `extraResources`/`optionalDependencies`; npm silently skips these on stale integrity hashes. Validate binaries survive any bump that touches them.
- The `/update-libs` command owns the three AI SDKs (claude-agent-sdk, MCP sdk, codex-sdk). If audit findings land on those, defer to `/update-libs` rather than bumping them here.

## Security principles (the whole point of this command)

1. **Cooldown window: 21 days.** Never move a dependency to a version published less than ~21 days ago. Supply-chain attacks are usually caught within days-to-weeks of a malicious publish. For each package, target the **newest version that is both (a) at least 21 days old and (b) resolves the advisory.** If the *only* fix is a version younger than 21 days, do NOT auto-recommend it — flag it as "fix requires a fresh release; hold or manually vet" and explain the tradeoff. A live-exploited advisory may justify overriding the cooldown, but call that out explicitly and let the user decide.
2. **Prefer the smallest semver move that clears the advisory.** Patch > minor > major. Never pull a major version bump "while we're here" — majors are a separate, deliberate decision with their own testing.
3. **Prefer transitive fixes via the dependency tree, not blanket `overrides`.** Reach for `npm audit fix` (without `--force`) and targeted version bumps first. Only propose an `overrides` entry when the vulnerable package is transitive and upstream hasn't released a fixed parent yet — and mark such overrides for later removal.
4. **Never run `npm audit fix --force`.** `--force` installs semver-major breaking changes and brand-new releases indiscriminately, defeating both the cooldown and the minimal-move principles.
5. **Scrutinize install scripts.** New/changed `postinstall`/`preinstall`/`install` scripts are a primary supply-chain vector. For any newly-introduced package (not just bumped), note whether it runs install scripts.
6. **Judge reachability, not just severity.** A "critical" in a build-only devDependency reachable only in CI is lower real risk than a "high" in a runtime path shipped to users. Weight: is it a runtime (`dependencies`) or dev/build-only dep? Is the vulnerable code path actually reachable in how Nimbalyst uses it? Is it in the Electron main process, the renderer, the runtime shipped to users, or a build tool?
7. **Watch for new maintainers / typosquats / churn.** If a package changed ownership, was recently transferred, or a name looks like a typosquat of a popular package, flag it — don't silently trust it.
8. **Pin what you resolve.** After fixing, the lockfile is the source of truth. Don't loosen version ranges in `package.json` in a way that lets a future `npm install` silently pull an un-vetted newer release.

---

## Phase 1: Investigate and report (always run first; no changes)

Run these yourself — never ask the user to paste output.

1. **Gather the audit surface:**
   - `npm audit --json` from the repo root (full machine-readable advisory list).
   - `npm audit` (human summary, for the severity counts).
   - `npm outdated --json` (optional, to see how far behind direct deps are — helps spot deps that are old for non-security reasons too).
2. **Group advisories by fixable unit.** Multiple advisories often collapse to one package bump. For each vulnerable package determine: severity, whether it's a direct or transitive dependency, which workspace(s) pull it in, whether it's a runtime vs dev/build dep, and the CVE/GHSA summary (what the vuln actually is).
3. **For each candidate fix, resolve the target version under the cooldown rule:**
   - `npm view <pkg> versions --json` and `npm view <pkg> time --json` to get publish dates.
   - Pick the newest version that clears the advisory AND is ≥21 days old AND is the smallest semver move that works. Record the publish date you're relying on.
   - If no such version exists (fix only in a <21-day release, or fix only in a major), flag it explicitly with the tradeoff.
4. **Assess Nimbalyst-specific impact and reachability** for each — don't just restate the advisory. Note main-process / renderer / runtime / build-tool placement, and whether our code actually exercises the vulnerable path.
5. **Flag anything touching the AI SDKs** and route it to `/update-libs`.
6. **Report using the format below.** Rank by real risk (reachability × severity), not raw severity.
7. **STOP.** End the turn asking which items to apply. Do not modify anything.

### Phase 1 output format

**Audit summary:** N critical / N high / N moderate / N low across M packages.

Then a prioritized table (highest real-risk first):

| # | Package | Sev | Direct/Transitive | Runtime? | Advisory (short) | Current → Target | Target age | Semver move | Notes / reachability |
|---|---------|-----|-------------------|----------|------------------|------------------|-----------|-------------|----------------------|

Then:

- **Recommended batch order** — group into: (A) safe patch/minor fixes to well-aged versions, apply first; (B) fixes needing minor bumps to slightly-newer-but-≥21-day versions; (C) risky/deferred (major bumps, sub-cooldown-only fixes, AI SDKs → `/update-libs`, no-fix-available).
- **Held back by cooldown** — any advisory whose only fix is <21 days old, with the date and the tradeoff.
- **No fix available** — advisories with no upstream fix; note mitigations (is the path reachable? can we drop the dep?).
- **Overrides proposed** — any transitive fix requiring a root `overrides` entry, marked for future removal.
- **Awaiting direction** — ask: "Which batches should I apply? (A / B / specific items / none)"

---

## Phase 2: Apply approved batches (only after user confirms)

Do not start until the user names which items/batches to apply.

Work in **small batches** (ideally one logical group at a time) so a regression is easy to bisect:

1. Snapshot the lockfile first (`git diff --stat package-lock.json` should be clean before you start a batch).
2. Apply the batch:
   - Prefer targeted, pinned installs to the vetted target version (e.g. `npm install <pkg>@<exact-version> -w <workspace>` or at root) over broad `npm audit fix`. If using `npm audit fix`, **never** add `--force`.
   - For transitive-only fixes with no fixed parent, add a scoped `overrides` entry pinned to the exact vetted version, and note it for later removal.
   - Bump any matching root `overrides` in lockstep.
3. **Verify the lockfile diff before trusting it:**
   - Confirm no `peer: true` flags were stripped (restore any that were).
   - Confirm no unexpected packages moved — a security bump should touch the target and its tree, not rewrite unrelated ranges. Investigate surprises before proceeding.
   - Confirm native-binary `optionalDependencies` / integrity entries are intact for anything shipping platform binaries.
4. **Run the gate:** `npm run typecheck && npm run test:prepush`. Never proceed to the next batch on a red suite.
5. For runtime-affecting bumps (Electron main process, renderer, shipped runtime), do a real smoke check of the affected path — don't rely on "types pass."
6. Re-run `npm audit` after each batch and report the delta (which advisories cleared, which remain).
7. After all approved batches, produce a final summary: advisories resolved, advisories intentionally deferred (with reasons), any new `overrides` added (and when to revisit), and any items routed to `/update-libs`.

**Do not commit** unless the user asks. When they do: update `CHANGELOG.md` only if a fix changes user-facing/runtime behavior (most dependency-hygiene bumps do NOT warrant a changelog line per the repo's changelog rules), and propose the commit via the git commit proposal tool. If any fix closes a tracked security issue, include the closing reference.

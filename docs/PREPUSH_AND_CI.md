# Pre-push and CI validation

The shared task inventory is [validation-inventory.mjs](../scripts/validation-inventory.mjs). Run a task with `node scripts/run-validation.mjs <task>`. The pre-push hook and CI both retain the non-provider suite, scanner regression tests and repository invariants, workspace typechecks, and Sandbox artifact/image checks.

- `typecheck` builds workspace prerequisites, runtime exports, and the memory engine, then discovers every workspace defining a typecheck script. CI's `typecheck-ready` runs the same discovery after its explicit workspace/runtime build or exact cache restore.
- `scripts` runs the gate's scanner and policy regression tests, including their current-repository checks, and the UI static invariants. Analytics mutations reuse one source scan instead of rescanning for each synthetic case.
- `sandbox` verifies the private Worker artifact, dependency/image pins, and TypeScript. Installation is reused only when manifests, lockfile, toolchain, and installed file content match the successful-install marker. Missing or altered files cause a real install.
- `unit-build` lists the workspace and collaboration bundle prerequisites. The built-entry store-binding test stays in the full unit suite. CI caches the bundle's JavaScript and declarations with exact source/config/dependency keys; it does not replace the smoke test with a source import.
- `unit` is the exact `test:prepush` invocation. Provider integration tests and authenticated collaborative E2E require separate environments. Local Windows retains its documented [platform exception](WINDOWS_PREPUSH_GATE.md); CI always runs the non-provider suite.
- `transcript` builds the iOS web transcript. CI also checks the output files. This does not establish native iOS or desktop startup acceptance.

## Result records and reuse

`npm run test:last` shows the last invocation and the separately preserved full-suite record. A focused run updates `.vitest/last-run.json` and its human-readable log without overwriting `.vitest/last-full-run.json`. Starting a full run invalidates its prior result before any tests execute; interruption and collection failures cannot leave an old success eligible for reuse.

Only the final Vitest step can be reused. All build, typecheck, static, and Sandbox checks still execute locally. Reuse requires the exact full-suite argv, a complete PASS, and a current Git/content fingerprint (HEAD, the content of every dirty path, and matching Node major and platform/architecture). A dirty tree is fine as long as it is the same dirty tree the suite ran against; that is the normal state of a checkout shared by parallel sessions. Every pushed ref must peel to the checked-out HEAD. Missing state, changed inputs, unresolved/non-HEAD refs, and CI all run the suite. The existing no-new-commits shortcut is separate and unchanged.

The existing gate validates the checked-out working tree. Running it for a non-HEAD ref does not prove that alternate commit's tree; reuse never extends that claim. No additional restriction is imposed on contributor pushes.

Git cannot observe manual changes inside ignored root `node_modules`. After changing installed dependencies without changing a manifest/lockfile, run `npm run test:prepush` explicitly. Generated artifacts are rebuilt by the pre-push typecheck prerequisites. Each hook stage reports elapsed seconds and its exit status in `.vitest/last-prepush.json`.

## CI scheduling

Required job names always report. Only additions/modifications limited to root README, CHANGELOG, CONTRIBUTING, or LICENSE use the documentation-only path. General docs, package Markdown, fixtures, commands, manifests, lockfiles, scripts, workflow/config changes, deletions, and uncertain history use full validation. Renderer-only TypeScript/CSS changes may omit the independent Sandbox artifact checks; shared runtime/protocol/node inputs do not.

Superseded pull-request runs are cancelled. Main runs are retained for release consumers; release and deployment workflows are unaffected. Fork PRs need only the read-only repository token. The node_modules cache is keyed on lockfiles and patches; the runtime build cache is keyed on the runtime and extension-sdk inputs it reads. Neither is keyed on the whole tree, which would change every commit and never hit. The collaboration bundle is built every run because its inputs span several workspaces. There are no partial restore keys. Vitest's file/test counts, elapsed time, and phase summary are saved in the job summary. Phase totals are accumulated across workers, not CPU time.

Worker-count changes and CI sharding need measured latency/resource tradeoffs. This implementation does not increase concurrency, add runner spend, or remove tests based on changed filenames.

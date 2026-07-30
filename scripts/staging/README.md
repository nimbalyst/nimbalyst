# Nimbalyst Candidate Staging

Use `launch-nimbalyst-candidate.ps1` to validate or launch a candidate build
without replacing the installed Nimbalyst process or reusing its state.

The launcher creates one bounded candidate tree under
`D:\Nimbalyst-Staging\candidates\<candidate-id>`:

- `user-data` for Electron settings, logs, and databases;
- `workspace` containing only a staging anchor document;
- `claude-projects` instead of the user's global Claude project history;
- `receipts` with the exact executable, process, paths, port, and non-secret
  environment contract.

Run validation before launch:

```powershell
.\scripts\staging\launch-nimbalyst-candidate.ps1 `
  -CandidateExecutable 'D:\builds\Nimbalyst Candidate.exe' `
  -CandidateId 'ollama-route-01' `
  -ValidateOnly
```

Launch only after the validation receipt has been inspected:

```powershell
.\scripts\staging\launch-nimbalyst-candidate.ps1 `
  -CandidateExecutable 'D:\builds\Nimbalyst Candidate.exe' `
  -CandidateId 'ollama-route-01'
```

To run a compiled app directory through the repository's Electron binary
without packaging a full executable, supply `-CandidateAppPath`. The path must
be absolute, must exist outside `D:\!! CLAUDE` and the incumbent profile, and
must contain a `package.json` whose `main` file exists:

```powershell
.\scripts\staging\launch-nimbalyst-candidate.ps1 `
  -CandidateExecutable 'D:\nimbalyst-ollama-claude-agent\node_modules\electron\dist\electron.exe' `
  -CandidateAppPath 'D:\nimbalyst-ollama-claude-agent\packages\electron' `
  -CandidateId 'ollama-route-source-01' `
  -ValidateOnly
```

When present, the candidate app path is recorded in the receipt and passed as
the first Electron argument, before the isolated workspace and user-data
arguments.

An explicit `-CdpPort` may be supplied. Port `9222` is rejected because it is
the normal default. When omitted, the launcher selects an available loopback
port.

The candidate process receives `NIMBALYST_STAGING_MODE=1`. The app fails
closed unless every isolation variable is present and consistent. Staging mode
uses a distinct Windows AppUserModelID, permits the isolated second instance,
keeps in-process custom schemes, enables CDP on the selected port, and skips
OS `nimbalyst://` registration, Linux AppImage protocol registration,
automatic application update checks, and automatic marketplace-extension
updates.

## Ollama Claude Code live acceptance

`run-ollama-live-acceptance.mjs` consumes a reviewed `status: launched`
receipt. It refuses validation-only receipts, the default CDP port, dead or
non-distinct candidate processes, and paths outside the isolated staging
tree. It reads the candidate-only MCP descriptor without printing or
persisting its bearer token.

The harness creates a candidate-only meta-agent controller through renderer
IPC, calls the authenticated `/mcp/host` `create_session` route with an exact
Ollama backend identity, and waits for two manager turns. GLM-5.2 remains the
default; a non-default route must supply all five target flags together
(`--backend-id`, `--persisted-model`, `--child-model-alias`,
`--ollama-target`, and `--upstream-model`) so partial or mixed identities fail
closed. The first turn must launch one native Claude Code Agent child; the
second must preserve the
manager provider-session ID. Redacted JSON and Markdown receipts are written
under the candidate receipt directory. The isolated candidate is closed when
the run finishes.

Only the live-acceptance owner should run this command:

```powershell
node .\scripts\staging\run-ollama-live-acceptance.mjs `
  --launch-receipt 'D:\Nimbalyst-Staging\candidates\<candidate-id>\receipts\launched-<timestamp>.json'
```

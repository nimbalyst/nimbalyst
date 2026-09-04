## Parallel Sessions Must Not Share Files

Multiple sessions run against this checkout at once. Two sessions editing the same file will clobber each other — a whole-file `Write` silently reverts the other's uncommitted work, and even careful `Edit` calls produce a file neither session can commit without dragging in the other's half-finished change.

Before launching parallel work, list the files each slice will touch and confirm the sets are disjoint. If two slices need the same file, they are one slice — run them sequentially in a single session instead.

### The shared files everyone forgets

A disjointness check that only compares the *source* files is not a disjointness check. These are touched by nearly every task and are the usual collision:

- `CHANGELOG.md` — see below, this one has its own rule
- `CLAUDE.md`, `.claude/rules/*`, `docs/*` — guidance edits
- `package.json` / `package-lock.json` — any dependency change
- Barrel files (`index.ts`), shared type modules, and central registries such as `KeyboardShortcutsDialog.tsx` or a store's atom index
- A large component two slices both need to import from

If a slice's work genuinely requires one of these, it owns that file for the batch and no sibling may touch it.

### Never edit CHANGELOG.md before a commit is requested

**Do not touch `CHANGELOG.md` while implementing.** Write the entry only when the user asks for a commit, as part of preparing that commit — see [/commit](../commands/commit.md).

An entry written early is wrong twice over: it describes code that is not in the tree yet, and it puts every concurrent session into the same file. Five sessions each adding one bullet produced five sessions blocked on the same question about how to stage it, and three of them stopped mid-task to ask.

This applies to a session working alone too. There is no point at which "edit the CHANGELOG now, commit later" is the right order.

### Orchestrator responsibilities

- **Run the gate once.** Slices never run `npm run typecheck` or `npm run test:prepush`; concurrent runs produce false failures. The orchestrator runs it once for the batch. Slices run only their own targeted vitest file.
- **State the constraint in the brief.** Tell each slice which files it owns, that siblings are live in the same checkout, and that it must not use whole-file `Write` on a file it did not create.
- **Re-check anchors after a long wait.** Line numbers you captured before a sibling ran may have moved. Re-grep before editing.
- **Decide the commit split yourself.** Slices that each try to commit will race on shared files. Either they all report back and the orchestrator commits, or each slice commits strictly the files it owns and never the shared ones.
- **A slice that commits does so only on a green targeted test.** If its own test does not pass, it reports back instead of committing. The orchestrator still runs the full gate once for the batch afterwards — a slice's targeted run is not a substitute for it. See [/autofix-issues](../commands/autofix-issues.md) for the fan-out workflow this describes.

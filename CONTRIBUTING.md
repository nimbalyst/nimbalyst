# Contributing

Thanks for your interest in contributing to Nimbalyst.

## Scope

Contributions to this repository are accepted under the [MIT License](./LICENSE).

The collaboration server is a separate project. Clients in this repo talk to it 
over the wire protocol defined in
[`packages/collab-protocol/`](./packages/collab-protocol/).

## How to contribute

1. Open an issue first for substantial changes.
2. Fork the repository and create a focused branch.
3. Make your changes with tests or validation where appropriate.
4. Submit a pull request with a clear description of the change and any user or
   developer impact.

If you want to work on an accepted issue, say so on the issue — we'll assign it to you and can point you at the relevant code before you start.

## Development setup

The repo needs Node 24 (see `.nvmrc`) and pnpm, which is pinned by the `packageManager` field in `package.json`. Node 24 ships corepack, so enable it once and install:

```bash
corepack enable
pnpm install
```

npm is blocked at the repository root: `devEngines` in `package.json` makes any `npm` command there fail with `EBADDEVENGINES`. Use the pnpm equivalent.

All pnpm settings live in the root `pnpm-workspace.yaml`; `.npmrc` holds registry and auth only. Two settings affect day-to-day work:

- `allowBuilds` is an allowlist of packages permitted to run install scripts. A new dependency with an install script fails `pnpm install` until it is added there as `true` or `false`, which is a security decision that reviewers will look at.
- `minimumReleaseAge` is a 72 hour cooldown, so a version published less than 3 days ago will not resolve. Wait for it to age, or add a scoped entry to `minimumReleaseAgeExclude` with a comment giving the reason.

Run a script in one package with `pnpm --filter <package> run <script>`, and run the pre-push gate with `pnpm typecheck && pnpm test:prepush`.

## Review and merge

Every change to `main` arrives through a pull request, and merges need an approving review alongside green required checks and resolved review conversations. [MAINTAINERS.md](./MAINTAINERS.md) describes the roles and who currently holds them.

A small set of release and security-sensitive paths carries an additional ownership requirement, listed in [`.github/CODEOWNERS`](./.github/CODEOWNERS).

Pull requests that change `pnpm-lock.yaml`, `pnpm-workspace.yaml`, or anything in `patches/` need review from the release manager as well as a maintainer, because the signed release build installs dependencies and applies those patches while holding code-signing credentials. See [MAINTAINERS.md](./MAINTAINERS.md). These land a little slower; that is expected and not a reflection on the change.

## Commit authorship

Every commit in a pull request must be authored by the person who wrote it. Before you commit, confirm your identity is your own and not something the checkout, container, or agent worktree inherited:

```bash
git config user.name    # your name
git config user.email   # an email attached to your account
```

Commits authored under someone else's name are rejected, even when the code itself is fine. Contributors get credit for their own work, and a commit attributed to a person who did not write it is misleading in the history.

Signed commits are strongly preferred. SSH signing takes about a minute to set up and makes your commits show as Verified: see [GitHub's signature verification docs](https://docs.github.com/en/authentication/managing-commit-signature-verification).

If a test or tooling run ever produces commits you did not intend to make, drop them before pushing rather than bypassing the pre-push hook. `scripts/check-push-authors.mjs` catches the known fixture identities, but it cannot catch a fixture wearing a real person's name.

## Developer Certificate of Origin

By contributing to this repository, you certify that you have the right to
submit the work under the repository's applicable license terms.

All commits in pull requests must include a `Signed-off-by` trailer using your
real name, following the Developer Certificate of Origin (DCO):

`Signed-off-by: Your Name <your.email@example.com>`

You can add this automatically with:

```bash
git commit -s
```

## Code of conduct

This project follows the [Contributor Covenant Code of Conduct](./CODE_OF_CONDUCT.md).

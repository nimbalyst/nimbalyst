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

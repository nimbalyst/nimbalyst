# Maintainers

This file records who maintains Nimbalyst, what each role can do, and why a small set of paths needs a specific reviewer. It is meant to make the project's authority legible to contributors rather than something you have to infer from who merges what.

## Roles

### Project lead and release manager

**Greg Hinkle ([@ghinkle](https://github.com/ghinkle))** — project lead, repository admin, and release manager.

Owns release workflows, signing and notarization code, security configuration, and maintainer access changes. Publishes releases and reviews deployments to the protected release environments.

### Maintainers

None currently — the role is open. Until someone fills it, the release manager reviews and merges contributions, so expect your pull request to be handled by Greg.

Maintainers triage, label, assign, and close issues; review pull requests; approve and request changes; and merge ordinary contributions once checks pass. A maintainer's approval satisfies the review requirement on `main`.

Maintainers do not create release tags, approve release environments, manage repository secrets, change rulesets, or administer repository access. Those sit with the release manager — see the next section for why, and [Release authority](#release-authority) for how that changes.

If you have been contributing here and this sounds like something you would want, say so on an issue or open a discussion. We would rather grow the list than keep it short.

### Triage and review

**Karl Wirth ([@karlwirth](https://github.com/karlwirth))** — triage.

Triage contributors label, assign, and close issues, and review pull requests. They do not merge. Others help review without being listed here; review help is welcome without any commitment to the maintainer role.

## Why some paths need the release manager's review

Nimbalyst ships signed and notarized desktop binaries. The release build installs dependencies and applies the local patches in `patches/` before it runs, and it holds Apple notarization and code-signing credentials while it does so. Anything that changes what executes inside that build can therefore reach those credentials: the Electron build hooks, the release scripts, the dependency lockfiles, and the patch set.

Those paths require the release manager's review. Everything else — editor, runtime, extensions, UI, tests, documentation — is ordinary maintainer territory and needs only a maintainer's approval. While the maintainer seat is open the two are the same person, but the distinction is real and it is what a new maintainer inherits on day one.

This follows from how the build works, not from a judgment about any maintainer. It applies to the project lead's own pull requests on the same paths.

The practical cost is that dependency upgrades and new patches need a second, specific reviewer. We would rather not have that friction, and it goes away once release builds no longer install unpinned dependency code — that is [issue #1334](https://github.com/nimbalyst/nimbalyst/issues/1334), tracked work rather than a permanent position.

The exact paths are listed in [`.github/CODEOWNERS`](./.github/CODEOWNERS), and you can check the claim yourself against `pnpm-workspace.yaml` (`patchedDependencies` and the `allowBuilds` install-script allowlist) and `.github/workflows/electron-build.yml`.

## Release authority

Release authority is a separate promotion from maintainer authority, not a higher tier of the same thing. A maintainer is trusted to judge a change; a release manager additionally holds the credentials that sign what ships to users.

While there is a single release manager, that person can approve their own release deployments, because the alternative is nobody being able to ship. When a second release manager is added, release environments will require a reviewer other than the person who started the deployment, and self-approval will be turned off.

## How maintainer decisions get made

Decisions belong on GitHub issues and pull requests, not only in chat. Discord is a good place to work something out and a bad place to be the only record of it — a contributor who arrives six months later reads the repository, not the backscroll. If a decision happens in chat, write the outcome and the reasoning onto the relevant issue or PR.

## How the role evolves

Maintainership here is based on sustained judgment rather than volume of commits. The role can grow — into release authority, or into ownership of a specific area — and it can be stepped back by mutual agreement without it being a mark against anyone. Circumstances change and time changes; neither should require a difficult conversation.

## Related

- [CONTRIBUTING.md](./CONTRIBUTING.md) — how to contribute
- [CODE_OF_CONDUCT.md](./CODE_OF_CONDUCT.md) — expected conduct
- [SECURITY.md](./SECURITY.md) — reporting a vulnerability

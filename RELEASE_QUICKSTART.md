# Release Quick Start

**TL;DR for making a release:**

## Step 1: Add Your Changes to CHANGELOG.md

As you work, add changes to the `[Unreleased]` section:

```markdown
## [Unreleased]

### Added
- New feature you built

### Fixed
- Bug you fixed

### Changed
- Thing you updated
```

## Step 2: Run the /release-alpha Command

In Claude Code, run:
```
/release-alpha patch
```

Choose:
- `patch` for bug fixes (0.42.60 → 0.42.61)
- `minor` for new features (0.42.60 → 0.43.0)
- `major` for breaking changes (0.42.60 → 1.0.0)

## Step 3: Push

```bash
git push origin main
git push origin v0.42.61
```

Done. The tag push publishes the GitHub alpha prerelease automatically. When it is ready to go public, run `/promote-public-release`.

---

**Full documentation:** See [RELEASING.md](RELEASING.md) for advanced workflows.

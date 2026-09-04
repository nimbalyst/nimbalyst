---
description: Release the iOS app version currently on TestFlight to the App Store
---

Promote the iOS version currently in `Info.plist` (the one that's been on TestFlight) to the App Store. This command does NOT bump the version -- it assumes the user manually bumped `CFBundleShortVersionString` when they started TestFlight testing for this release.

If you need to bump the version instead, use `/ios-release` (which runs `scripts/ios-release.sh`).

## RELEASE-IOS WORKFLOW

### 1. Read the version being released

```bash
/usr/libexec/PlistBuddy -c "Print :CFBundleShortVersionString" packages/ios/NimbalystApp/Sources/Info.plist
```

This is the version we're tagging. Do NOT modify `Info.plist`.

### 2. Find the previous iOS tag

```bash
git tag --list 'ios/*' --sort=-v:refname | head -1
```

If no `ios/v*` tag exists, this is the first tracked iOS release -- ask the user for a sensible cutoff (e.g. the last public App Store version's release date).

### 3. Collect iOS-relevant commits

```bash
git log <last-ios-tag>..HEAD --oneline --no-merges -- packages/ios/ packages/runtime/src/sync/
```

Read all commit subjects. The release notes will be derived from these.

### 4. Draft release notes (TWO versions)

Trim hard. The previous mistake was being too detailed.

**A. Developer changelog (for `IOS_CHANGELOG.md`)**

Categorize as Added / Changed / Fixed / Removed. Drop:
- Internal refactors that have no user impact (transformer rewrites, schema unification)
- Test-only fixes
- Build / CI fixes
- Most sync infrastructure plumbing -- collapse into one bullet ("Sync resilience after network change, sleep, JWT refresh, and org switching")
- Anything purely cosmetic in the codebase

Keep ~10-15 bullets total per category.

**B. App Store "What's New" text**

Even shorter -- 6-8 bullets max. Drop:
- All categorization headers
- Anything users can't see
- Buzzwords / engineering jargon ("transformer", "WebSocket", "JWT")
- Compliance items (privacy manifest, account deletion)

Each bullet must answer "what can I now do?" or "what problem is fixed?". Use present tense. End with one line summarizing the rest as "Plus a lot of [area] reliability fixes."

### 5. Show both versions to user and ask for approval

Display the developer changelog and the App Store text in fenced markdown blocks. Note:
- Current iOS version (from plist)
- Last iOS tag (or "none -- first tracked release")
- Number of commits being summarized

Wait for user approval before touching any files.

### 6. Update `IOS_CHANGELOG.md`

After approval, rewrite `IOS_CHANGELOG.md` so it contains:
- The standard `[Unreleased]` empty-section block at top
- A new `## [<version>] - <today>` block with the developer changelog
- All previous version entries below, untouched

Use today's date in `YYYY-MM-DD`.

### 7. Rebuild the iOS transcript bundle

```bash
npm run ios:build:transcript
```

Then copy the output into the Xcode resources directory (these files are gitignored but the archive expects them in place):

```bash
cd packages/ios && \
  rm -f NimbalystApp/Resources/transcript-dist/assets/transcript-*.js && \
  cp dist-transcript/transcript.html NimbalystApp/Resources/transcript-dist/transcript.html && \
  cp dist-transcript/assets/* NimbalystApp/Resources/transcript-dist/assets/
```

(Xcode's pre-build script regenerates these on archive too, but rebuilding here surfaces any build errors before the user opens Xcode.)

### 8. Commit `IOS_CHANGELOG.md` -- ONLY that file

**CRITICAL**: do not use `git add -A` or `git add .`. Other files may be pre-staged in the user's index from unrelated work; sweeping them into the release commit will pollute the tag's diff. Stage `IOS_CHANGELOG.md` explicitly, then check `git status` to confirm only that file is staged before committing.

```bash
git status                                           # sanity check
git diff --cached --name-only                         # confirm nothing else already staged
git add IOS_CHANGELOG.md
git diff --cached --name-only                         # confirm ONLY IOS_CHANGELOG.md is now staged
```

If anything else is already staged, STOP and ask the user how to proceed -- don't commit.

Then commit with the developer changelog as the message body:

```bash
git commit -m "iOS Release v<VERSION>

<developer changelog body>"
```

### 9. Tag `ios/v<VERSION>` on HEAD (not on the changelog commit)

The tag should point to whatever is at HEAD, not specifically the changelog commit. Later fixes (especially anything touching the React transcript bundle in `packages/runtime/`) may have landed on top, and those will be in the archived build. Tagging HEAD ensures the tag reflects the actual code shipped.

```bash
git tag -a ios/v<VERSION> HEAD -m "iOS Release v<VERSION>

<developer changelog body>"
```

### 10. Confirm with user before pushing

Pushing the tag is visible to others and triggers any tag-based CI. Ask the user explicitly:
"Push `ios/v<VERSION>` to origin?"

On approval:

```bash
git push origin ios/v<VERSION>
```

Do NOT push `main` unless the user asks -- the changelog commit is local-only until they say otherwise.

### 11. Show next steps for App Store Connect

Print the App Store "What's New" text in a fenced block for easy copy-paste, then:

```
Next:
1. Open packages/ios/NimbalystApp/NimbalystApp.xcodeproj in Xcode
2. Select the NimbalystApp scheme + "Any iOS Device"
3. Confirm the Build number in target General is greater than the highest TestFlight build for v<VERSION>
4. Product > Archive
5. Distribute App > App Store Connect > Upload
6. In App Store Connect: My Apps > Nimbalyst > + Version <VERSION>
7. Select the uploaded build
8. Paste the "What's New" text above into "What's New in This Version"
9. Choose manual or automatic release after approval
10. Submit for Review
```

## NOTES & GOTCHAS

- **Build number drift**: `CFBundleVersion` in the committed `Info.plist` is often stale because Xcode auto-increments it locally on each TestFlight upload without writing back to disk. The tag is informational; the actual archive uses whatever Xcode has locally. If you submit a fresh archive (rather than promoting an existing TestFlight build), confirm in Xcode's General tab that the build number is higher than anything already uploaded for this version.
- **Tag goes on HEAD, commit may not**: Don't tag the changelog commit. The intervening commits may include real iOS fixes.
- **Don't bump the version**: This command is for promoting what's already on TestFlight. If the user actually wants to cut a fresh version, redirect them to `/ios-release patch` (or minor/major).
- **Watch the working tree**: This repo regularly has staged-but-uncommitted work. Always confirm `git diff --cached --name-only` shows only `IOS_CHANGELOG.md` before committing.
- **Trim notes hard**: The first instinct is to enumerate every commit. Don't. App Store reviewers and end users want the highlights only.

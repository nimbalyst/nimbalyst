---
name: tip
description: Author a new contextual tip for Nimbalyst's tips system (transcript-inline tip cards with trigger/targeting rules).
---

Author a new contextual tip: {{arg1}}

A **contextual tip** is a small, dismissible card Nimbalyst shows in the empty panel of a new AI session to teach users a feature they have not discovered yet. We are adding many of these to help users get the most value from Nimbalyst. This command walks you through writing one correctly.

If `{{arg1}}` is empty, ask the user what feature/behavior the tip should teach and who should see it, then proceed.

## How the tips system works (read before writing)

All code lives under `packages/electron/src/renderer/tips/`.

### Where a tip is displayed
Tips render **inline in the empty panel of a new/unused AI session transcript** — not as a floating popup (the floating `TipCard` variant exists but is dormant). The surface is wired in `SessionTranscript.tsx` via `renderEmptyExtra()`, which mounts `InlineTipDisplay` above the slash-command suggestions when `messages.length === 0`.

- The card shows: icon + title + body (basic markdown) + optional primary action button + optional secondary link.
- Footer controls: **Next** (cycles through tips, sorted by priority) and **All tips** (opens `AllTipsDialog` to browse every tip).
- Dismiss = X button; primary action = `markTipCompleted`; both clear the active tip.
- Body markdown (`parseMarkdownBody` in `TipCard.tsx`) supports only: `**bold**`, paragraph breaks (blank line), and bullet lists (`- ` / `* `). No links, headings, or inline code.

### How targeting / rules work
`TipProvider.tsx` runs an evaluation loop. A tip is **eligible** only when ALL of these hold:
1. Not shown yet this app launch (`tipShownThisSession` — in-memory, one tip per launch, resets on restart).
2. Help/tips master toggle is on (`walkthroughState.enabled`), no walkthrough active, no dialog/overlay visible, no tip already active.
3. An empty-transcript surface is mounted (`emptyTranscriptVisibleCountAtom > 0`).
4. Not previously dismissed or completed (`shouldShowTip` in `TipService.ts`) — unless `version` was bumped.
5. `trigger.screen === '*'` OR matches the current `ContentMode` (e.g. `'agent'`, `'files'`, `'tracker'`).
6. `trigger.condition(context)` returns `true`.

Among eligible tips, the highest `priority` wins; then it waits `trigger.delay` ms and re-checks the condition before showing. The loop only starts ~15s after launch and re-evaluates every 5s, reading live state from refs.

The `condition` receives a `TipTriggerContext`:
```ts
interface TipTriggerContext {
  currentMode: ContentMode;
  workspacePath?: string;
  isGitRepo: boolean;
  isWorktreesAvailable: boolean;
  featureUsage: Record<string, FeatureUsageRecord>;
  hasBeenUsed: (feature: string) => boolean;            // count > 0
  hasReachedCount: (feature: string, threshold: number) => boolean; // count >= threshold
}
```
Most tips follow the pattern "user has done X enough times but never used Y" — e.g. `hasReachedCount(SESSION_CREATED, 10) && !hasBeenUsed(WORKTREE_CREATED)`. The condition must be a **pure, synchronous** predicate (no async, no IPC).

### Persistence & analytics
Tips reuse the walkthrough store via IPC (no new tables). IDs MUST start with `tip-`. Bumping `version` re-shows a tip to users who dismissed an older version. PostHog events (`tip_shown`, `tip_dismissed`, `tip_action_clicked`, `tip_navigated`, `tip_all_tips_opened`) are captured automatically — do not add your own.

## Steps to author the tip

### 1. Pick the trigger signal
Decide what user state should surface this tip. If you can express it with an existing key in `FEATURE_USAGE_KEYS` (`packages/electron/src/shared/featureUsage.ts`), use it. Current keys include: `SESSION_CREATED`, `SESSION_COMPLETED`, `APP_LAUNCH`, `AI_PROMPT_SUBMITTED`, `EXCALIDRAW_OPENED`, `MOCKUP_OPENED`, `SPREADSHEET_OPENED`, `DATAMODEL_OPENED`, `TRACKER_USED`, `THEME_CHANGED`, `KEYBOARD_SHORTCUT_USED`, `FILE_CREATED`, `WORKTREE_CREATED`.

If no key fits, you must add a new one (see step 4) AND wire a `recordUsage` call at the feature's call site — otherwise the condition can never flip and the tip will never show. Confirm with the user before introducing a new key.

### 2. Create the definition file
`packages/electron/src/renderer/tips/definitions/<kebab-name>.tsx`. Match the style of a nearby tip such as `worktree-session.tsx`. Prefer `<MaterialSymbol icon="..." size={16} />` for the icon. Drive actions through atoms/IPC/`dialogRef` like the existing tips do — never reach into DOM.

**Action options.** A tip's `content.action` can either:
- run code via `onClick` (navigate, open a dialog, set an atom), or
- seed the composer via `insertPrompt: '/some-command '` — drops that text into the session input so the user can review and submit. Use this to point at a slash command (e.g. a planning-extension command). `insertPrompt` only works in the inline surface of a **claude-code** session; the button is hidden automatically where there's nowhere to insert, so keep the body meaningful without it. See `session-cleanup.tsx`.

```tsx
import { MaterialSymbol } from '@nimbalyst/runtime';
import { store } from '@nimbalyst/runtime/store';
import { FEATURE_USAGE_KEYS } from '../../../shared/featureUsage';
import type { TipDefinition } from '../types';

const Icon = <MaterialSymbol icon="lightbulb" size={16} />;

export const myFeatureTip: TipDefinition = {
  id: 'tip-my-feature',          // MUST start with 'tip-'
  name: 'My Feature Suggestion', // human-readable, used in analytics
  version: 1,                    // bump later to re-show after dismissal
  trigger: {
    screen: '*',                 // or 'agent' | 'files' | 'tracker' | ...
    condition: (ctx) =>
      ctx.hasReachedCount(FEATURE_USAGE_KEYS.SESSION_CREATED, 5) &&
      !ctx.hasBeenUsed(FEATURE_USAGE_KEYS.MY_FEATURE),
    delay: 2500,                 // ms after eligible before showing (default 2000)
    priority: 6,                 // higher shows first (existing tips ~5-10)
  },
  content: {
    icon: Icon,
    title: 'Short, benefit-led title',         // ~5-8 words
    body: 'One or two sentences. **Bold** the key term. Say what it does, not how.',
    action: {                                  // optional
      label: 'Try it',
      onClick: () => { store.set(/* atom */, /* value */); },
      variant: 'primary',
    },
    // secondaryAction: { label: 'Learn more', onClick: () => {}, variant: 'link' },
  },
};
```

### 3. Register it
Add the import and array entry in `packages/electron/src/renderer/tips/definitions/index.ts`. Place it in the section that matches its theme/priority.

### 4. (Only if needed) add a new feature-usage key
- Add to `FEATURE_USAGE_KEYS` in `packages/electron/src/shared/featureUsage.ts`.
- Call `recordUsage` where the feature is actually used: renderer via `useFeatureUsage(key).recordUsage()`, or main process via the feature-usage service / `featureUsage.record` IPC. Without this the condition never becomes true.

### 5. Test
- Add/extend a case in `packages/electron/src/renderer/tips/__tests__/tipDefinitions.test.tsx` proving the condition is `true` for the target state and `false` when the feature was already used, plus that `action.onClick()` does the right thing. Run `npm run test:unit`.
- The existing `tipDefinitions.test.tsx` validates required fields — make sure your tip passes it.
- Live check (dev mode, renderer console): `window.__tipHelpers.listTips()` shows every tip with its `conditionMet`; `window.__tipHelpers.showTip('tip-my-feature')` force-shows yours; `window.__tipHelpers.dismissTip()` clears it. The Developer menu also has trigger/reset entries (`tips:reset` clears tip dismissal state).

## Guidelines
- **One tip = one feature.** Teach a single discoverable thing.
- **Benefit first.** The title should say why the user cares; the body says what it is, not a click-by-click how-to (that's a walkthrough).
- **Target the unaware.** Gate on "used the app enough" AND "never touched this feature" so power users who already know it never see it.
- **Don't over-trigger.** Reasonable thresholds and a sensible `priority` so it doesn't crowd out more important tips.
- **Keep body short** and within the supported markdown subset.
- Update `docs/FEATURE_INVENTORY.md` if this tip teaches a feature not yet listed there.

## Files you will touch
1. `packages/electron/src/renderer/tips/definitions/<kebab-name>.tsx` — new tip
2. `packages/electron/src/renderer/tips/definitions/index.ts` — register it
3. `packages/electron/src/shared/featureUsage.ts` — only if adding a new usage key (+ wire `recordUsage`)
4. `packages/electron/src/renderer/tips/__tests__/tipDefinitions.test.tsx` — test the condition + action

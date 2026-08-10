# Render Performance

How to find unnecessary React re-renders in Nimbalyst, and how to keep them from coming back.

The recurring failure: several AI sessions stream at once and the renderer repaints the session list, the transcript, the diff panes and the files-edited sidebar far more often than anyone can perceive. Nothing about a component's source tells you this is happening — you have to measure it.

## The instrument

`packages/electron/src/renderer/devtools/renderProfiler.ts` installs a shim for `__REACT_DEVTOOLS_GLOBAL_HOOK__` and reads the committed fiber tree on every commit. Per component it reports how many times its render function actually ran, and — by diffing each fiber against its alternate — *why*.

It is development-only, and **recording is off until you start it**. Idle cost is one increment per commit.

Three consumption points, one implementation:

| Where | How |
| --- | --- |
| Developer Dashboard | The **Renders** tab. Start, exercise the app, read the table. |
| An agent / the console | `window.__renderProfiler` in the renderer, or the `dev:render-profiler` IPC from main. |
| Tests | `measureRenders()` from `devtools/renderBudget.ts`. |

### Reading it live

```js
await window.__renderProfiler.start()
// ... exercise the app: let a few sessions stream, open a large transcript ...
const s = await window.__renderProfiler.stop()
```

An agent does the same over `renderer_eval`. Note `start()` is async — its first call pulls in the atom-write profiler.

The numbers that matter are **renders per commit** and the **reason** column, not the raw total:

```
121,927 renders across 82 commits in 43.8s   →  1,478 renders per commit
```

1.87 commits/sec is nothing. 1,478 components rendering for each of them is the problem. A commit rate that low with a render count that high means one state change is repainting most of the window.

### Reading the "why" column

| Reason | What it means | What to do |
| --- | --- | --- |
| `unstable prop identity: onToggle, edits` | The prop is a *new reference holding the same value* — an inline `{…}`, `[…]` or `() => {}` rebuilt by the parent every render. | `useCallback` / `useMemo` at the parent, or move the value out of render. This is the most common and most fixable finding. |
| `props changed: tick` | A genuine change. | Fine, unless the parent shouldn't have re-rendered at all. |
| `hook or state changed` | This component's own subscription fired. | Fine if it's the component's own data. If hundreds of siblings report it at once, the atom is too coarse — split it. |
| `parent rendered (props identical)` | Pure waste: the parent re-rendered and dragged this along. | Isolate the parent's state, or push the subscription down. |
| `mount` | The subtree was recreated, not updated. | Usually key churn or a conditional render where CSS `display` belongs. Thousands of `mount`s per commit is a red flag. |

### Attribution to atoms

The snapshot also ranks atoms by writes, because a too-coarse atom written 200 times a second is usually the cause and the render table is only the symptom. Jotai's babel debug-label plugin runs in dev, so module-level atoms report by name; `atomFamily` instances report as their family (writes across every instance aggregate into one row — "this family is hot" is the question worth answering).

### Gotchas

- **You profile one window.** The Developer Dashboard drives the *main app window*, and `renderer_eval` targets the focused one. Chromium throttles hidden windows, so a quiet reading may mean you profiled the wrong one. The snapshot carries `visibilityState` / `hasFocus`; the dashboard shows a banner. Check it before concluding anything.
- **The profiler must load before react-dom.** It is the first import in `renderer/index.tsx` and must be the first import in a test file that profiles. `start()` throws if React never saw the hook, so a bad import order fails loudly rather than reporting zeros.
- **Anonymous components.** `memo((props) => …)` and `forwardRef((props, ref) => …)` give React nothing to name, and the profiler falls back to `Memo <- SessionHistory`. Write `memo(function SessionListItem(props) {…})` for anything you expect to look at. (esbuild renames the inner function to `SessionListItem2` when it shadows the const — `rendersOf()` matches that, so tests still ask for `SessionListItem`.)
- **Overhead.** Measured at 0.2% of wall clock at ~2,800 renders/sec. The snapshot reports `overheadMs` so you can see when the tool is the load.

## Render budgets in tests

A budget test asserts how much of the tree repaints for an action. Use it for invariants a reader cannot see — "one session's activity must not touch its siblings" — not for things a human would spot on screen.

```tsx
// @vitest-environment jsdom

// MUST be first: installs the hook shim before react-dom initializes.
import { measureRenders } from '../../../devtools/renderBudget';

import { act, render } from '@testing-library/react';

render(<Provider store={store}><SessionList /></Provider>);
// Flush mount effects, or you measure the mount instead of the action.
await act(async () => { await Promise.resolve(); });

const budget = await measureRenders(async () => {
  await act(async () => { store.set(sessionLastActivityAtom('s1'), Date.now()); });
});

// Pass `budget.report()` as the assertion message — it prints the ranked
// table with the "why" column, which is what you need when it regresses.
expect(budget.rendersOf('SessionListItem'), budget.report()).toBe(1);
```

Prior art: `components/AgenticCoding/__tests__/SessionListItem.renderBudget.test.tsx`, which pins the session list at exactly one row repaint whether the list holds 5 rows or 50.

**Assert an exact count, not an upper bound.** `toBeLessThanOrEqual(1)` passes when the component renders zero times — including when you typo'd the name and are measuring nothing. That happened while writing the first budget test here.

**Virtualized surfaces do not measure honestly in jsdom.** The transcript (`virtua` VList) and the session list (`react-virtuoso`) render only what fits a viewport, and jsdom reports every element as zero-height. Measure those live instead.

## Known anti-patterns

- **One coarse atom at the root.** A whole route/snapshot object read with `useAtom` in a component that renders the window means every change repaints everything. Push consumption down into narrow derived atoms that individual rows subscribe to.
- **Per-session state that isn't per-session.** The session list is correct today because every row subscribes to `atomFamily(sessionId)` atoms only. Hoisting one of those subscriptions up a level makes every sibling pay for every token.
- **Inline objects, arrays and lambdas as props** to anything memoized — the memo can never bail out, so you pay the comparison *and* the render.
- **Conditional render instead of CSS `display`** for mode-level components: unmount/remount loses state, re-reads preferences over IPC and restarts timers.
- **Self-amplifying effects** — effect writes state, new object identity, re-render, effect deps changed, effect runs again.
- **Hidden or inactive surfaces still subscribing.** Quick Open lag came from exactly this.
- Per `packages/electron/CLAUDE.md`: *if you need `React.memo` to prevent re-renders, you have the wrong architecture.* Prefer atom-level isolation; memo is the fallback for leaves.

## Related

- [`.claude/commands/investigate-performance.md`](../.claude/commands/investigate-performance.md) — the full performance investigation playbook.
- [JOTAI.md](./JOTAI.md) — atom design and derived-atom patterns.
- [EDITOR_STATE.md](./EDITOR_STATE.md) — why editor content state is not lifted.

import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useAtomValue } from 'jotai';
import { MaterialSymbol } from '@nimbalyst/runtime/ui/icons/MaterialSymbol';
import {
  ISLAND_EXPANDED_WIDTH,
  MENU_BAR_ISLAND_CHANNELS,
  type MenuBarIslandState,
} from '../../../shared/menuBarIsland';
import {
  initMenuBarIslandListener,
  menuBarIslandGlyphAtom,
  menuBarIslandStateAtom,
} from '../../store/listeners/menuBarIslandListeners';
import { SessionAttentionRow } from '../AgenticCoding/SessionAttentionRow';
import {
  TrayMarkAllReadButton,
  TraySessionSectionHeader,
  TrayStatusIndicator,
} from '../TrayPanel/traySessionSections';
import { getRelativeTimeString } from '../../utils/dateFormatting';
import { MenuBarIslandSettingsPanel } from './MenuBarIslandSettings';

/**
 * The menu bar island.
 *
 * Its own renderer (`?mode=menu-bar-island`), living in a transparent window
 * drawn inside the macOS menu bar row. Collapsed it is the fleet strip; hovered
 * it expands downward into the same rows the tray panel and the in-app popover
 * render, via `SessionAttentionRow` and the shared section chrome.
 *
 * Main owns the hit test and therefore the open state -- `expanded` arrives with
 * the state, this component never decides it. What this component owns is
 * publishing the island's laid-out rect back to main, which is what the cursor
 * poll tests against. Miss that and hover never fires.
 *
 * In island mode there is no tray item, so the footer below is the only place
 * the tray menu's actions still live. It is pinned outside the scroll area for
 * that reason -- scrolling a long fleet must not be able to hide the way out.
 */

/** The app's focus ring. Chromium's default paints as a stray double outline. */
const FOCUS_RING = 'focus:outline-none focus-visible:outline-2 focus-visible:outline-[var(--nim-border-focus)] focus-visible:outline-offset-[-2px]';

/** Menu bar row height. The collapsed pill fills it exactly. */
const STRIP_HEIGHT = 30;

/** Matches the tray strip's palette (see main/tray/stripMarkup.ts). */
const STRIP_COLORS = {
  approval: '#fbbf24',
  decision: '#f0abfc',
  failed: '#ef4444',
  running: '#60a5fa',
  completed: '#4ade80',
  // Running, drained. Same family as `running` rather than a new hue, because a
  // stalled session *is* a running one that stopped talking -- and because the
  // strip already spends amber on approvals and on the hot age, so a fourth
  // warm colour would collide with one of them.
  stalled: '#94a3b8',
} as const;

function CountPair({ color, count }: { color: string; count: number }) {
  return (
    <span className="inline-flex items-center gap-[3.5px]">
      <span className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: color }} />
      <span className="text-[12.5px] font-medium tabular-nums" style={{ color }}>{count}</span>
    </span>
  );
}

/**
 * The strip line.
 *
 * Always painted on the island's own near-black surface with a white
 * foreground, in both themes: it sits in the menu bar, which is translucent, and
 * there is no API for the menu bar's real luminance. This is the same
 * compromise the bitmap strip makes.
 */
function IslandStrip({
  strip,
  expanded,
  glyph,
  onOpenSession,
}: {
  strip: MenuBarIslandState['strip'];
  expanded: boolean;
  glyph: string | null;
  onOpenSession: (sessionId: string, workspacePath: string) => void;
}) {
  return (
    <div
      className="flex shrink-0 items-center gap-[7px] whitespace-nowrap px-3 text-[13px] text-white/95"
      style={{ height: STRIP_HEIGHT }}
    >
      {/*
        The app mark, so a pill floating in the middle of the menu bar is
        identifiable as Nimbalyst -- the tray icon that would otherwise say so
        is far away on the right. Masked rather than drawn, exactly as the
        bitmap strip does it, so it takes the strip's foreground colour and the
        two styles carry the same mark from the same file.
      */}
      {glyph && (
        <span
          className="h-[17px] w-[17px] shrink-0 bg-white/95"
          style={{ WebkitMaskImage: `url("${glyph}")`, WebkitMaskSize: 'contain', WebkitMaskPosition: 'center', WebkitMaskRepeat: 'no-repeat' }}
          aria-hidden
        />
      )}
      {strip.mode === 'named' ? (
        <>
          <span
            className="h-[7px] w-[7px] shrink-0 rounded-full"
            style={{ background: STRIP_COLORS[strip.state] }}
          />
          {/*
            The name is the click target, and only the name: the rest of the
            pill stays the pin toggle and the drag handle. Stopping the pointer
            events is what keeps the two apart -- the surrounding handle decides
            pin-vs-drag by watching a whole press, so a press that bubbled out of
            here would open the session *and* toggle the pin on one click.
          */}
          <button
            type="button"
            className="menu-bar-island-strip-title max-w-[190px] truncate rounded-[3px] px-0.5 text-[12.5px] font-medium text-white/95 transition-colors hover:bg-white/20 focus:outline-none focus-visible:outline-2 focus-visible:outline-white/70 focus-visible:outline-offset-[-2px]"
            title={`Open ${strip.title}`}
            onPointerDown={(event) => event.stopPropagation()}
            onPointerUp={(event) => event.stopPropagation()}
            onClick={() => onOpenSession(strip.sessionId, strip.workspacePath)}
            data-testid="menu-bar-island-strip-title"
          >
            {strip.title}
          </button>
        </>
      ) : (
        <>
          {/* Approval and decision collapse into one amber "waiting" count, as
              in the bitmap strip: at resting width two near-identical dot-and-
              digit pairs cost width to say less. */}
          {strip.needsApproval + strip.needsDecision > 0 && (
            <CountPair color={STRIP_COLORS.approval} count={strip.needsApproval + strip.needsDecision} />
          )}
          {strip.running > 0 && <CountPair color={STRIP_COLORS.running} count={strip.running} />}
          {strip.stalled > 0 && <CountPair color={STRIP_COLORS.stalled} count={strip.stalled} />}
          {strip.failed > 0 && <CountPair color={STRIP_COLORS.failed} count={strip.failed} />}
          {strip.unread > 0 && <CountPair color={STRIP_COLORS.completed} count={strip.unread} />}
        </>
      )}

      {expanded && <span className="min-w-[8px] flex-1" />}

      {strip.age && (
        // The age is the one element that changes without a real transition, so
        // it gets tabular figures and a reserved box -- it must not shove its
        // neighbours as it grows.
        <span
          className={`min-w-[34px] shrink-0 text-right text-[12.5px] tabular-nums ${
            strip.age.hot ? 'font-semibold text-[#fbbf24]' : 'text-white/60'
          }`}
        >
          {strip.age.label}
        </span>
      )}
    </div>
  );
}

/**
 * What the panel says when every bucket is empty.
 *
 * The collapsed island is a bare glyph in this state, so this is what opening
 * the quiet pill shows. It exists because the strip stopped carrying the quiet
 * age: that number was never wrong, it was unlabeled and in the wrong place.
 * Here it has a sentence around it and the sessions it is talking about
 * underneath, each one clickable.
 */
function IdlePanel({
  idle,
  onSelect,
}: {
  idle: MenuBarIslandState['idle'];
  onSelect: (sessionId: string) => void;
}) {
  const recent = idle?.recent ?? [];
  return (
    <div data-testid="menu-bar-island-idle">
      <div className="px-3.5 pb-1 pt-2.5 text-[11.5px] text-nim-muted">
        Nothing running.
        {idle?.lastActivityAt !== undefined && (
          <> Last session {getRelativeTimeString(idle.lastActivityAt)}.</>
        )}
      </div>
      {recent.length === 0 ? (
        <div className="px-3.5 pb-4 pt-1 text-[12px] text-nim-faint">No sessions yet.</div>
      ) : (
        <>
          <div className="px-3.5 pb-1 pt-2 text-[10.5px] font-semibold uppercase tracking-wide text-nim-faint">
            Recent
          </div>
          {recent.map((session) => (
            <SessionAttentionRow
              key={session.sessionId}
              sessionId={session.sessionId}
              title={session.title}
              provider={session.provider}
              model={session.model}
              updatedAt={session.updatedAt}
              workspaceName={session.workspaceName}
              onSelect={onSelect}
            />
          ))}
        </>
      )}
    </div>
  );
}

export function MenuBarIslandApp() {
  const state = useAtomValue(menuBarIslandStateAtom);
  const glyph = useAtomValue(menuBarIslandGlyphAtom);
  const islandRef = useRef<HTMLDivElement>(null);
  // Re-render on a timer so the rows' relative-time labels stay honest while the
  // panel sits open; the state itself only pushes on fleet changes.
  const [, setNow] = useState(Date.now());

  useEffect(() => initMenuBarIslandListener(), []);

  useEffect(() => {
    const interval = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(interval);
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') window.electronAPI.send(MENU_BAR_ISLAND_CHANNELS.dismiss);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  const { strip, feed, expanded, snippets, idle, settings, anchor } = state;
  const [settingsOpen, setSettingsOpen] = useState(false);

  /*
   * Settings do not survive the panel closing.
   *
   * Hover is the ordinary way in and out of this panel, so re-opening it a
   * minute later on a form the user has long since finished with would be
   * surprising. Reopening always lands on the sessions.
   */
  useEffect(() => {
    if (!expanded) setSettingsOpen(false);
  }, [expanded]);

  /*
   * Hold the panel open for as long as the gear is showing.
   *
   * Without this the 260ms hover grace applies to a settings form: the cursor
   * drifts a few points off the island on the way to a toggle and the whole
   * thing collapses. Sessions are a glance, settings are a task.
   */
  useEffect(() => {
    if (!settingsOpen) return;
    window.electronAPI.send(MENU_BAR_ISLAND_CHANNELS.setPinned, { pinned: true });
    return () => window.electronAPI.send(MENU_BAR_ISLAND_CHANNELS.setPinned, { pinned: false });
  }, [settingsOpen]);

  const sections = useMemo(() => ([
    { state: 'attention' as const, sessions: feed.needsAttention },
    { state: 'running' as const, sessions: feed.running },
    { state: 'stalled' as const, sessions: feed.stalled },
    { state: 'unread' as const, sessions: feed.unread },
  ]).filter((section) => section.sessions.length > 0), [feed]);

  /*
   * Publish the island's rect to main after every layout.
   *
   * This is the hover contract: main polls the cursor against this rectangle,
   * because a click-through window stops receiving mouse events the moment the
   * cursor leaves it and so cannot report its own exit. `transitionend` covers
   * the expand/collapse animation, whose final size is what matters -- reporting
   * only the pre-transition rect would let the cursor sit inside the open panel
   * while main believed it had already left.
   */
  useLayoutEffect(() => {
    const node = islandRef.current;
    if (!node) return;
    const publish = () => {
      const rect = node.getBoundingClientRect();
      window.electronAPI.send(MENU_BAR_ISLAND_CHANNELS.rect, {
        left: rect.left,
        top: rect.top,
        width: rect.width,
        height: rect.height,
      });
    };
    publish();
    node.addEventListener('transitionend', publish);
    const observer = new ResizeObserver(publish);
    observer.observe(node);
    return () => {
      node.removeEventListener('transitionend', publish);
      observer.disconnect();
    };
  }, [expanded, strip, feed, settingsOpen]);

  /** Whether a press is in flight, so stray pointermove is not read as a drag. */
  const pressedRef = useRef(false);

  const endPress = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!pressedRef.current) return;
    pressedRef.current = false;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    window.electronAPI.send(MENU_BAR_ISLAND_CHANNELS.dragEnd);
  };

  const handleSelect = (sessionId: string) => {
    const all = [
      ...feed.needsAttention,
      ...feed.running,
      ...feed.stalled,
      ...feed.unread,
      ...(idle?.recent ?? []),
    ];
    const session = all.find((candidate) => candidate.sessionId === sessionId);
    if (!session) return;
    window.electronAPI.send(MENU_BAR_ISLAND_CHANNELS.selectSession, {
      sessionId: session.sessionId,
      workspacePath: session.workspacePath,
    });
  };

  return (
    <div
      className="menu-bar-island-root h-screen w-screen overflow-hidden"
      /*
       * The window is a large transparent canvas and the island only occupies
       * part of it. While the panel is open the whole window captures the
       * mouse, so a click that looks like it landed outside actually lands
       * here. Treat that as a dismiss -- otherwise the click is swallowed and
       * the panel appears stuck open, which is exactly how this bug presented.
       */
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) {
          window.electronAPI.send(MENU_BAR_ISLAND_CHANNELS.dismiss);
        }
      }}
    >
      <div
        ref={islandRef}
        /*
         * `notch-left` pins the island to the window's right edge instead of
         * its centre. Main has already placed that edge just left of the camera
         * housing, so the island grows leftward and stays out from under it --
         * centring on a notched display hides the collapsed strip completely.
         */
        className={`menu-bar-island absolute top-0 flex flex-col overflow-hidden rounded-b-[13px] bg-black transition-[width,height,box-shadow] duration-[260ms] ease-[cubic-bezier(.22,1,.36,1)] ${
          anchor === 'notch-left' ? 'right-0' : 'left-1/2 -translate-x-1/2'
        } ${
          expanded ? 'shadow-[0_10px_34px_rgba(0,0,0,0.55)]' : 'w-max'
        }`}
        /*
         * The expanded width is inline rather than a `w-[420px]` utility because
         * main needs the same number to keep the open panel clear of the notch,
         * and an interpolated arbitrary value would not survive Tailwind's
         * static scan. Collapsed stays on `w-max`: it sizes to its content.
         */
        style={{
          height: expanded ? undefined : STRIP_HEIGHT,
          width: expanded ? ISLAND_EXPANDED_WIDTH : undefined,
        }}
        data-testid="menu-bar-island"
        data-component="MenuBarIslandApp"
        data-expanded={expanded}
      >
        {/*
          * The pill is both the pin toggle and the drag handle for moving the
          * island to another display's menu bar. The renderer does not choose
          * between them: it reports the press, the movement and the release,
          * and main -- which can sample the real cursor across displays of
          * differing scale factors -- decides which gesture happened.
          */}
        {/*
          * A div rather than a button: it now contains the title button, and a
          * button inside a button is invalid. It never was a semantic control
          * anyway -- it is a gesture surface, and the gestures are pointer
          * events, not activation.
          */}
        <div
          className="cursor-default text-left outline-none"
          onPointerDown={(event) => {
            // Capture, or the press stops reporting the moment the cursor
            // leaves the pill -- which dragging to another screen does
            // immediately. Without it a drag can never leave this display.
            event.currentTarget.setPointerCapture(event.pointerId);
            pressedRef.current = true;
            window.electronAPI.send(MENU_BAR_ISLAND_CHANNELS.dragStart);
          }}
          onPointerMove={() => {
            if (!pressedRef.current) return;
            window.electronAPI.send(MENU_BAR_ISLAND_CHANNELS.dragMove);
          }}
          onPointerUp={endPress}
          // A cancelled pointer must still end the press. Main holds the panel
          // open for the whole drag, so a press that never reports its release
          // pins the island open with no way back.
          onPointerCancel={endPress}
          data-testid="menu-bar-island-strip"
        >
          <IslandStrip
            strip={strip}
            expanded={expanded}
            glyph={glyph}
            onOpenSession={(sessionId, workspacePath) => {
              window.electronAPI.send(MENU_BAR_ISLAND_CHANNELS.selectSession, { sessionId, workspacePath });
            }}
          />
        </div>

        {expanded && (
          // Themed surface below the strip so the rows look like the popover's
          // rows in both light and dark, rather than riding on the pill's black.
          <>
            <div
              // `bg-nim` is the surface token (--nim-bg). `bg-nim-primary` is the
              // brand accent, not a background -- it paints the panel bright blue.
              className="menu-bar-island-body max-h-[340px] overflow-y-auto border-t border-nim bg-nim pb-1 text-nim"
              data-testid="menu-bar-island-list"
            >
              {settingsOpen ? (
                <MenuBarIslandSettingsPanel settings={settings} />
              ) : (
                <>
                  {sections.length === 0 && <IdlePanel idle={idle} onSelect={handleSelect} />}
                  {sections.map(({ state: sectionState, sessions }) => (
                    <section key={sectionState} className={`menu-bar-island-group menu-bar-island-group--${sectionState}`}>
                      <TraySessionSectionHeader
                        state={sectionState}
                        count={sessions.length}
                        actionSlot={sectionState === 'unread' ? (
                          <TrayMarkAllReadButton
                            className="menu-bar-island-mark-all-read"
                            onClick={() => window.electronAPI.send(MENU_BAR_ISLAND_CHANNELS.clearAllUnread)}
                            testId="menu-bar-island-mark-all-read"
                          />
                        ) : undefined}
                      />
                      {sessions.map((session) => (
                        <SessionAttentionRow
                          key={session.sessionId}
                          sessionId={session.sessionId}
                          title={session.title}
                          provider={session.provider}
                          model={session.model}
                          updatedAt={session.updatedAt}
                          workspaceName={session.workspaceName}
                          snippet={snippets?.[session.sessionId]}
                          onSelect={handleSelect}
                          statusSlot={<TrayStatusIndicator session={session} state={sectionState} />}
                        />
                      ))}
                    </section>
                  ))}
                </>
              )}
            </div>

            {/*
              * Outside the scroller on purpose. With the tray item gone this row
              * is the whole of the old right-click menu, so a long fleet must
              * not be able to scroll the way out of the panel off the bottom.
              */}
            <div
              className="menu-bar-island-footer flex shrink-0 items-center justify-between gap-2 border-t border-nim bg-nim px-2 py-1.5 text-nim"
              data-testid="menu-bar-island-footer"
            >
              <button
                type="button"
                aria-pressed={settingsOpen}
                aria-label={settingsOpen ? 'Back to sessions' : 'Menu bar settings'}
                title={settingsOpen ? 'Back to sessions' : 'Menu bar settings'}
                className={`flex items-center gap-1 rounded px-1.5 py-1 text-[11px] font-medium transition-colors hover:bg-nim-tertiary ${
                  settingsOpen ? 'bg-nim-tertiary text-nim' : 'text-nim-muted hover:text-nim'
                } ${FOCUS_RING}`}
                onClick={() => setSettingsOpen((open) => !open)}
                data-testid="menu-bar-island-settings-toggle"
              >
                <MaterialSymbol icon={settingsOpen ? 'arrow_back' : 'settings'} size={15} />
                {settingsOpen && 'Sessions'}
              </button>

              <div className="flex items-center gap-1">
                <button
                  type="button"
                  className={`flex items-center gap-1 rounded px-2 py-1 text-[11px] font-medium text-nim-muted transition-colors hover:bg-nim-tertiary hover:text-nim ${FOCUS_RING}`}
                  onClick={() => window.electronAPI.send(MENU_BAR_ISLAND_CHANNELS.newSession)}
                  data-testid="menu-bar-island-new-session"
                >
                  <MaterialSymbol icon="add" size={14} />
                  New Session
                </button>
                <button
                  type="button"
                  className={`rounded px-2 py-1 text-[11px] font-medium text-nim-muted transition-colors hover:bg-nim-tertiary hover:text-nim ${FOCUS_RING}`}
                  onClick={() => window.electronAPI.send(MENU_BAR_ISLAND_CHANNELS.openApp)}
                  data-testid="menu-bar-island-open-app"
                >
                  Open Nimbalyst
                </button>
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

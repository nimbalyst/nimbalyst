import React from 'react';
import { MAIN_WINDOW_TITLE_BAR_HEIGHT } from '../../../shared/windowChrome';

interface StartupSkeletonProps {
  /**
   * Whether this window is a workspace window. Document windows have no
   * top bar / gutter / sidebar, so they get the bare background instead of
   * chrome that will never appear.
   */
  workspaceMode: boolean;
}

/**
 * Placeholder chrome shown while the app boots.
 *
 * App startup blocks the whole UI until the extension system has registered
 * (~seconds on a machine with several extensions installed), and the window is
 * shown at `ready-to-show` — so without this the user stares at an empty,
 * correctly-themed rectangle and cannot tell the app from a hung one. The
 * shapes mirror the real workspace layout so the chrome does not jump when the
 * app takes over.
 */
export const StartupSkeleton: React.FC<StartupSkeletonProps> = ({ workspaceMode }) => {
  if (!workspaceMode) {
    return <div className="startup-skeleton startup-skeleton--document h-screen" aria-busy="true" />;
  }

  return (
    <div
      className="startup-skeleton startup-skeleton--workspace h-screen flex flex-col"
      aria-busy="true"
    >
      <div
        className="startup-skeleton__top-bar shrink-0 bg-nim-secondary border-b border-nim"
        style={{ height: MAIN_WINDOW_TITLE_BAR_HEIGHT }}
      />
      <div className="flex flex-1 min-h-0">
        <div className="startup-skeleton__gutter w-12 bg-nim-secondary border-r border-nim shrink-0" />
        <div className="startup-skeleton__sidebar w-64 bg-nim-secondary border-r border-nim shrink-0 p-3">
          <div className="animate-pulse flex flex-col gap-2">
            {[0, 1, 2, 3, 4].map((row) => (
              <div
                key={row}
                className="startup-skeleton__row h-3 rounded bg-nim-hover"
                style={{ width: `${80 - row * 10}%` }}
              />
            ))}
          </div>
        </div>
        <div className="startup-skeleton__content flex-1" />
      </div>
    </div>
  );
};

import { lazy, Suspense, type JSX } from 'react';
import type { TrackerViewEmbedProps } from './TrackerViewEmbed';

const TrackerViewEmbedImpl = lazy(() =>
  import('./TrackerViewEmbed').then((module) => ({ default: module.TrackerViewEmbed }))
);

/** A view the host supplies; its surfaces load only when one is shown. */
export function LazyTrackerViewEmbed(props: TrackerViewEmbedProps): JSX.Element {
  return (
    <Suspense fallback={<div className="tracker-saved-view-embed text-xs text-nim-muted">{props.view.name}</div>}>
      <TrackerViewEmbedImpl {...props} />
    </Suspense>
  );
}

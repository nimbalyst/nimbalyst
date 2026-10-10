import { lazy, Suspense, type JSX } from 'react';
import type { PlacedViewEmbedProps } from './PlacedViewEmbed';

const PlacedViewEmbedImpl = lazy(() =>
  import('./PlacedViewEmbed').then((module) => ({ default: module.PlacedViewEmbed }))
);

/** A view placed in a page; its surfaces load only when one is shown. */
export function LazyPlacedViewEmbed(props: PlacedViewEmbedProps): JSX.Element {
  return (
    <Suspense fallback={<div className="placed-view-embed my-3 text-xs text-nim-muted">{props.label}</div>}>
      <PlacedViewEmbedImpl {...props} />
    </Suspense>
  );
}

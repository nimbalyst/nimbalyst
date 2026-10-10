/**
 * TrackerReferenceNode -- attaches the editor's React decorator to the
 * React-free class in `./TrackerReferenceNodeCore.ts` and re-exports it.
 *
 * The decorator dispatches to the host renderer registered with
 * `setTrackerReferenceNodeRenderer`, or shows the bare key when none is. A
 * link naming another team project never reaches the host renderer, which
 * resolves keys in this project: it shows as an external link instead.
 */

import * as React from 'react';

import { TrackerReferenceNodeDecorator } from './TrackerReferenceNodeCore';
import { getTrackerReferenceNodeRenderer, type TrackerReferenceNodeRendererProps } from './TrackerReferenceNodeRenderer';
import { TrackerReferenceExternalChip, useTrackerReferenceIsForeign } from './TrackerReferenceExternalChip';

/** Props are read in `decorate`, where the node's latest state is readable. */
function ScopedTrackerReference({ href, ...props }: TrackerReferenceNodeRendererProps & { href: string | null }): React.JSX.Element {
  const foreign = useTrackerReferenceIsForeign(href);
  if (foreign && href) return <TrackerReferenceExternalChip referenceKey={props.referenceKey} href={href} />;
  const Renderer = getTrackerReferenceNodeRenderer();
  if (!Renderer) {
    return (
      <span
        className="tracker-reference"
        data-issue-key={props.referenceKey}
      >
        {props.referenceKey}
      </span>
    );
  }
  return <Renderer {...props} href={href} />;
}

TrackerReferenceNodeDecorator.set((node) => (
  <ScopedTrackerReference
    referenceKey={node.__referenceKey}
    nodeKey={node.getKey()}
    view={node.getView()}
    relation={node.getRelation()}
    href={node.getHref()}
  />
));

export * from './TrackerReferenceNodeCore';

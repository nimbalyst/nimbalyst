// The type map and a label's review render only on the wiki's Types pages, so
// they load on first mount rather than riding in the trackers-ui entry.
import { lazy, Suspense } from 'react';
import type { OntologyLabelReviewProps } from './OntologyLabelReview';
import type { OntologyTypeMapProps } from './OntologyTypeMap';

const TypeMapImpl = lazy(() => import('./OntologyTypeMap').then((module) => ({ default: module.OntologyTypeMap })));
const LabelReviewImpl = lazy(() => import('./OntologyLabelReview').then((module) => ({ default: module.OntologyLabelReview })));

export function OntologyTypeMap(props: OntologyTypeMapProps) {
  return <Suspense fallback={null}><TypeMapImpl {...props} /></Suspense>;
}

export function OntologyLabelReview(props: OntologyLabelReviewProps) {
  return <Suspense fallback={null}><LabelReviewImpl {...props} /></Suspense>;
}

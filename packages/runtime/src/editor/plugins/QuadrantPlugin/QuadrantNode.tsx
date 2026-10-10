/**
 * QuadrantNode -- attaches the editor's React decorator to the React-free
 * class in `./QuadrantNodeCore.ts` and re-exports it.
 *
 * The block and its chart load on first use, so a page with no 2x2 does not
 * pay for them on the editor's eager path.
 */

import React, { Suspense } from 'react';

import { QuadrantNodeDecorator } from './QuadrantNodeCore';

const QuadrantBlock = React.lazy(() => import('./QuadrantBlock').then((module) => ({ default: module.QuadrantBlock })));

QuadrantNodeDecorator.set((node) => (
  <Suspense fallback={<div className="quadrant-block my-3 min-h-[120px] rounded-lg border border-nim bg-nim-secondary" contentEditable={false} />}>
    <QuadrantBlock source={node.__source} nodeKey={node.__key} />
  </Suspense>
));

export * from './QuadrantNodeCore';

/**
 * ChartNode -- attaches the editor's React decorator to the React-free class
 * in `./ChartNodeCore.ts` and re-exports it.
 *
 * The block loads on first use, and Vega only when a chart draws, so a page
 * with no chart does not pay for either on the editor's eager path.
 */

import React, { Suspense } from 'react';

import { ChartNodeDecorator } from './ChartNodeCore';

const ChartBlock = React.lazy(() => import('./ChartBlock').then((module) => ({ default: module.ChartBlock })));

ChartNodeDecorator.set((node) => (
  <Suspense fallback={<div className="chart-block my-3 min-h-[120px] rounded-lg border border-nim bg-nim-secondary" contentEditable={false} />}>
    <ChartBlock source={node.__source} nodeKey={node.__key} />
  </Suspense>
));

export * from './ChartNodeCore';

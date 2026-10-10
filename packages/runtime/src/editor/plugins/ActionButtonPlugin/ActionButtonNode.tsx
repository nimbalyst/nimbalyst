/**
 * ActionButtonNode -- attaches the editor's React decorator to the React-free
 * class in `./ActionButtonNodeCore.ts` and re-exports it. The block loads on
 * first use.
 */

import React, { Suspense } from 'react';

import { ActionButtonNodeDecorator } from './ActionButtonNodeCore';

const ActionButtonBlock = React.lazy(() => import('./ActionButtonBlock').then((module) => ({ default: module.ActionButtonBlock })));

ActionButtonNodeDecorator.set((node) => (
  <Suspense fallback={<div className="action-button-block my-3 min-h-[44px] rounded-lg border border-nim bg-nim-secondary" contentEditable={false} />}>
    <ActionButtonBlock kind={node.__kind} source={node.__source} nodeKey={node.__key} />
  </Suspense>
));

export * from './ActionButtonNodeCore';

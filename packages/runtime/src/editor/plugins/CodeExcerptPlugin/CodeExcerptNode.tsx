/**
 * CodeExcerptNode -- attaches the editor's React decorator to the React-free
 * class in `./CodeExcerptNodeCore.ts` and re-exports it. The block (and the
 * highlighter) load on first use.
 */

import React, { Suspense } from 'react';

import { CodeExcerptNodeDecorator } from './CodeExcerptNodeCore';

const CodeExcerptBlock = React.lazy(() => import('./CodeExcerptBlock').then((module) => ({ default: module.CodeExcerptBlock })));

CodeExcerptNodeDecorator.set((node) => (
  <Suspense fallback={<div className="code-excerpt-block my-3 min-h-[64px] rounded-lg border border-nim bg-nim-secondary" contentEditable={false} />}>
    <CodeExcerptBlock source={node.__source} nodeKey={node.__key} />
  </Suspense>
));

export * from './CodeExcerptNodeCore';

/**
 * TocNode -- attaches the editor's React decorator to the React-free class in
 * `./TocNodeCore.ts` and re-exports it.
 */

import React from 'react';

import { TocBlock } from './TocBlock';
import { TocNodeDecorator } from './TocNodeCore';

TocNodeDecorator.set((node) => <TocBlock source={node.__source} nodeKey={node.__key} />);

export * from './TocNodeCore';

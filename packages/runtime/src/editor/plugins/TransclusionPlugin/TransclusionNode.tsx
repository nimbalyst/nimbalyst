/**
 * TransclusionNode -- attaches the editor's React decorator to the React-free
 * class in `./TransclusionNodeCore.ts` and re-exports it.
 */

import React from 'react';

import { TransclusionBlock } from './TransclusionBlock';
import { TransclusionNodeDecorator } from './TransclusionNodeCore';

TransclusionNodeDecorator.set((node) => (
  <TransclusionBlock href={node.__href} label={node.__label} title={node.__title} nodeKey={node.__key} />
));

export * from './TransclusionNodeCore';

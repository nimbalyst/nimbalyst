/**
 * MentionNode -- attaches the editor's React decorator to the React-free class
 * in `./MentionNodeCore.ts` and re-exports it.
 */

import React from 'react';

import { MentionChip } from './MentionChip';
import { MentionNodeDecorator } from './MentionNodeCore';

MentionNodeDecorator.set((node) => (
  <MentionChip kind={node.__mentionKind} value={node.__value} label={node.__label} />
));

export * from './MentionNodeCore';

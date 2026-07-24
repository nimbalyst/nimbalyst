/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import type {JSX} from 'react';
import { useMemo } from 'react';

import {MarkdownShortcutPlugin} from '@lexical/react/LexicalMarkdownShortcutPlugin';

import {getEditorTransformers} from '../../markdown';

export default function MarkdownPlugin(): JSX.Element {
  const transformers = useMemo(() => getEditorTransformers(), []);
  return <MarkdownShortcutPlugin transformers={transformers} />;
}

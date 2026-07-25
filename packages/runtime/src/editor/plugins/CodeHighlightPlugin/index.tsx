/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import { useEffect } from 'react';
import { registerCodeHighlighting } from '@lexical/code';
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext';

// Import Prism and necessary languages
// @ts-ignore - prismjs doesn't have types
import Prism from 'prismjs';
import 'prismjs/components/prism-javascript';
import 'prismjs/components/prism-typescript';
import 'prismjs/components/prism-jsx';
import 'prismjs/components/prism-tsx';
import 'prismjs/components/prism-css';
import 'prismjs/components/prism-python';
import 'prismjs/components/prism-markdown';
import 'prismjs/components/prism-json';
import 'prismjs/components/prism-bash';
import 'prismjs/components/prism-yaml';
import 'prismjs/components/prism-rust';
import 'prismjs/components/prism-go';
import 'prismjs/components/prism-java';
import 'prismjs/components/prism-csharp';

// Import Prism themes
import 'prismjs/themes/prism.css'; // Light theme (default)
// Import dark theme AFTER to ensure it overrides
import './prism-dark.css'; // Dark theme overrides

export default function CodeHighlightPlugin(): null {
  const [editor] = useLexicalComposerContext();

  useEffect(() => {
    // Register standard code highlighting
    // Code blocks without a language use 'plain' as a marker (set in MarkdownTransformers.ts)
    //
    // Note: code token colors switch with the app theme automatically via the
    // editor theme's `nim-token-*` classes (colored by `--nim-code-*` CSS
    // variables). We deliberately do NOT re-theme code nodes on theme change --
    // doing so marked every code node dirty and forced a synchronous Prism
    // re-tokenization of every block in every mounted editor, freezing the
    // window for many seconds on doc-heavy sessions.
    return registerCodeHighlighting(editor);
  }, [editor]);

  return null;
}

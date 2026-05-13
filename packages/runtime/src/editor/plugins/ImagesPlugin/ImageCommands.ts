/**
 * Public command identity for image insertion. Owned by `ImagesExtension`
 * (in `editor/extensions/builtin/`) and re-exported by the dialog module
 * in `editor/plugins/ImagesPlugin/index.tsx` for backwards compatibility.
 */

import { createCommand, type LexicalCommand } from 'lexical';

import type { ImagePayload } from './ImageNode';

export type InsertImagePayload = Readonly<ImagePayload>;

export const INSERT_IMAGE_COMMAND: LexicalCommand<InsertImagePayload> =
  createCommand('INSERT_IMAGE_COMMAND');

/**
 * Which web links render as a preview block. A web link stays a link unless
 * its title attributes ask for a block, so plain markdown reads the same on
 * GitHub:
 *
 *   [Design review](https://www.figma.com/design/abc123/Spec "preview=embed")
 *   [Pricing page](https://example.com/pricing "preview=card")
 *
 * `preview=card` draws a bookmark card (title, description, site, image);
 * `preview=embed` draws the site's player when the URL is on the allowlist
 * (`externalEmbeds.ts`) and falls back to the card when it is not. The block
 * is an `EmbeddedFileNode` like a file embed, so it shares the
 * paragraph-isolated upgrade, the Tab toggle and its `embed=false` opt-out,
 * and the link export.
 *
 * React-free: the upgrade rule runs headless.
 */

import type { EmbedAttrs } from '../EmbedPlugin/EmbeddedFileNodeCore';
import { isTranscludeTitle } from '../TransclusionPlugin/transclusionLink';
import { parseWebUrl, resolveExternalEmbed } from './externalEmbeds';

// A transclusion link (`"transclude"` in its title) belongs to the transclusion block.
export { isTranscludeTitle };

export const LINK_PREVIEW_ATTR = 'preview';
export type LinkPreviewMode = 'card' | 'embed';

export function getLinkPreviewMode(attrs: EmbedAttrs): LinkPreviewMode | null {
  const value = attrs[LINK_PREVIEW_ATTR];
  return value === 'card' || value === 'embed' ? value : null;
}

/** True when this link should become (or already is) a preview block. */
export function isLinkPreviewLink(url: string, attrs: EmbedAttrs, title?: string | null): boolean {
  if (isTranscludeTitle(title)) return false;
  return getLinkPreviewMode(attrs) !== null && parseWebUrl(url) !== null;
}

/** The mode a link gets when the user turns it into a block without choosing one. */
export function defaultLinkPreviewMode(url: string): LinkPreviewMode | null {
  if (!parseWebUrl(url)) return null;
  return resolveExternalEmbed(url) ? 'embed' : 'card';
}

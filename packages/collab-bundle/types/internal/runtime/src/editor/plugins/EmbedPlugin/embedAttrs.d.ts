/**
 * Parse/serialize the `key=value` attribute bag stored in a CommonMark link
 * title for embedded-file links.
 *
 * The title-as-attribute approach keeps markdown CommonMark-portable: tools
 * that don't know about embeds still render the title as a hover tooltip.
 * Keys are parsed permissively; unknown keys are preserved on the round-trip
 * but ignored at render time, so we can add new keys without breaking
 * existing markdown.
 *
 * Example title: `height=400 caption=Overall arch`
 */
import type { EmbedAttrs } from './EmbeddedFileNodeCore';
/**
 * Parse a CommonMark link title string into an EmbedAttrs map.
 *
 * Pairs are whitespace-separated. Values are taken as everything between an
 * `=` and the next whitespace; quoted values are stripped of their quotes.
 * Anything that doesn't look like `key=value` is silently dropped so that
 * legacy titles ("Some descriptive sentence.") don't accidentally turn into
 * attribute clutter.
 */
export declare function parseEmbedAttrs(title: string | undefined | null): EmbedAttrs;
/**
 * Serialize an EmbedAttrs map back to the CommonMark link title form.
 * Returns an empty string when no attributes are present so callers can
 * omit the title entirely.
 *
 * Values containing whitespace are quoted with double-quotes; values that
 * also contain double-quotes fall back to single-quotes so we don't lose
 * data on the round-trip.
 */
export declare function serializeEmbedAttrs(attrs: EmbedAttrs): string;

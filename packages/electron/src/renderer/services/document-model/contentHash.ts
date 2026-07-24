/**
 * Fast, non-cryptographic content fingerprint used by the diff lifecycle to
 * decide whether an incoming diff request is a duplicate of the one already
 * being applied. Length-prefixed to avoid collisions across content sizes.
 */
export function hashContent(content: string | ArrayBuffer): string {
  if (typeof content !== 'string') {
    return `b:${content.byteLength}`;
  }
  let hash = 0;
  for (let i = 0; i < content.length; i++) {
    hash = ((hash << 5) - hash) + content.charCodeAt(i);
    hash = hash & hash;
  }
  return `${content.length}:${(hash >>> 0).toString(16)}`;
}

import { describe, expect, it } from 'vitest';
import { hasSeedableContent } from '../useCollaborativeEditor';

/**
 * NIM-1520 fallout guard: a host with no bytes for a collab doc returns ''
 * from loadInitialContent; seeding from that writes a DEFAULT document over
 * the room's real content ("Untitled map" clobber). Empty content must never
 * be considered seedable.
 */
describe('hasSeedableContent', () => {
  it('rejects null/undefined/empty/whitespace strings', () => {
    expect(hasSeedableContent(null)).toBe(false);
    expect(hasSeedableContent(undefined)).toBe(false);
    expect(hasSeedableContent('')).toBe(false);
    expect(hasSeedableContent('   \n\t')).toBe(false);
  });

  it('rejects empty binary buffers', () => {
    expect(hasSeedableContent(new ArrayBuffer(0))).toBe(false);
    expect(hasSeedableContent(new Uint8Array(0))).toBe(false);
  });

  it('accepts real content', () => {
    expect(hasSeedableContent('# Title')).toBe(true);
    expect(hasSeedableContent(new Uint8Array([1, 2, 3]))).toBe(true);
    expect(hasSeedableContent(new ArrayBuffer(8))).toBe(true);
  });
});

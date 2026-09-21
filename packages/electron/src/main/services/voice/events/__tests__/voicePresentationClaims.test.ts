// @vitest-environment node
import { expect, it } from 'vitest';
import { VoicePresentationClaims, type PresentationClaim } from '../voicePresentationClaims';

it('serializes two devices, survives restart, rejects late acknowledgments and deduplicates presentation', () => {
  let now = 100;
  const disk = new Map<string, PresentationClaim>();
  const create = () => new VoicePresentationClaims(key => disk.get(key), (key, value) => { disk.set(key, value); }, () => now, 30);
  const phone = create().claim('question', 'phone')!;
  expect(create().claim('question', 'desktop')).toBeNull();
  now = 131;
  const desktop = create().claim('question', 'desktop')!;
  expect(create().presented('question', 'phone', phone.token)).toBe(false);
  expect(create().presented('question', 'desktop', desktop.token)).toBe(true);
  now = 200;
  expect(create().claim('question', 'phone')).toBeNull();
});

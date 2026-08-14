import { describe, it, expect } from 'vitest';
import { normalizeLocale, resolveSpellCheckerLanguages } from '../spellcheckLanguages';

// Chromium's real English options on Linux/Windows hunspell.
const EN = ['en-US', 'en-CA', 'en-GB', 'en-AU', 'fr', 'fr-FR', 'de'];

describe('normalizeLocale', () => {
  it('cleans an OS LANG string to a BCP-47 code', () => {
    expect(normalizeLocale('en_CA.UTF-8')).toBe('en-CA');
  });
  it('unifies separator and case', () => {
    expect(normalizeLocale('en-ca')).toBe('en-CA');
    expect(normalizeLocale('EN_ca')).toBe('en-CA');
  });
  it('keeps a bare language', () => {
    expect(normalizeLocale('en')).toBe('en');
  });
  it('strips an @modifier', () => {
    expect(normalizeLocale('de_DE@euro')).toBe('de-DE');
  });
  // Controls: the values that must NOT become a spellcheck code.
  it('rejects C / POSIX / empty / junk [control]', () => {
    expect(normalizeLocale('C')).toBeUndefined();
    expect(normalizeLocale('POSIX')).toBeUndefined();
    expect(normalizeLocale('')).toBeUndefined();
    expect(normalizeLocale(undefined)).toBeUndefined();
    expect(normalizeLocale('123')).toBeUndefined();
  });
  it('drops an unparseable region to the base language [control]', () => {
    expect(normalizeLocale('en-latn')).toBe('en');
  });
});

describe('resolveSpellCheckerLanguages', () => {
  // THE BUG THIS FIXES: an en_CA user must get en-CA, not en-US.
  it('uses the exact system locale when Chromium offers it', () => {
    expect(resolveSpellCheckerLanguages('en_CA.UTF-8', EN)).toEqual(['en-CA']);
  });

  // CONTROL: a different locale must resolve to a DIFFERENT language, or the
  // function is ignoring its input and hardcoding en-CA.
  it('resolves en_GB to en-GB, not en-CA [control]', () => {
    expect(resolveSpellCheckerLanguages('en_GB.UTF-8', EN)).toEqual(['en-GB']);
  });
  it('resolves fr_FR to fr-FR [control]', () => {
    expect(resolveSpellCheckerLanguages('fr_FR.UTF-8', EN)).toEqual(['fr-FR']);
  });

  it('canonicalizes case to what Chromium actually lists', () => {
    expect(resolveSpellCheckerLanguages('en-ca', EN)).toEqual(['en-CA']);
  });

  // An explicit saved preference overrides the locale...
  it('prefers a saved override over the system locale', () => {
    expect(resolveSpellCheckerLanguages('en_CA', EN, ['en-GB'])).toEqual(['en-GB']);
  });
  // ...but the locale still applies when there is no saved preference [control].
  it('falls back to locale when saved is empty [control]', () => {
    expect(resolveSpellCheckerLanguages('en_CA', EN, [])).toEqual(['en-CA']);
  });
  it('keeps multiple saved languages, filtered + deduped', () => {
    expect(resolveSpellCheckerLanguages('en_CA', EN, ['en-CA', 'fr', 'en-CA'])).toEqual([
      'en-CA',
      'fr',
    ]);
  });
  it('a saved language Chromium does not offer is dropped, then locale wins [control]', () => {
    expect(resolveSpellCheckerLanguages('en_CA', EN, ['xx-YY'])).toEqual(['en-CA']);
  });

  // Base-language fallback: Canadian on a build with only en-US available still
  // gets English, never nothing.
  it('falls back to a regional sibling of the base language', () => {
    expect(resolveSpellCheckerLanguages('en_CA', ['en-US', 'fr'])).toEqual(['en-US']);
  });
  it('falls back to the bare base language when only that exists', () => {
    expect(resolveSpellCheckerLanguages('en_CA', ['en', 'fr'])).toEqual(['en']);
  });

  // Unknown available list: trust the locale rather than filter to empty.
  it('trusts the locale when the available list is unknown/empty', () => {
    expect(resolveSpellCheckerLanguages('en_CA', [])).toEqual(['en-CA']);
    expect(resolveSpellCheckerLanguages('en_CA', undefined)).toEqual(['en-CA']);
  });

  // CONTROL: when nothing can be asserted, return [] so Chromium keeps its
  // default — never worse than today.
  it('returns [] for an unusable locale and no saved pref [control]', () => {
    expect(resolveSpellCheckerLanguages('C', EN)).toEqual([]);
    expect(resolveSpellCheckerLanguages(undefined, EN)).toEqual([]);
  });
  it('returns [] when the base language is not available at all [control]', () => {
    expect(resolveSpellCheckerLanguages('ja_JP', ['en-US', 'fr'])).toEqual([]);
  });
});

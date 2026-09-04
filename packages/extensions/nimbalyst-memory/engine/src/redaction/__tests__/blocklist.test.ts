// @vitest-environment node
/**
 * The blocklist refuses a page outright, which is lossy — the user does not get
 * a second chance to write the memory down. So the cases that matter most here
 * are the ones it must NOT catch: a page that merely *discusses* credentials,
 * or quotes one line that redaction can already handle, has to survive.
 */
import { describe, expect, it } from 'vitest';
import { evaluateBlocklist } from '../blocklist.js';

const PEM_BLOCK = [
  '-----BEGIN OPENSSH PRIVATE KEY-----',
  'b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQAAAAAAAAABAAABlwAAAAdz',
  '-----END OPENSSH PRIVATE KEY-----',
].join('\n');

describe('evaluateBlocklist — refuses', () => {
  const blocked: Array<{ name: string; rule: string; text: string }> = [
    {
      name: 'a PEM private key block',
      rule: 'private-key-material',
      text: `Rotated the signing key on Tuesday.\n${PEM_BLOCK}\nStored in the vault afterwards.`,
    },
    {
      name: 'a stated password',
      rule: 'unlocatable-secret',
      text: 'For the staging box the password is correct-horse-battery-staple, ask Dana if it rotates.',
    },
    {
      name: 'a stated passphrase',
      rule: 'unlocatable-secret',
      text: 'Note that my passphrase is thunder-marmot-42 for the signing key.',
    },
    {
      name: 'a bare password line',
      rule: 'unlocatable-secret',
      text: 'Legacy admin account.\npassword: Tr0ub4dorZ9\nMigrate it off before the beta.',
    },
    {
      name: 'a recovery phrase',
      rule: 'unlocatable-secret',
      text: 'The wallet seed phrase is written on the card in the safe.',
    },
    {
      name: 'a credential dump',
      rule: 'credential-dump',
      text: [
        'Prod env, copied from the dashboard:',
        'DEPLOY_TOKEN=Zq7Vn3RpKdW2sYtLbXc',
        'DB_PASSWORD=Hunter2Tr0ub4dorZ',
        'SENTRY_DSN=https://ab12cd34ef56@o12345.ingest.sentry.io/1234567',
      ].join('\n'),
    },
    {
      name: 'a payment card number',
      rule: 'payment-card',
      text: 'Billing failed against the card ending 4242 4242 4242 4242 on the team plan.',
    },
  ];

  it.each(blocked)('blocks $name', ({ rule, text }) => {
    const result = evaluateBlocklist(text);
    expect(result.blocked).toBe(true);
    expect(result.matches.map((m) => m.rule)).toContain(rule);
    // Every match explains itself; the user sees why the page was refused.
    expect(result.matches.every((m) => m.reason.length > 0)).toBe(true);
  });

  it('reports the private key under its precise rule, not the generic one', () => {
    const result = evaluateBlocklist(PEM_BLOCK);
    expect(result.matches.map((m) => m.rule)).toEqual(['private-key-material']);
  });
});

describe('evaluateBlocklist — allows', () => {
  const allowed: Array<{ name: string; text: string }> = [
    {
      name: 'prose about password handling',
      text: 'We decided password reset emails expire after 30 minutes because the support queue kept seeing reused links.',
    },
    {
      name: 'a documented placeholder',
      text: 'The setup doc tells users to write `password: <your-password>` into the local config.',
    },
    {
      name: 'a single credential line, which redaction already handles',
      text: 'One-off note from the incident:\nDEPLOY_TOKEN=Zq7Vn3RpKdW2sYtLbXc\nRotated an hour later.',
    },
    {
      name: 'two credential lines, still under the dump threshold',
      text: 'DEPLOY_TOKEN=Zq7Vn3RpKdW2sYtLbXc\nDB_PASSWORD=Hunter2Tr0ub4dorZ',
    },
    {
      name: 'a PEM public key',
      text: '-----BEGIN PUBLIC KEY-----\nMIIBIjANBgkqhkiG9w0BAQEFAAO\n-----END PUBLIC KEY-----',
    },
    {
      name: 'a digit run that fails Luhn',
      text: 'The order reference is 4111111111111112 in the billing export.',
    },
    {
      name: 'a long numeric identifier',
      text: 'The migration stamped 20260903120000123456 as the batch id.',
    },
    {
      name: 'a phone number',
      text: 'Support line is +1 415 555 2671 during the beta.',
    },
    {
      name: 'a repeated-digit placeholder',
      text: 'Test fixtures use 4444444444444444 as the card number.',
    },
  ];

  it.each(allowed)('allows $name', ({ text }) => {
    expect(evaluateBlocklist(text)).toEqual({ blocked: false, matches: [] });
  });

  it('honours a caller-supplied dump threshold', () => {
    const text = 'DEPLOY_TOKEN=Zq7Vn3RpKdW2sYtLbXc\nDB_PASSWORD=Hunter2Tr0ub4dorZ';
    expect(evaluateBlocklist(text, { credentialDumpThreshold: 2 }).blocked).toBe(true);
  });
});

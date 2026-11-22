// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sealRecoveryBundle, openRecoveryBundle, writeRecoveryBundle, readRecoveryBundle } from '../TeamRecoveryBundle';

const source = { orgId: 'org-a', version: 1 as const, createdAt: '2026-10-24T00:00:00.000Z', projects: [], documents: [], trackerRows: [{ id: 'item-1', issue_key: 'NIM-612', data: { title: 'Keep this title' } }] };
const password = 'a portable recovery passphrase';

describe('portable encrypted recovery bundle', () => {
  it('writes and verifies a portable file and refuses to overwrite an earlier artifact', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'recovery-bundle-'));
    const file = join(dir, 'sources.nim-recovery');
    try {
      await writeRecoveryBundle(file, source, password);
      expect(await readRecoveryBundle(file, password, 'org-a')).toEqual(source);
      const original = await readFile(file);
      await expect(writeRecoveryBundle(file, source, password)).rejects.toThrow('A file with that name already exists. Recovery never overwrites a saved bundle; choose a new name.');
      expect(await readFile(file)).toEqual(original);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
  it('round-trips original IDs, keys and source data without plaintext in the artifact', async () => {
    const sealed = await sealRecoveryBundle(source, password);
    expect(sealed).not.toContain('Keep this title');
    expect(sealed).not.toContain('NIM-612');
    expect(await openRecoveryBundle(sealed, password, 'org-a')).toEqual(source);
  });

  it('rejects a wrong org, wrong password and tampered ciphertext', async () => {
    const sealed = await sealRecoveryBundle(source, password);
    await expect(openRecoveryBundle(sealed, password, 'org-b')).rejects.toThrow(/organization/);
    await expect(openRecoveryBundle(sealed, 'a different long recovery password', 'org-a')).rejects.toThrow(/unlock/);
    const envelope = JSON.parse(sealed);
    envelope.ciphertext = (envelope.ciphertext[0] === 'A' ? 'B' : 'A') + envelope.ciphertext.slice(1);
    await expect(openRecoveryBundle(JSON.stringify(envelope), password, 'org-a')).rejects.toThrow(/unlock/);
  });

  it('stores a payload repeated across local, server and prepared sources once and restores every reference', async () => {
    const attachment = 'QUJD'.repeat(45 * 1024 * 1024 / 4);
    const repeated = { ...source, projects: [{ assets: [{ assetId: 'a', base64: attachment }] }, { recovery: { prepared: { payloads: [{ payload: { snapshot: attachment, assets: [{ id: 'a', base64: attachment }] } }] } } }] };
    // Three 45 MiB copies would exceed the 128 MiB limit; one stored copy does not.
    const sealed = await sealRecoveryBundle(repeated, password);
    expect(sealed.length).toBeLessThan(attachment.length * 1.5);
    expect(await openRecoveryBundle(sealed, password, 'org-a')).toEqual(repeated);
  });

  it('rejects a bundle in the superseded unreleased format with a clear message', async () => {
    const legacy = JSON.stringify({ format: 'nimbalyst-team-recovery', version: 1, orgId: 'org-a', salt: 'AAAAAAAAAAAAAAAAAAAAAA==', iv: 'AAAAAAAAAAAAAAAA', tag: 'AAAAAAAAAAAAAAAAAAAAAA==', ciphertext: 'AAAA' });
    await expect(openRecoveryBundle(legacy, password, 'org-a')).rejects.toThrow(/earlier preview/);
  });

  it('refuses invalid format and attacker-supplied KDF parameters before decrypting', async () => {
    await expect(openRecoveryBundle('{"version":999,"n":999999999}', password, 'org-a')).rejects.toThrow(/format/);
    await expect(sealRecoveryBundle(source, 'short')).rejects.toThrow(/16/);
  });
});

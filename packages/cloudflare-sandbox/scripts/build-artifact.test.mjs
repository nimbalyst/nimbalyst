import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildArtifact, validateRelease } from './build-artifact.mjs';

test('builds a self-contained Worker with a verifiable, reproducible manifest', async () => {
  const out = await mkdtemp(join(tmpdir(), 'nimbalyst-worker-artifact-'));
  try {
    const { manifest, metafile } = await buildArtifact(out);
    const worker = await readFile(join(out, 'worker.mjs'));
    assert.equal(manifest.workerSha256, createHash('sha256').update(worker).digest('hex'));
    const helper = await readFile(join(out, 'rpc-helper.mjs'));
    assert.equal(manifest.helperSha256, createHash('sha256').update(helper).digest('hex'));
    assert.deepEqual(JSON.parse(await readFile(join(out, 'manifest.json'), 'utf8')), manifest);
    const outputs = Object.values(metafile.outputs);
    assert.equal(outputs.length, 1);
    assert.ok(outputs[0].exports.includes('SandboxManager'));
    assert.ok(outputs[0].exports.includes('ContainerProxy'));
    assert.ok(outputs[0].exports.includes('NimbalystSandbox'));
    assert.ok(outputs[0].imports.every(({ path }) => /^(cloudflare:|node:)/.test(path)), 'No unresolved npm or local imports may reach the deploy artifact');
    assert.deepEqual((await buildArtifact(out)).manifest, manifest);
  } finally {
    await rm(out, { recursive: true, force: true });
  }
});

const sdkVersion = '0.13.0-next.751.1';
const image = `docker.io/nimbalyst/sandbox-node@sha256:${'a'.repeat(64)}`;
const baseImageDigest = `sha256:${'b'.repeat(64)}`;
const pkg = { dependencies: { '@cloudflare/sandbox': sdkVersion } };
const imageConfig = { sandbox: { sdkVersion, imageRef: `docker.io/cloudflare/sandbox:${sdkVersion}`, imageDigest: baseImageDigest } };
const installed = { version: sdkVersion };

test('refuses a published digest without matching SDK and base-image provenance', () => {
  const release = { schemaVersion: 1, sdkVersion, image };
  for (const publishedImage of [undefined, { image, sdkVersion: '0.12.9', baseImageDigest },
    { image, sdkVersion, baseImageDigest: `sha256:${'c'.repeat(64)}` },
    { image: `${image.slice(0, -1)}d`, sdkVersion, baseImageDigest }]) {
    assert.throws(() => validateRelease({ ...release, publishedImage }, pkg, imageConfig, installed), /provenance/);
  }
  validateRelease({ ...release, publishedImage: { image, sdkVersion, baseImageDigest } }, pkg, imageConfig, installed);
  validateRelease({ ...release, image: null }, pkg, imageConfig, installed);
});

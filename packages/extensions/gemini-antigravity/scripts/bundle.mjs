#!/usr/bin/env node
// Package gemini-antigravity into a .nimext (zip) with manifest.json + dist/.
// Mirrors the layout of the prior bundle so the marketplace loader picks it up.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const monorepoRoot = path.resolve(root, '..', '..', '..');

const jsZipUrl = pathToFileURL(path.join(monorepoRoot, 'node_modules', 'jszip', 'lib', 'index.js')).href;
const JSZip = (await import(jsZipUrl)).default;

const zip = new JSZip();

const filesToInclude = [
  'manifest.json',
  'dist/index.js',
  'dist/index.js.map',
  'dist/agent.js',
  'dist/agent.js.map',
];

for (const rel of filesToInclude) {
  const abs = path.join(root, rel);
  if (!fs.existsSync(abs)) {
    console.error(`MISSING: ${rel}`);
    process.exit(1);
  }
  const buf = fs.readFileSync(abs);
  zip.file(rel, buf);
}

const outBuf = await zip.generateAsync({
  type: 'nodebuffer',
  compression: 'DEFLATE',
  compressionOptions: { level: 6 },
});

const targetDir = path.join(monorepoRoot, 'packages', 'electron', 'resources', 'bundled-extensions');
fs.mkdirSync(targetDir, { recursive: true });
const targetPath = path.join(targetDir, 'gemini-antigravity.nimext');
fs.writeFileSync(targetPath, outBuf);

const sha = crypto.createHash('sha256').update(outBuf).digest('hex');
console.log(`Wrote ${targetPath}`);
console.log(`Size:   ${outBuf.length} bytes`);
console.log(`SHA256: ${sha}`);

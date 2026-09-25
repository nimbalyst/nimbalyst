import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(__dirname, '..');
const DIST_DIR = path.join(ROOT_DIR, 'dist-transcript');
const ASSET_DIR = path.join(ROOT_DIR, 'app/build/generated/transcript-assets/transcript-dist');

if (!fs.existsSync(path.join(DIST_DIR, 'transcript.html'))) {
  console.error(`Transcript bundle not found in ${DIST_DIR}`);
  console.error('Run: npm run build:transcript');
  process.exit(1);
}

// Ensure the asset directory exists
if (fs.existsSync(ASSET_DIR)) {
  fs.rmSync(ASSET_DIR, { recursive: true, force: true });
}
fs.mkdirSync(ASSET_DIR, { recursive: true });

// Copy transcript.html
fs.copyFileSync(
  path.join(DIST_DIR, 'transcript.html'),
  path.join(ASSET_DIR, 'transcript.html')
);

// Copy assets directory if it exists
const assetsDistDir = path.join(DIST_DIR, 'assets');
if (fs.existsSync(assetsDistDir)) {
  fs.cpSync(assetsDistDir, path.join(ASSET_DIR, 'assets'), { recursive: true });
}

console.log(`Synced transcript assets to ${ASSET_DIR}`);

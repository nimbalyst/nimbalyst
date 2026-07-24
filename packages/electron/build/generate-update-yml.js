#!/usr/bin/env node

/**
 * Generate update metadata files for electron-updater
 * This script creates the latest-mac.yml, latest.yml, and other update files
 * needed for auto-update functionality
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execSync } = require('child_process');
const { getWindowsPublisherNames } = require('./validate-windows-updater-config');

// Read package.json to get version
const packageJson = require('../package.json');
const version = packageJson.version;
const productName = packageJson.build.productName || 'Preditor';

// Release directory
const releaseDir = path.join(__dirname, '..', 'release');

// Function to calculate SHA512 hash
function calculateSHA512(filePath) {
  const hash = crypto.createHash('sha512');
  const data = fs.readFileSync(filePath);
  hash.update(data);
  return hash.digest('base64');
}

// Function to get file size
function getFileSize(filePath) {
  const stats = fs.statSync(filePath);
  return stats.size;
}

// Function to get release notes
function getReleaseNotes() {
  const releaseNotesPath = path.join(releaseDir, 'RELEASE_NOTES.md');
  if (fs.existsSync(releaseNotesPath)) {
    return fs.readFileSync(releaseNotesPath, 'utf8').trim();
  }
  // Fallback: get recent git commits
  try {
    const commits = execSync('git log --oneline -5 --pretty=format:"- %s"', { encoding: 'utf8' });
    return `## Recent Changes\n\n${commits}`;
  } catch (e) {
    return 'New release available';
  }
}

function duplicateChannelFile(sourceName, targetName) {
  const sourcePath = path.join(releaseDir, sourceName);
  if (!fs.existsSync(sourcePath)) {
    return false;
  }

  const targetPath = path.join(releaseDir, targetName);
  fs.copyFileSync(sourcePath, targetPath);
  console.log(`Generated ${targetPath} from ${sourceName}`);
  return true;
}

// Function to generate latest-mac.yml
function generateMacYml() {
  // Use standard electron-builder filenames with architecture suffixes.
  // electron-updater requires these suffixes to correctly route updates.
  //
  // Note: afterAllArtifactBuild.js also creates copies without the arch suffix
  // (e.g., Nimbalyst-macOS.dmg) for backwards-compatible download links,
  // but those are NOT referenced in the yml - only the arch-suffixed files are.

  const files = [];

  // Apple Silicon files
  const arm64Zip = `${productName}-macOS-arm64.zip`;
  const arm64ZipPath = path.join(releaseDir, arm64Zip);
  const arm64Dmg = `${productName}-macOS-arm64.dmg`;
  const arm64DmgPath = path.join(releaseDir, arm64Dmg);

  // Intel files
  const x64Zip = `${productName}-macOS-x64.zip`;
  const x64ZipPath = path.join(releaseDir, x64Zip);
  const x64Dmg = `${productName}-macOS-x64.dmg`;
  const x64DmgPath = path.join(releaseDir, x64Dmg);

  // Add Apple Silicon ZIP (primary)
  if (fs.existsSync(arm64ZipPath)) {
    files.push({
      url: arm64Zip,
      sha512: calculateSHA512(arm64ZipPath),
      size: getFileSize(arm64ZipPath),
      arch: 'arm64'
    });
  }

  // Add Intel ZIP
  if (fs.existsSync(x64ZipPath)) {
    files.push({
      url: x64Zip,
      sha512: calculateSHA512(x64ZipPath),
      size: getFileSize(x64ZipPath),
      arch: 'x64'
    });
  }

  // Add Apple Silicon DMG
  if (fs.existsSync(arm64DmgPath)) {
    files.push({
      url: arm64Dmg,
      sha512: calculateSHA512(arm64DmgPath),
      size: getFileSize(arm64DmgPath),
      arch: 'arm64'
    });
  }

  // Add Intel DMG
  if (fs.existsSync(x64DmgPath)) {
    files.push({
      url: x64Dmg,
      sha512: calculateSHA512(x64DmgPath),
      size: getFileSize(x64DmgPath),
      arch: 'x64'
    });
  }

  if (files.length === 0) {
    console.error('No DMG or ZIP files found in release directory');
    return false;
  }

  // Get release notes
  const releaseNotes = getReleaseNotes();

  // Primary file is the Apple Silicon ZIP (first in list)
  const primaryFile = files[0];

  // Generate the YAML content
  const yamlContent = {
    version: version,
    files: files,
    path: primaryFile.url,
    sha512: primaryFile.sha512,
    releaseDate: new Date().toISOString(),
    releaseNotes: releaseNotes
  };

  // Convert to YAML format
  let yamlString = `version: ${yamlContent.version}\n`;
  yamlString += `files:\n`;
  yamlContent.files.forEach(file => {
    yamlString += `  - url: ${file.url}\n`;
    yamlString += `    sha512: ${file.sha512}\n`;
    yamlString += `    size: ${file.size}\n`;
    if (file.arch) {
      yamlString += `    arch: ${file.arch}\n`;
    }
  });
  yamlString += `path: ${yamlContent.path}\n`;
  yamlString += `sha512: ${yamlContent.sha512}\n`;
  yamlString += `releaseDate: '${yamlContent.releaseDate}'\n`;
  // Add release notes as multi-line string
  yamlString += `releaseNotes: |\n`;
  yamlContent.releaseNotes.split('\n').forEach(line => {
    yamlString += `  ${line}\n`;
  });

  // Write the file
  const outputPath = path.join(releaseDir, 'latest-mac.yml');
  fs.writeFileSync(outputPath, yamlString);
  console.log(`Generated ${outputPath}`);

  return true;
}

// Function to generate latest.yml (for Windows)
function generateWindowsYml() {
  // artifactName in package.json is "${productName}-Windows-${arch}.${ext}",
  // so builds produce Nimbalyst-Windows-x64.exe and Nimbalyst-Windows-arm64.exe.
  //
  // CI also copies the signed x64 exe to Nimbalyst-Windows.exe for backwards-
  // compatible download links, but latest.yml only references the arch-suffixed
  // files so electron-updater can route each machine to the correct binary.

  const files = [];

  const x64Exe = `${productName}-Windows-x64.exe`;
  const x64Path = path.join(releaseDir, x64Exe);
  const arm64Exe = `${productName}-Windows-arm64.exe`;
  const arm64Path = path.join(releaseDir, arm64Exe);

  if (fs.existsSync(x64Path)) {
    files.push({
      url: x64Exe,
      sha512: calculateSHA512(x64Path),
      size: getFileSize(x64Path),
      arch: 'x64'
    });
  }

  if (fs.existsSync(arm64Path)) {
    files.push({
      url: arm64Exe,
      sha512: calculateSHA512(arm64Path),
      size: getFileSize(arm64Path),
      arch: 'arm64'
    });
  }

  if (files.length === 0) {
    console.log(`No Windows exe files found in ${releaseDir}, skipping latest.yml`);
    return false;
  }

  // x64 is the primary file -- it's the most common architecture and matches
  // the backwards-compatible Nimbalyst-Windows.exe download. If only arm64 is
  // present (per-job generation before the release merge), fall back to it.
  const primaryFile = files.find((f) => f.arch === 'x64') || files[0];

  const publisherNames = getWindowsPublisherNames();

  if (publisherNames.length === 0) {
    throw new Error(
      'Cannot generate latest.yml without build.win.signtoolOptions.publisherName. ' +
      'This would break Windows auto-update signature verification.'
    );
  }

  // Convert to YAML format
  let yamlString = `version: ${version}\n`;
  yamlString += `files:\n`;
  files.forEach(file => {
    yamlString += `  - url: ${file.url}\n`;
    yamlString += `    sha512: ${file.sha512}\n`;
    yamlString += `    size: ${file.size}\n`;
    yamlString += `    arch: ${file.arch}\n`;
  });
  yamlString += `path: ${primaryFile.url}\n`;
  yamlString += `sha512: ${primaryFile.sha512}\n`;
  yamlString += `releaseDate: '${new Date().toISOString()}'\n`;
  // publisherName tells electron-updater which Authenticode publisher to expect.
  // Without this, it falls back to comparing against the installed app's registry
  // publisher, which breaks when the signing certificate changes (e.g., personal
  // Apple Dev ID -> corporate DigiCert).
  yamlString += `publisherName:\n`;
  publisherNames.forEach((publisherName) => {
    yamlString += `  - "${publisherName}"\n`;
  });

  // Write the file
  const outputPath = path.join(releaseDir, 'latest.yml');
  fs.writeFileSync(outputPath, yamlString);
  console.log(`Generated ${outputPath} with ${files.length} arch(es): ${files.map((f) => f.arch).join(', ')}`);
  return true;
}

// Function to generate latest-linux.yml (for Linux)
function generateLinuxYml() {
  // Use the artifactName from package.json: "${productName}-Linux.${ext}"
  const appImageFile = `${productName}-Linux.AppImage`;
  const appImagePath = path.join(releaseDir, appImageFile);

  if (!fs.existsSync(appImagePath)) {
    console.log(`Linux AppImage not found: ${appImagePath}, skipping latest-linux.yml`);
    return false;
  }

  const yamlContent = {
    version: version,
    files: [{
      url: appImageFile,
      sha512: calculateSHA512(appImagePath),
      size: getFileSize(appImagePath)
    }],
    path: appImageFile,
    sha512: calculateSHA512(appImagePath),
    releaseDate: new Date().toISOString()
  };

  // Convert to YAML format
  let yamlString = `version: ${yamlContent.version}\n`;
  yamlString += `files:\n`;
  yamlContent.files.forEach(file => {
    yamlString += `  - url: ${file.url}\n`;
    yamlString += `    sha512: ${file.sha512}\n`;
    yamlString += `    size: ${file.size}\n`;
  });
  yamlString += `path: ${yamlContent.path}\n`;
  yamlString += `sha512: ${yamlContent.sha512}\n`;
  yamlString += `releaseDate: '${yamlContent.releaseDate}'\n`;

  // Write the file
  const outputPath = path.join(releaseDir, 'latest-linux.yml');
  fs.writeFileSync(outputPath, yamlString);
  console.log(`Generated ${outputPath}`);
  return true;
}

// Check if release directory exists
if (!fs.existsSync(releaseDir)) {
  console.error('Release directory does not exist:', releaseDir);
  process.exit(1);
}

// Generate update files
console.log(`Generating update metadata files for version ${version}...`);

const macSuccess = generateMacYml();
const windowsSuccess = generateWindowsYml();
const linuxSuccess = generateLinuxYml();
const alphaMacSuccess = duplicateChannelFile('latest-mac.yml', 'alpha-mac.yml');
const alphaWindowsSuccess = duplicateChannelFile('latest.yml', 'alpha.yml');
const alphaLinuxSuccess = duplicateChannelFile('latest-linux.yml', 'alpha-linux.yml');

console.log('');
console.log('Generation results:');
console.log(`  latest-mac.yml: ${macSuccess ? 'OK' : 'SKIPPED (no macOS files found)'}`);
console.log(`  latest.yml (Windows): ${windowsSuccess ? 'OK' : 'SKIPPED (no Windows exe found)'}`);
console.log(`  latest-linux.yml: ${linuxSuccess ? 'OK' : 'SKIPPED (no Linux AppImage found)'}`);
console.log(`  alpha-mac.yml: ${alphaMacSuccess ? 'OK' : 'SKIPPED (no latest-mac.yml found)'}`);
console.log(`  alpha.yml (Windows): ${alphaWindowsSuccess ? 'OK' : 'SKIPPED (no latest.yml found)'}`);
console.log(`  alpha-linux.yml: ${alphaLinuxSuccess ? 'OK' : 'SKIPPED (no latest-linux.yml found)'}`);

if (!macSuccess && !windowsSuccess && !linuxSuccess) {
  console.error('Failed to generate any update metadata files');
  process.exit(1);
}

console.log('');
console.log('Update metadata files generated successfully');

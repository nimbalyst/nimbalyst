/**
 * Build all extensions before packaging.
 *
 * This script first builds the extension-sdk (which extensions depend on),
 * then finds all extensions in packages/extensions/ that have a build script
 * and runs npm run build for each one. This ensures extension dist/ folders exist
 * before electron-builder packages them.
 *
 * After building each extension, it validates that the manifest.main and
 * manifest.styles files actually exist. This catches mismatches between
 * vite.config.ts output filenames and manifest.json early.
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const EXTENSIONS_DIR = path.resolve(__dirname, '..', '..', 'extensions');
const EXTENSION_SDK_DIR = path.resolve(__dirname, '..', '..', 'extension-sdk');

/**
 * Validate that an extension's manifest.main and manifest.styles point to real files.
 * Returns an array of error messages (empty if valid).
 */
function validateExtensionManifest(extPath, extName) {
  const manifestPath = path.join(extPath, 'manifest.json');
  const errors = [];

  if (!fs.existsSync(manifestPath)) {
    // No manifest is okay - some extensions might not have one yet
    return errors;
  }

  try {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));

    // Validate main entry point exists
    if (manifest.main) {
      const mainPath = path.join(extPath, manifest.main);
      if (!fs.existsSync(mainPath)) {
        errors.push(
          `manifest.main "${manifest.main}" not found. ` +
          `Expected file at: ${mainPath}\n` +
          `    Make sure vite.config.ts fileName matches manifest.json "main" field.`
        );
      }
    }

    // Validate styles file exists (if specified)
    if (manifest.styles) {
      const stylesPath = path.join(extPath, manifest.styles);
      if (!fs.existsSync(stylesPath)) {
        errors.push(
          `manifest.styles "${manifest.styles}" not found. ` +
          `Expected file at: ${stylesPath}`
        );
      }
    }
  } catch (error) {
    errors.push(`Failed to parse manifest.json: ${error.message}`);
  }

  return errors;
}

async function buildExtensions() {
  // First, build the extension-sdk since extensions depend on it
  console.log('Building extension-sdk...');
  if (fs.existsSync(EXTENSION_SDK_DIR)) {
    const sdkPackageJson = path.join(EXTENSION_SDK_DIR, 'package.json');
    if (fs.existsSync(sdkPackageJson)) {
      const pkg = JSON.parse(fs.readFileSync(sdkPackageJson, 'utf-8'));
      if (pkg.scripts?.build) {
        try {
          execSync('npm run build', {
            cwd: EXTENSION_SDK_DIR,
            stdio: 'inherit',
          });
          console.log('Built extension-sdk successfully');
        } catch (error) {
          console.error('Failed to build extension-sdk:', error.message);
          process.exit(1);
        }
      }
    }
  }

  console.log('Building extensions...');

  // Check if extensions directory exists
  if (!fs.existsSync(EXTENSIONS_DIR)) {
    console.log('No extensions directory found, skipping');
    return;
  }

  // Get all subdirectories in the extensions folder
  const entries = fs.readdirSync(EXTENSIONS_DIR, { withFileTypes: true });
  const extensionDirs = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);

  for (const extDir of extensionDirs) {
    const extPath = path.join(EXTENSIONS_DIR, extDir);
    const packageJsonPath = path.join(extPath, 'package.json');

    // Check if package.json exists
    if (!fs.existsSync(packageJsonPath)) {
      console.log(`  Skipping ${extDir}: no package.json`);
      continue;
    }

    // Read package.json to check for build script
    const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf-8'));

    if (!packageJson.scripts?.build) {
      console.log(`  Skipping ${extDir}: no build script`);
      continue;
    }

    console.log(`  Building ${extDir}...`);

    try {
      execSync('npm run build', {
        cwd: extPath,
        stdio: 'inherit',
      });

      // Validate manifest after build
      const validationErrors = validateExtensionManifest(extPath, extDir);
      if (validationErrors.length > 0) {
        console.error(`\n  Validation failed for ${extDir}:`);
        validationErrors.forEach((err) => console.error(`    - ${err}`));
        process.exit(1);
      }

      console.log(`  Built ${extDir} successfully`);
    } catch (error) {
      console.error(`  Failed to build ${extDir}:`, error.message);
      process.exit(1);
    }
  }

  console.log('All extensions built successfully');
}

buildExtensions().catch((error) => {
  console.error('Failed to build extensions:', error);
  process.exit(1);
});

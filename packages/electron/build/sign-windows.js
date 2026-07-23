const { execFile } = require('node:child_process');
const { rename } = require('node:fs/promises');
const path = require('node:path');
const { promisify } = require('node:util');

const execFileAsync = promisify(execFile);

/**
 * Delegate every Windows PE signing pass from electron-builder to DigiCert
 * KeyLocker. This runs before NSIS packages the app, so the payload and the
 * installer carry the same trusted Windows publisher.
 */
exports.default = async function signWindows(configuration) {
  const keypairAlias = process.env.DIGICERT_KEYPAIR_ALIAS;
  const allowUnsignedBuild = process.env.ALLOW_UNSIGNED_WINDOWS_BUILD === 'true';
  const smctlPath = process.env.SMCTL_PATH || 'smctl';

  if (!keypairAlias) {
    if (process.env.CI === 'true' && !allowUnsignedBuild) {
      throw new Error('DIGICERT_KEYPAIR_ALIAS is required for Windows CI builds');
    }

    console.warn(`[windows-sign] Skipping ${configuration.path}: DigiCert KeyLocker is not configured`);
    return;
  }

  if (configuration.hash && configuration.hash !== 'sha256') {
    throw new Error(`Unsupported Windows signing hash: ${configuration.hash}`);
  }

  // DigiCert simple signing recognizes PE binaries by extension and does not
  // list Electron's .node extension. Authenticode does not bind the filename,
  // so use a temporary .dll name for native modules and restore it afterward.
  const isNativeModule = path.extname(configuration.path).toLowerCase() === '.node';
  const signingPath = isNativeModule ? `${configuration.path}.dll` : configuration.path;

  if (isNativeModule) await rename(configuration.path, signingPath);
  try {
    console.log(`[windows-sign] Signing ${configuration.path} with DigiCert KeyLocker`);
    const { stdout, stderr } = await execFileAsync(
      smctlPath,
      [
        'sign',
        '--keypair-alias',
        keypairAlias,
        '--input',
        signingPath,
        '--simple'
      ],
      {
        env: process.env,
        maxBuffer: 10 * 1024 * 1024,
        windowsHide: true
      }
    );

    if (stdout) process.stdout.write(stdout);
    if (stderr) process.stderr.write(stderr);
  } finally {
    if (isNativeModule) await rename(signingPath, configuration.path);
  }
};

const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { setTimeout: delay } = require('node:timers/promises');

const execFileAsync = promisify(execFile);

const productName = require('../package.json').build.productName;

// electron-builder asks us to sign far more than Windows needs. It walks
// resources/app.asar.unpacked, extraResources and swiftshader, and signs every
// .exe it finds (winPackager.js `shouldSignFile`: `file.endsWith(".exe")` is the
// backwards-compatible default even with signExts unset). That pulls in bundled
// third-party binaries -- rg.exe, codex.exe, Microsoft's OpenConsole.exe,
// winpty-agent.exe. Two reasons not to sign them:
//
//   1. Cost. Each pass is a DigiCert KeyLocker call against a fixed yearly
//      allocation. Signing the payload wholesale ran 59 calls per x64 build and
//      exhausted a 1,000-call allocation in nine release runs.
//   2. Provenance. Those binaries carry their upstream publisher's signature.
//      Replacing it with ours asserts we built them; we didn't.
//
// Windows and SmartScreen attribute the app by the payload executable and the
// installer, so this is an allowlist, not a denylist: a new bundled dependency
// must not silently start costing signings. The uninstaller is named from
// build.win.artifactName, so it shares the installer's prefix (#853).
const PAYLOAD_EXECUTABLE = `${productName}.exe`;
const DISTRIBUTABLE_PREFIX = `${productName}-Windows-`;

// Split on both separators rather than path.basename: electron-builder hands us
// Windows paths, but this also runs under the test suite on POSIX hosts, where
// path.basename would return the whole string and match nothing.
function baseName(filePath) {
  const segments = filePath.split(/[\\/]/);
  return segments[segments.length - 1];
}

function shouldSign(filePath) {
  const fileName = baseName(filePath);
  if (fileName === PAYLOAD_EXECUTABLE) {
    return true;
  }
  return fileName.startsWith(DISTRIBUTABLE_PREFIX) && fileName.endsWith('.exe');
}

// A single signing request that times out fails the whole release, and the
// v0.72.7 run lost 40 seconds to `context deadline exceeded` on one file.
// Retries are deliberately few: a timed-out request may already have consumed a
// signing on DigiCert's side, so each attempt has a real cost.
const SIGN_ATTEMPTS = 3;
const RETRY_DELAYS_MS = [5000, 15000];

async function signWithKeyLocker(filePath, keypairAlias, smctlPath) {
  for (let attempt = 1; attempt <= SIGN_ATTEMPTS; attempt++) {
    try {
      const { stdout, stderr } = await execFileAsync(
        smctlPath,
        ['sign', '--keypair-alias', keypairAlias, '--input', filePath, '--simple'],
        {
          env: process.env,
          maxBuffer: 10 * 1024 * 1024,
          windowsHide: true
        }
      );

      if (stdout) process.stdout.write(stdout);
      if (stderr) process.stderr.write(stderr);
      return;
    } catch (error) {
      if (error.stdout) process.stdout.write(error.stdout);
      if (error.stderr) process.stderr.write(error.stderr);

      if (attempt === SIGN_ATTEMPTS) {
        throw new Error(
          `[windows-sign] Failed to sign ${filePath} after ${SIGN_ATTEMPTS} attempts: ${error.message}`
        );
      }

      const retryDelay = RETRY_DELAYS_MS[attempt - 1];
      console.warn(
        `[windows-sign] Attempt ${attempt}/${SIGN_ATTEMPTS} failed for ${baseName(filePath)}; retrying in ${retryDelay / 1000}s`
      );
      await delay(retryDelay);
    }
  }
}

/**
 * Delegate Windows PE signing from electron-builder to DigiCert KeyLocker. This
 * runs before NSIS packages the app, so the payload executable and the
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

  if (!shouldSign(configuration.path)) {
    console.log(`[windows-sign] Skipping bundled binary ${baseName(configuration.path)}`);
    return;
  }

  console.log(`[windows-sign] Signing ${configuration.path} with DigiCert KeyLocker`);
  await signWithKeyLocker(configuration.path, keypairAlias, smctlPath);
};

exports.shouldSign = shouldSign;

// Also usable as a CLI so the cross-architecture ARM64 job signs its payload
// through the same allowlist and retry policy: node build/sign-windows.js <path>
if (require.main === module) {
  const filePath = process.argv[2];
  if (!filePath) {
    console.error('Usage: node build/sign-windows.js <path-to-binary>');
    process.exit(1);
  }

  exports.default({ path: filePath }).catch(error => {
    console.error(error.message);
    process.exit(1);
  });
}

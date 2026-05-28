/**
 * IPC handlers for the extension marketplace.
 *
 * Provides handlers for:
 * - Fetching the extension registry from extensions.nimbalyst.com (with mock fallback)
 * - Installing extensions from the marketplace (.nimext download + extract)
 * - Installing extensions from GitHub URLs
 * - Uninstalling marketplace extensions
 * - Checking for updates
 * - Auto-updating extensions silently
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import * as crypto from 'crypto';
import { spawn } from 'child_process';
import extractZip from 'extract-zip';
import { BrowserWindow, net } from 'electron';
import { logger } from '../utils/logger';
import { safeHandle } from '../utils/ipcRegistry';
import { getUserExtensionsDirectory, initializeExtensionFileTypes } from './ExtensionHandlers';
import {
  getMarketplaceInstalls,
  getMarketplaceInstall,
  addMarketplaceInstall,
  removeMarketplaceInstall,
  updateMarketplaceInstall,
  type MarketplaceInstallRecord,
} from '../utils/store';
import {
  selectReleaseAsset,
  type GitHubReleaseAsset,
} from './extensionReleaseAsset';

// Import mock registry data (used as fallback when live registry is unreachable)
import mockRegistry from '../data/extensionRegistry.json';

// Live registry URL -- served by the marketplace Cloudflare Worker
const REGISTRY_URL = 'https://extensions.nimbalyst.com/registry';

const RENAMED_EXTENSION_IDS: Record<string, string> = {
  'com.developer.nimbalyst-mindmap': 'com.nimbalyst.mindmap',
};

// Registry cache
let registryCache: RegistryData | null = null;
let registryCacheTimestamp = 0;
const REGISTRY_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes (matches Worker cache)

export interface RegistryExtension {
  id: string;
  name: string;
  description: string;
  version: string;
  author: string;
  categories: string[];
  tags: string[];
  icon: string;
  screenshots: Array<{ src: string; alt: string }>;
  downloads: number;
  featured: boolean;
  permissions: string[];
  minimumAppVersion: string;
  downloadUrl: string;
  checksum: string;
  repositoryUrl: string;
  changelog: string;
}

export interface RegistryCategory {
  id: string;
  name: string;
  icon: string;
}

export interface RegistryData {
  schemaVersion: number;
  generatedAt: string;
  extensions: RegistryExtension[];
  categories: RegistryCategory[];
}

export interface PendingMarketplaceInstallRequest {
  extensionId: string;
  requestedAt: string;
}

interface InstallResult {
  success: boolean;
  error?: string;
  extensionId?: string;
}

let pendingMarketplaceInstallRequest: PendingMarketplaceInstallRequest | null = null;

/**
 * Fetch registry data from the live Cloudflare Worker.
 * Falls back to mock data if the live registry is unreachable.
 */
async function fetchRegistry(): Promise<RegistryData> {
  const now = Date.now();
  if (registryCache && (now - registryCacheTimestamp) < REGISTRY_CACHE_TTL_MS) {
    return registryCache;
  }

  try {
    const response = await net.fetch(REGISTRY_URL, {
      headers: { 'Accept': 'application/json' },
    });

    if (response.ok) {
      const data = await response.json() as RegistryData;
      registryCache = data;
      registryCacheTimestamp = now;
      logger.main.info(`[ExtMarketplace] Fetched live registry: ${data.extensions?.length ?? 0} extensions`);
      return data;
    }

    logger.main.warn(`[ExtMarketplace] Live registry returned ${response.status}, using mock fallback`);
  } catch (err) {
    logger.main.warn(`[ExtMarketplace] Failed to fetch live registry, using mock fallback:`, err);
  }

  // Fallback to mock data
  registryCache = mockRegistry as RegistryData;
  registryCacheTimestamp = now;
  return registryCache;
}

/**
 * Execute a git command safely.
 */
function execGit(args: string[], options?: { cwd?: string }): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn('git', args, {
      cwd: options?.cwd,
      stdio: 'pipe',
    });

    let stdout = '';
    let stderr = '';
    proc.stdout?.on('data', (data) => { stdout += data.toString(); });
    proc.stderr?.on('data', (data) => { stderr += data.toString(); });

    proc.on('close', (code) => {
      if (code === 0) {
        resolve(stdout.trim());
      } else {
        reject(new Error(`git command failed (code ${code}): ${stderr}`));
      }
    });

    proc.on('error', (err) => {
      reject(err);
    });
  });
}

/**
 * Recursively copy a directory.
 */
async function copyDirectory(src: string, dest: string): Promise<void> {
  await fs.mkdir(dest, { recursive: true });
  const entries = await fs.readdir(src, { withFileTypes: true });

  for (const entry of entries) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);

    if (entry.isDirectory()) {
      // Skip .git directories
      if (entry.name === '.git' || entry.name === 'node_modules') continue;
      await copyDirectory(srcPath, destPath);
    } else {
      await fs.copyFile(srcPath, destPath);
    }
  }
}

interface ParsedManifest {
  id?: string;
  name?: string;
  version?: string;
  main?: string;
  contributions?: Record<string, unknown>;
}

// Mirrors onlyThemes / onlyClaudePlugin validation in ExtensionLoader.ts: these
// extension shapes have no JS to run, so a dist/ directory is not required.
export function isManifestOnlyExtension(manifest: ParsedManifest): boolean {
  const c = manifest.contributions;
  if (!c) return false;

  const onlyClaudePlugin = c.claudePlugin &&
    !c.customEditors && !c.documentHeaders && !c.aiTools && !c.slashCommands &&
    !c.nodes && !c.transformers && !c.hostComponents && !c.panels &&
    !c.settingsPanel && !c.newFileMenu && !c.configuration && !c.themes;

  const onlyThemes = c.themes &&
    !c.claudePlugin && !c.customEditors && !c.documentHeaders && !c.aiTools &&
    !c.slashCommands && !c.nodes && !c.transformers && !c.hostComponents &&
    !c.panels && !c.settingsPanel && !c.newFileMenu && !c.configuration;

  const noMain = typeof manifest.main !== 'string' || !manifest.main;

  return Boolean((onlyClaudePlugin || onlyThemes) && noMain);
}

// ---------------------------------------------------------------------------
// GitHub release lookup
// ---------------------------------------------------------------------------

interface GitHubRelease {
  tag_name: string;
  assets: GitHubReleaseAsset[];
}

/**
 * Fetch the "latest" release for a repo. Returns null on 404 (no release).
 * Throws on other network/protocol errors so the caller can decide whether
 * to surface them or quietly fall through.
 *
 * Uses `/releases/latest`, which excludes prereleases by GitHub's definition.
 * Unauthenticated -- rate-limited to 60 req/hour per IP, which is fine for
 * a click-to-install UX.
 */
async function fetchLatestRelease(owner: string, repo: string): Promise<GitHubRelease | null> {
  const url = `https://api.github.com/repos/${owner}/${repo}/releases/latest`;
  const response = await net.fetch(url, {
    headers: { 'Accept': 'application/vnd.github+json' },
  });
  if (response.status === 404) {
    return null;
  }
  if (!response.ok) {
    throw new Error(`GitHub API returned ${response.status}`);
  }
  return await response.json() as GitHubRelease;
}

// ---------------------------------------------------------------------------
// Install progress reporting
// ---------------------------------------------------------------------------

export type InstallProgressStage =
  | 'checking-release'
  | 'downloading-release'
  | 'cloning'
  | 'installing'
  | 'done';

export interface InstallProgressEvent {
  stage: InstallProgressStage;
  message: string;
}

type ProgressReporter = (event: InstallProgressEvent) => void;

const noopProgress: ProgressReporter = () => {};

/**
 * Download a file using Electron's net module.
 * Returns the path to the downloaded temp file.
 */
async function downloadFile(url: string): Promise<string> {
  const response = await net.fetch(url);
  if (!response.ok) {
    throw new Error(`Download failed: HTTP ${response.status}`);
  }

  const buffer = Buffer.from(await response.arrayBuffer());
  const tempFile = path.join(os.tmpdir(), `nimext-${Date.now()}-${Math.random().toString(36).slice(2)}.nimext`);
  await fs.writeFile(tempFile, buffer);
  return tempFile;
}

/**
 * Verify SHA-256 checksum of a file.
 */
async function verifyChecksum(filePath: string, expectedChecksum: string): Promise<boolean> {
  if (!expectedChecksum) return true; // Skip if no checksum provided

  const fileBuffer = await fs.readFile(filePath);
  const hash = crypto.createHash('sha256').update(fileBuffer).digest('hex');
  return hash === expectedChecksum;
}

/**
 * Extract a .nimext (zip) file to a directory.
 *
 * Uses the pure-JS `extract-zip` package so this works on Windows (where there
 * is no system `unzip` binary) in addition to macOS and Linux.
 */
async function extractNimext(nimextPath: string, destPath: string): Promise<void> {
  await fs.mkdir(destPath, { recursive: true });
  await extractZip(nimextPath, { dir: destPath });
}

interface InstallFromPackageUrlOptions {
  /** URL to download the .nimext/.zip package from. */
  downloadUrl: string;
  /** Optional SHA-256 checksum for integrity verification. */
  expectedChecksum?: string;
  /**
   * Optional expected extension id. When set, the package's manifest.id must
   * match exactly. Used by the curated marketplace where the id is known
   * upfront from the registry entry.
   */
  expectedExtensionId?: string;
  /** Constructs the MarketplaceInstallRecord from the parsed manifest. */
  buildRecord: (manifest: ParsedManifest) => MarketplaceInstallRecord;
  /** Short tag for logging (e.g. "marketplace", "github-release"). */
  logTag: string;
  progress?: ProgressReporter;
}

/**
 * Shared download-extract-validate-register flow for any pre-built extension
 * package (a `.nimext` or `.zip` containing a top-level `manifest.json`).
 *
 * Extracts to a staging directory first so a broken package does not wipe
 * out an existing installation.
 */
async function installFromPackageUrl(opts: InstallFromPackageUrlOptions): Promise<InstallResult> {
  const progress = opts.progress ?? noopProgress;
  const extensionsDir = await getUserExtensionsDirectory();
  let tempFile: string | null = null;
  let stagingPath: string | null = null;

  try {
    if (!opts.downloadUrl) {
      return { success: false, error: 'No download URL available' };
    }

    // 1. Download
    logger.main.info(`[ExtMarketplace] [${opts.logTag}] downloading: ${opts.downloadUrl}`);
    tempFile = await downloadFile(opts.downloadUrl);

    // 2. Verify checksum (if provided)
    if (opts.expectedChecksum) {
      const valid = await verifyChecksum(tempFile, opts.expectedChecksum);
      if (!valid) {
        return { success: false, error: 'Checksum verification failed. The download may be corrupted or tampered with.' };
      }
      logger.main.info(`[ExtMarketplace] [${opts.logTag}] checksum verified`);
    }

    // 3. Extract to a staging directory
    stagingPath = path.join(extensionsDir, `.staging-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    try {
      await extractNimext(tempFile, stagingPath);
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      return { success: false, error: `Package is not a valid Nimbalyst extension archive: ${errMsg}` };
    }

    // 4. Read + validate manifest
    const manifestPath = path.join(stagingPath, 'manifest.json');
    let manifestContent: string;
    try {
      manifestContent = await fs.readFile(manifestPath, 'utf-8');
    } catch {
      return { success: false, error: 'Package is missing manifest.json at the top level.' };
    }
    let manifest: ParsedManifest;
    try {
      manifest = JSON.parse(manifestContent);
    } catch {
      return { success: false, error: 'Package has an invalid manifest.json (could not parse JSON).' };
    }
    if (!manifest.id) {
      return { success: false, error: 'Package manifest.json missing required "id" field.' };
    }
    if (opts.expectedExtensionId && manifest.id !== opts.expectedExtensionId) {
      return {
        success: false,
        error: `Package manifest id "${manifest.id}" does not match expected "${opts.expectedExtensionId}".`,
      };
    }

    const extensionId = manifest.id;
    const finalInstallPath = path.join(extensionsDir, extensionId);

    // 5. Replace any existing installation by moving staging to final
    progress({ stage: 'installing', message: `Installing ${extensionId}...` });
    await fs.rm(finalInstallPath, { recursive: true, force: true });
    await fs.rename(stagingPath, finalInstallPath);
    stagingPath = null; // Moved successfully; do not clean up in finally

    // 6. Track + notify
    addMarketplaceInstall(opts.buildRecord(manifest));
    await initializeExtensionFileTypes();
    notifyExtensionsChanged(extensionId, finalInstallPath);

    logger.main.info(`[ExtMarketplace] [${opts.logTag}] installed ${extensionId} v${manifest.version ?? '0.0.0'}`);
    return { success: true, extensionId };

  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    logger.main.error(`[ExtMarketplace] [${opts.logTag}] install failed:`, err);
    return { success: false, error: errorMsg };
  } finally {
    if (stagingPath) {
      try { await fs.rm(stagingPath, { recursive: true, force: true }); } catch { /* ignore */ }
    }
    if (tempFile) {
      try { await fs.unlink(tempFile); } catch { /* ignore */ }
    }
  }
}

/**
 * Install an extension from a curated-marketplace download URL.
 */
async function installFromUrl(
  extensionId: string,
  downloadUrl: string,
  expectedChecksum: string,
  version: string,
): Promise<InstallResult> {
  logger.main.info(`[ExtMarketplace] Installing extension: ${extensionId} v${version}`);
  return installFromPackageUrl({
    downloadUrl,
    expectedChecksum: expectedChecksum || undefined,
    expectedExtensionId: extensionId,
    buildRecord: () => ({
      extensionId,
      version,
      installedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      downloadUrl,
      checksum: expectedChecksum,
      source: 'marketplace',
    }),
    logTag: 'marketplace',
  });
}

/**
 * Install an extension from a GitHub repository URL.
 *
 * Strategy:
 *  1. Try to fetch the repo's "latest" GitHub Release and install a pre-built
 *     `.nimext` / `.zip` asset if one is found (Obsidian/BRAT-style).
 *  2. If no release exists or no usable asset is attached, fall back to
 *     cloning HEAD and looking for a committed `dist/` directory (or a
 *     manifest-only extension).
 *
 * A present-but-broken release asset is a hard fail and does NOT fall
 * through to clone-source: doing so would silently install a different
 * (older, source-based) version of the extension under the same id.
 */
async function installFromGitHub(
  githubUrl: string,
  progress: ProgressReporter = noopProgress,
): Promise<InstallResult> {
  // Parse GitHub URL
  const match = githubUrl.match(/github\.com\/([^/]+\/[^/]+?)(?:\.git)?(?:\/tree\/[^/]+\/(.+))?(?:\/?$)/);
  if (!match) {
    return { success: false, error: `Invalid GitHub URL: ${githubUrl}` };
  }
  const [, repo, subdir] = match;
  const [owner, repoName] = repo.split('/');

  logger.main.info(`[ExtMarketplace] GitHub install: ${githubUrl} -- trying release asset`);
  progress({ stage: 'checking-release', message: 'Checking for release artifact...' });

  // ---- Path 1: release asset ----------------------------------------------
  let release: GitHubRelease | null = null;
  try {
    release = await fetchLatestRelease(owner, repoName);
  } catch (err) {
    // Network/protocol error: log and fall through to clone-source. We do
    // not surface this to the user because offline-flaky-network users
    // should still be able to clone-install.
    logger.main.warn(`[ExtMarketplace] GitHub install: ${githubUrl} -- release lookup failed, falling through to clone-source:`, err);
  }

  if (release) {
    const asset = selectReleaseAsset(release.assets, { repoName, subdir });
    if (asset) {
      logger.main.info(`[ExtMarketplace] GitHub install: ${githubUrl} -- using release asset ${asset.name} (tag ${release.tag_name})`);
      progress({ stage: 'downloading-release', message: `Downloading ${asset.name} (${release.tag_name})...` });

      const releaseTag = release.tag_name;
      const releaseResult = await installFromPackageUrl({
        downloadUrl: asset.browser_download_url,
        buildRecord: (manifest) => ({
          extensionId: manifest.id!,
          version: manifest.version ?? '0.0.0',
          installedAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          downloadUrl: asset.browser_download_url,
          checksum: '',
          source: 'github-url',
          githubUrl,
          githubReleaseTag: releaseTag,
          githubReleaseAssetName: asset.name,
          githubInstallMethod: 'release-asset',
        }),
        logTag: 'github-release',
        progress,
      });

      if (releaseResult.success) {
        progress({
          stage: 'done',
          message: `Installed ${releaseResult.extensionId} from release ${releaseTag}`,
        });
      }
      // Hard fail: do not fall through if the release asset was present but broken.
      return releaseResult;
    }
    logger.main.info(`[ExtMarketplace] GitHub install: ${githubUrl} -- no matching asset on release ${release.tag_name}, falling back to clone-source`);
  } else {
    logger.main.info(`[ExtMarketplace] GitHub install: ${githubUrl} -- no release, falling back to clone-source`);
  }

  // ---- Path 2: clone-source fallback -------------------------------------
  progress({ stage: 'cloning', message: 'No release artifact found, cloning source...' });
  return installFromGitHubCloneSource(githubUrl, repo, subdir, progress);
}

/**
 * Clone-source install path: shallow-clone HEAD, optionally sparse-checkout
 * a subdir, validate the manifest, and require either a committed `dist/`
 * or a manifest-only extension shape.
 */
async function installFromGitHubCloneSource(
  githubUrl: string,
  repo: string,
  subdir: string | undefined,
  progress: ProgressReporter,
): Promise<InstallResult> {
  const extensionsDir = await getUserExtensionsDirectory();
  const tempDir = path.join(extensionsDir, `.tmp-${Date.now()}`);

  try {
    // Clone the repository
    if (subdir) {
      await execGit(['clone', '--depth', '1', '--filter=blob:none', '--sparse', `https://github.com/${repo}.git`, tempDir]);
      await execGit(['sparse-checkout', 'set', subdir], { cwd: tempDir });
    } else {
      await execGit(['clone', '--depth', '1', `https://github.com/${repo}.git`, tempDir]);
    }

    // Find manifest.json
    const sourceDir = subdir ? path.join(tempDir, subdir) : tempDir;
    const manifestPath = path.join(sourceDir, 'manifest.json');

    let manifestContent: string;
    try {
      manifestContent = await fs.readFile(manifestPath, 'utf-8');
    } catch {
      return { success: false, error: 'No manifest.json found in repository. Is this a Nimbalyst extension?' };
    }

    let manifest: ParsedManifest;
    try {
      manifest = JSON.parse(manifestContent);
    } catch {
      return { success: false, error: 'Invalid manifest.json - could not parse JSON' };
    }

    if (!manifest.id) {
      return { success: false, error: 'manifest.json missing required "id" field' };
    }

    const extensionId = manifest.id;
    const installPath = path.join(extensionsDir, extensionId);

    // Validate dist/ on the clone (sourceDir) BEFORE touching any existing
    // installation, so a failed install doesn't brick a working extension.
    // Theme-only / claudePlugin-only extensions have no JS to run, so dist/
    // is not required. Mirrors onlyThemes / onlyClaudePlugin in ExtensionLoader.ts.
    if (!isManifestOnlyExtension(manifest)) {
      // Auto-building is intentionally deferred (slow, error-prone, runs
      // arbitrary npm scripts), so we ask the user to publish a release
      // or build locally first.
      const distPath = path.join(sourceDir, 'dist');
      try {
        await fs.access(distPath);
      } catch {
        const pkgJsonPath = path.join(sourceDir, 'package.json');
        let hasPkgJson = false;
        try {
          await fs.access(pkgJsonPath);
          hasPkgJson = true;
        } catch {
          // No package.json either - extension might be pre-built or malformed
        }

        const message = hasPkgJson
          ? `Extension repository does not include a built dist/ directory. Either publish a GitHub Release with a .nimext asset, or commit dist/ to the repo, or clone locally and run "npm install && npm run build" before installing from the local folder.`
          : `Extension repository does not include a dist/ directory or a package.json. The repo may be malformed or built artifacts may not be committed.`;
        logger.main.info(`[ExtMarketplace] Aborting install of ${extensionId} from GitHub: ${message}`);
        return { success: false, error: message };
      }
    }

    // Validation passed -- safe to replace any existing installation.
    progress({ stage: 'installing', message: `Installing ${extensionId}...` });
    await fs.rm(installPath, { recursive: true, force: true });
    await copyDirectory(sourceDir, installPath);

    // Track the install
    addMarketplaceInstall({
      extensionId,
      version: manifest.version || '0.0.0',
      installedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      downloadUrl: '',
      checksum: '',
      source: 'github-url',
      githubUrl,
      githubInstallMethod: 'clone-source',
    });

    // Re-register file types and notify renderer (with hot-reload)
    await initializeExtensionFileTypes();
    notifyExtensionsChanged(extensionId, installPath);

    logger.main.info(`[ExtMarketplace] [github-clone] installed ${extensionId} v${manifest.version ?? '0.0.0'}`);
    progress({ stage: 'done', message: `Installed ${extensionId} from source` });
    return { success: true, extensionId };

  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    logger.main.error(`[ExtMarketplace] [github-clone] install failed:`, err);
    return { success: false, error: errorMsg };
  } finally {
    // Clean up temp directory
    try {
      await fs.rm(tempDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  }
}

/**
 * Remove the given aiProvider ids from the ai-settings store. Used when an
 * extension is uninstalled so its contributed provider entries (enabled,
 * models, testStatus...) don't linger and re-populate the Settings UI on
 * the next boot. Broadcasts `ai-settings:changed` so open renderer windows
 * refresh their atoms.
 */
async function pruneAiSettingsProviders(providerIds: string[]): Promise<void> {
  if (providerIds.length === 0) return;
  const { default: Store } = await import('electron-store');
  const aiStore = new Store<Record<string, unknown>>({ name: 'ai-settings' });
  const providerSettings = (aiStore.get('providerSettings', {}) as Record<string, unknown>) ?? {};
  const removed: string[] = [];
  for (const id of providerIds) {
    if (id in providerSettings) {
      delete providerSettings[id];
      removed.push(id);
    }
  }
  if (removed.length > 0) {
    aiStore.set('providerSettings', providerSettings);
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed() && !win.webContents.isDestroyed()) {
        win.webContents.send('ai-settings:changed', {
          providerIds: removed,
          apiKeyNames: [],
        });
      }
    }
  }
}

/**
 * Uninstall a marketplace-installed extension.
 */
async function uninstallExtension(extensionId: string): Promise<InstallResult> {
  const extensionsDir = await getUserExtensionsDirectory();
  const installPath = path.join(extensionsDir, extensionId);

  try {
    logger.main.info(`[ExtMarketplace] Uninstalling extension: ${extensionId}`);

    // Verify it's a marketplace install
    const record = getMarketplaceInstall(extensionId);
    if (!record) {
      return { success: false, error: `Extension ${extensionId} was not installed via marketplace` };
    }

    // BEFORE removing the directory, read the manifest to learn which AI
    // providers the extension contributed. We need this list to garbage-
    // collect the matching keys from ai-settings.providerSettings -- without
    // this step, the user's stored enabled/models choices persist on disk
    // forever and the renderer SettingsSidebar keeps rendering ghost provider
    // rows on the next boot even though no extension is registered.
    //
    // Read both `aiProviders` and `aiAgentProviders`. The agent-provider
    // contribution shape proposed in the Agent-Providers-as-Extensions design
    // doc uses `aiAgentProviders`, while a future chat-only contribution may
    // reuse the older `aiProviders` name. Reading both keeps the GC working
    // across the rename without a follow-up patch when either lands. An
    // extension that declares both (e.g., for a transitional period) is
    // handled idempotently downstream because the prune loop skips ids that
    // are not in providerSettings.
    let contributedAiProviderIds: string[] = [];
    try {
      const manifestPath = path.join(installPath, 'manifest.json');
      const manifestRaw = await fs.readFile(manifestPath, 'utf8');
      const manifest = JSON.parse(manifestRaw) as {
        contributions?: {
          aiProviders?: Array<{ id?: string }>;
          aiAgentProviders?: Array<{ id?: string }>;
        };
      };
      const collected = [
        ...(manifest.contributions?.aiProviders ?? []),
        ...(manifest.contributions?.aiAgentProviders ?? []),
      ];
      contributedAiProviderIds = collected
        .map((p) => p?.id)
        .filter((id): id is string => typeof id === 'string' && id.length > 0);
    } catch (err) {
      logger.main.warn(
        `[ExtMarketplace] Could not read manifest for ${extensionId} ` +
        `before uninstall; skipping ai-settings cleanup: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    // Remove the extension directory
    try {
      await fs.rm(installPath, { recursive: true, force: true });
    } catch (err) {
      logger.main.warn(`[ExtMarketplace] Could not remove extension directory: ${err}`);
    }

    // Remove from tracking
    removeMarketplaceInstall(extensionId);

    // Re-register file types and notify renderer (with unload)
    await initializeExtensionFileTypes();
    notifyExtensionUnloaded(extensionId);

    // Garbage-collect provider entries the uninstalled extension contributed
    // to ai-settings. Done AFTER notifyExtensionUnloaded so the renderer's
    // ProviderRegistry.unregister fires before the broadcast that follows.
    if (contributedAiProviderIds.length > 0) {
      try {
        await pruneAiSettingsProviders(contributedAiProviderIds);
        logger.main.info(
          `[ExtMarketplace] Pruned ${contributedAiProviderIds.length} aiProvider entry(ies) ` +
          `from ai-settings for ${extensionId}: ${contributedAiProviderIds.join(', ')}`,
        );
      } catch (err) {
        logger.main.warn(
          `[ExtMarketplace] Failed to prune ai-settings for ${extensionId}: ` +
          `${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    logger.main.info(`[ExtMarketplace] Successfully uninstalled ${extensionId}`);
    return { success: true, extensionId };

  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    logger.main.error(`[ExtMarketplace] Failed to uninstall ${extensionId}:`, err);
    return { success: false, error: errorMsg };
  }
}

/**
 * Check for available updates by comparing installed versions against registry.
 */
async function checkForUpdates(): Promise<Array<{ extensionId: string; currentVersion: string; availableVersion: string }>> {
  const registry = await fetchRegistry();
  const installs = getMarketplaceInstalls();
  const updates: Array<{ extensionId: string; currentVersion: string; availableVersion: string }> = [];

  for (const [extensionId, record] of Object.entries(installs)) {
    const registryEntry = registry.extensions.find(e => e.id === extensionId);
    if (registryEntry && registryEntry.version !== record.version) {
      // Simple string comparison for now. Could use semver later.
      updates.push({
        extensionId,
        currentVersion: record.version,
        availableVersion: registryEntry.version,
      });
    }
  }

  return updates;
}

async function migrateRenamedExtensions(registry: RegistryData): Promise<void> {
  const installs = getMarketplaceInstalls();
  const extensionsDir = await getUserExtensionsDirectory();

  for (const [legacyId, replacementId] of Object.entries(RENAMED_EXTENSION_IDS)) {
    const legacyInstallPath = path.join(extensionsDir, legacyId);
    const replacementInstallPath = path.join(extensionsDir, replacementId);
    const legacyRecord = installs[legacyId];

    let legacyInstalledOnDisk = false;
    try {
      await fs.access(legacyInstallPath);
      legacyInstalledOnDisk = true;
    } catch {
      legacyInstalledOnDisk = false;
    }

    if (!legacyInstalledOnDisk && !legacyRecord) {
      continue;
    }

    let replacementInstalledOnDisk = false;
    try {
      await fs.access(replacementInstallPath);
      replacementInstalledOnDisk = true;
    } catch {
      replacementInstalledOnDisk = false;
    }

    const replacementRecord = installs[replacementId];
    if (!replacementInstalledOnDisk && !replacementRecord) {
      const replacementEntry = registry.extensions.find((entry) => entry.id === replacementId);
      if (!replacementEntry?.downloadUrl) {
        logger.main.warn(
          `[ExtMarketplace] Cannot migrate legacy extension ${legacyId} -> ${replacementId}: replacement missing from registry`
        );
        continue;
      }

      const result = await installFromUrl(
        replacementId,
        replacementEntry.downloadUrl,
        replacementEntry.checksum,
        replacementEntry.version,
      );
      if (!result.success) {
        logger.main.warn(
          `[ExtMarketplace] Failed to migrate legacy extension ${legacyId} -> ${replacementId}: ${result.error ?? 'unknown error'}`
        );
        continue;
      }
    }

    try {
      await fs.rm(legacyInstallPath, { recursive: true, force: true });
    } catch (err) {
      logger.main.warn(`[ExtMarketplace] Failed to remove legacy extension directory ${legacyId}:`, err);
    }
    removeMarketplaceInstall(legacyId);
    await initializeExtensionFileTypes();
    notifyExtensionUnloaded(legacyId);
    logger.main.info(`[ExtMarketplace] Migrated legacy extension ${legacyId} -> ${replacementId}`);
  }
}

/**
 * Send IPC event to all renderer windows that extensions have changed.
 * If extensionId and extensionPath are provided, also triggers a hot-reload
 * so the renderer loads the new extension without requiring a page refresh.
 */
function notifyExtensionsChanged(extensionId?: string, extensionPath?: string): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) {
      win.webContents.send('extensions:list-changed');
      // Trigger renderer-side extension loading via the existing dev-reload mechanism
      if (extensionId && extensionPath) {
        win.webContents.send('extension:dev-reload', { extensionId, extensionPath });
      }
    }
  }
}

/**
 * Send IPC event to all renderer windows to unload an extension.
 */
function notifyExtensionUnloaded(extensionId: string): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) {
      win.webContents.send('extensions:list-changed');
      win.webContents.send('extension:dev-unload', { extensionId });
    }
  }
}

export function queueMarketplaceInstallRequest(extensionId: string): void {
  pendingMarketplaceInstallRequest = {
    extensionId,
    requestedAt: new Date().toISOString(),
  };

  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) {
      win.webContents.send('extension-marketplace:install-request', pendingMarketplaceInstallRequest);
    }
  }
}

/**
 * Silently check for and apply extension updates.
 * Intended to be called once on app startup (fire-and-forget).
 */
export async function runExtensionAutoUpdate(): Promise<void> {
  try {
    const registry = await fetchRegistry();
    await migrateRenamedExtensions(registry);

    const updates = await checkForUpdates();
    if (updates.length === 0) return;

    for (const update of updates) {
      const entry = registry.extensions.find(e => e.id === update.extensionId);
      if (!entry?.downloadUrl) continue;

      const result = await installFromUrl(update.extensionId, entry.downloadUrl, entry.checksum, entry.version);
      if (result.success) {
        logger.main.info(`[ExtMarketplace] Auto-updated ${update.extensionId}: ${update.currentVersion} -> ${update.availableVersion}`);
      }
    }
  } catch (err) {
    logger.main.warn('[ExtMarketplace] Auto-update check failed:', err);
  }
}

/**
 * Register all marketplace IPC handlers.
 */
export function registerExtensionMarketplaceHandlers(): void {
  // Fetch registry
  safeHandle('extension-marketplace:fetch-registry', async () => {
    try {
      const data = await fetchRegistry();
      return { success: true, data };
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      logger.main.error('[ExtMarketplace] Failed to fetch registry:', error);
      return { success: false, error: message };
    }
  });

  // Get marketplace-installed extensions
  safeHandle('extension-marketplace:get-installed', async () => {
    try {
      const installs = getMarketplaceInstalls();
      return { success: true, data: installs };
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      return { success: false, error: message };
    }
  });

  safeHandle('extension-marketplace:consume-pending-install-request', async () => {
    const request = pendingMarketplaceInstallRequest;
    pendingMarketplaceInstallRequest = null;
    return { success: true, data: request };
  });

  // Install from marketplace (download URL)
  safeHandle('extension-marketplace:install', async (_event, extensionId: string, downloadUrl: string, checksum: string, version: string) => {
    if (!extensionId) {
      return { success: false, error: 'Extension ID is required' };
    }
    return await installFromUrl(extensionId, downloadUrl, checksum, version);
  });

  // Install from GitHub URL
  safeHandle('extension-marketplace:install-from-github', async (event, githubUrl: string) => {
    if (!githubUrl) {
      return { success: false, error: 'GitHub URL is required' };
    }
    const progress: ProgressReporter = (e) => {
      const sender = event.sender;
      if (sender && !sender.isDestroyed()) {
        sender.send('extension-marketplace:install-progress', e);
      }
    };
    return await installFromGitHub(githubUrl, progress);
  });

  // Uninstall extension
  safeHandle('extension-marketplace:uninstall', async (_event, extensionId: string) => {
    if (!extensionId) {
      return { success: false, error: 'Extension ID is required' };
    }
    return await uninstallExtension(extensionId);
  });

  // Check for updates
  safeHandle('extension-marketplace:check-updates', async () => {
    try {
      const updates = await checkForUpdates();
      return { success: true, data: updates };
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      return { success: false, error: message };
    }
  });

  // Auto-update: silently update all extensions with available updates
  safeHandle('extension-marketplace:auto-update', async () => {
    try {
      const updates = await checkForUpdates();
      if (updates.length === 0) {
        return { success: true, data: { updated: [] } };
      }

      const registry = await fetchRegistry();
      const updated: Array<{ extensionId: string; fromVersion: string; toVersion: string }> = [];

      for (const update of updates) {
        const registryEntry = registry.extensions.find(e => e.id === update.extensionId);
        if (!registryEntry || !registryEntry.downloadUrl) continue;

        const result = await installFromUrl(
          update.extensionId,
          registryEntry.downloadUrl,
          registryEntry.checksum,
          registryEntry.version,
        );

        if (result.success) {
          updated.push({
            extensionId: update.extensionId,
            fromVersion: update.currentVersion,
            toVersion: update.availableVersion,
          });
        }
      }

      if (updated.length > 0) {
        logger.main.info(`[ExtMarketplace] Auto-updated ${updated.length} extensions`);
      }

      return { success: true, data: { updated } };
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      logger.main.error('[ExtMarketplace] Auto-update failed:', error);
      return { success: false, error: message };
    }
  });

  // Clear cache
  safeHandle('extension-marketplace:clear-cache', async () => {
    registryCache = null;
    registryCacheTimestamp = 0;
    return { success: true };
  });
}

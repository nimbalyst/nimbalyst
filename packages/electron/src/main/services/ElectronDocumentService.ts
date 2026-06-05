import { BrowserWindow, type IpcMainEvent, type IpcMainInvokeEvent, app, shell } from 'electron';
import { safeHandle, safeOn } from '../utils/ipcRegistry';
import * as fs from 'fs/promises';
import * as path from 'path';
import {
  Document,
  DocumentService,
  DocumentOpenOptions,
  DocumentMetadataEntry,
  MetadataChangeEvent,
  TrackerItem,
  TrackerItemChangeEvent,
  TrackerItemType
} from '@nimbalyst/runtime';
import crypto from 'crypto';
import { getCurrentIdentity } from './TrackerIdentityService';
import { extractFrontmatter, extractCommonFields } from '../utils/frontmatterReader';
import { VIRTUAL_DOCS, isVirtualPath } from '@nimbalyst/runtime';
import {
  updateTrackerInFrontmatter,
  updateInlineTrackerItem,
  removeInlineTrackerItem,
  EXTENSION_OWNED_KEYS,
  LEGACY_KEY_TO_TYPE,
  buildFullDocumentTrackerId,
  parseFullDocumentTrackerId,
} from '@nimbalyst/runtime/plugins/TrackerPlugin/documentHeader/frontmatterUtils';
import { database } from '../database/PGLiteDatabaseWorker';
import { shouldExcludeDir } from '../utils/fileFilters';
import { getRegisteredExtensions } from '../extensions/RegisteredFileTypes';
import { isPathInWorkspace, getRelativeWorkspacePath } from '../utils/workspaceDetection';
import { syncTrackerItem, unsyncTrackerItem, isTrackerSyncActive } from './TrackerSyncManager';
import {
  getEffectiveTrackerSyncPolicy,
  getInitialTrackerSyncStatus,
  shouldSyncTrackerPolicy,
} from './TrackerPolicyService';

export interface ParsedInlineTrackerCandidate extends Omit<TrackerItem, 'id'> {
  id?: string;
  explicitId: boolean;
}

interface ExistingInlineTrackerRow {
  id: string;
  type: string;
  line_number?: number | null;
  title?: string | null;
}

interface ResolvedFullDocumentFrontmatter {
  trackerType: string;
  trackerData: Record<string, any>;
}

function resolveFullDocumentFrontmatter(
  frontmatter: Record<string, any> | undefined,
): ResolvedFullDocumentFrontmatter | null {
  if (!frontmatter) return null;

  for (const [extKey, extType] of Object.entries(EXTENSION_OWNED_KEYS)) {
    if (frontmatter[extKey] && typeof frontmatter[extKey] === 'object') {
      const extData = frontmatter[extKey] as Record<string, any>;
      const { [extKey]: _ext, trackerStatus: _ts, ...topLevel } = frontmatter;
      return {
        trackerType: extType,
        trackerData: { ...topLevel, ...extData },
      };
    }
  }

  if (frontmatter.trackerStatus && typeof frontmatter.trackerStatus === 'object') {
    const trackerStatus = frontmatter.trackerStatus as Record<string, any>;
    const trackerType = typeof trackerStatus.type === 'string' && trackerStatus.type.trim().length > 0
      ? trackerStatus.type.trim()
      : 'plan';
    const { trackerStatus: _ts, ...topLevel } = frontmatter;
    return {
      trackerType,
      trackerData: { ...trackerStatus, ...topLevel },
    };
  }

  for (const [legacyKey, legacyType] of Object.entries(LEGACY_KEY_TO_TYPE)) {
    if (frontmatter[legacyKey] && typeof frontmatter[legacyKey] === 'object') {
      const legacyData = frontmatter[legacyKey] as Record<string, any>;
      const { [legacyKey]: _legacy, trackerStatus: _ts, ...topLevel } = frontmatter;
      return {
        trackerType: legacyType,
        trackerData: { ...legacyData, ...topLevel },
      };
    }
  }

  return null;
}

export function getCanonicalTrackerItemIdFromRow(row: { id: string; type: string; source?: string | null; source_ref?: string | null }): string {
  if (row.source === 'frontmatter' && typeof row.source_ref === 'string' && row.source_ref.length > 0) {
    return buildFullDocumentTrackerId(row.type, row.source_ref);
  }
  return row.id;
}

/**
 * Parse a column value that may be either a parsed object/array (PGLite
 * JSONB / TEXT[] semantics) or a JSON-encoded string (SQLite TEXT
 * semantics). Returns the parsed shape, or undefined on null/parse error.
 */
function parseJsonColumn<T>(value: unknown): T | undefined {
  if (value === null || value === undefined) return undefined;
  if (typeof value !== 'string') return value as T;
  try {
    return JSON.parse(value) as T;
  } catch {
    return undefined;
  }
}

function normalizeTrackerTitle(title: string | undefined): string {
  return (title || '').trim().replace(/\s+/g, ' ').toLowerCase();
}

export function computeDeterministicInlineTrackerId(
  relativePath: string,
  type: string,
  lineNumber: number | undefined,
  title: string,
): string {
  const hash = crypto
    .createHash('sha1')
    .update(`${relativePath}\n${type}\n${lineNumber ?? 0}\n${normalizeTrackerTitle(title)}`)
    .digest('hex')
    .slice(0, 12);
  return `${type}_${hash}`;
}

export function resolveInlineTrackerIds(
  candidates: ParsedInlineTrackerCandidate[],
  existingRows: ExistingInlineTrackerRow[],
  relativePath: string,
): TrackerItem[] {
  const unmatchedExisting = [...existingRows];
  const candidateTitleCounts = new Map<string, number>();
  const existingTitleCounts = new Map<string, number>();

  for (const candidate of candidates) {
    const key = `${candidate.type}::${normalizeTrackerTitle(candidate.title)}`;
    candidateTitleCounts.set(key, (candidateTitleCounts.get(key) ?? 0) + 1);
  }

  for (const row of existingRows) {
    const key = `${row.type}::${normalizeTrackerTitle(row.title ?? undefined)}`;
    existingTitleCounts.set(key, (existingTitleCounts.get(key) ?? 0) + 1);
  }

  function takeMatch(
    predicate: (row: ExistingInlineTrackerRow) => boolean,
  ): ExistingInlineTrackerRow | null {
    const index = unmatchedExisting.findIndex(predicate);
    if (index === -1) return null;
    const [row] = unmatchedExisting.splice(index, 1);
    return row;
  }

  return candidates.map((candidate) => {
    if (candidate.explicitId && candidate.id) {
      takeMatch((row) => row.id === candidate.id);
      return { ...candidate, id: candidate.id };
    }

    const normalizedTitle = normalizeTrackerTitle(candidate.title);
    const titleKey = `${candidate.type}::${normalizedTitle}`;

    const exactLineMatch = takeMatch((row) =>
      row.type === candidate.type &&
      (row.line_number ?? null) === (candidate.lineNumber ?? null)
    );

    if (exactLineMatch) {
      return { ...candidate, id: exactLineMatch.id };
    }

    const canUseTitleMatch =
      (candidateTitleCounts.get(titleKey) ?? 0) === 1 &&
      (existingTitleCounts.get(titleKey) ?? 0) === 1;
    const titleMatch = canUseTitleMatch
      ? takeMatch((row) =>
          row.type === candidate.type &&
          normalizeTrackerTitle(row.title ?? undefined) === normalizedTitle
        )
      : null;

    if (titleMatch) {
      return { ...candidate, id: titleMatch.id };
    }

    let nearestIndex = -1;
    let nearestDistance = Number.POSITIVE_INFINITY;
    for (let i = 0; i < unmatchedExisting.length; i++) {
      const row = unmatchedExisting[i];
      if (row.type !== candidate.type) continue;
      if (candidate.lineNumber == null || row.line_number == null) continue;
      const distance = Math.abs(row.line_number - candidate.lineNumber);
      if (distance < nearestDistance) {
        nearestDistance = distance;
        nearestIndex = i;
      }
    }

    if (nearestIndex !== -1 && nearestDistance <= 3) {
      const [nearest] = unmatchedExisting.splice(nearestIndex, 1);
      return { ...candidate, id: nearest.id };
    }

    return {
      ...candidate,
      id: computeDeterministicInlineTrackerId(
        relativePath,
        candidate.type,
        candidate.lineNumber,
        candidate.title,
      ),
    };
  });
}

export class ElectronDocumentService implements DocumentService {
  private workspacePath: string;
  private documents: Document[] = [];
  private watchers: Map<string, (documents: Document[]) => void> = new Map();
  private watchInterval: NodeJS.Timeout | null = null;

  // Metadata cache
  private metadataCache: Map<string, DocumentMetadataEntry> = new Map();
  private metadataByPath: Map<string, DocumentMetadataEntry> = new Map();
  private metadataWatchers: Map<string, (change: MetadataChangeEvent) => void> = new Map();
  private fileStateCache: Map<string, { mtime: number; size: number; hash?: string }> = new Map();
  private initializationPromise: Promise<void> | null = null;

  // Tracker items cache
  private trackerItemWatchers: Map<string, (change: TrackerItemChangeEvent) => void> = new Map();

  // Performance limits - balance between completeness and performance
  private static readonly MAX_FILES_TO_SCAN = 2000;   // Stop adding regular files after 2000
  private static readonly MAX_SCAN_TIME_MS = 10000;   // Stop scanning after 10 seconds (increased to allow full scan)
  private static readonly MAX_DEPTH = 8;              // Maximum directory depth

  private isScanning = false; // Prevent concurrent scans

  /**
   * Quick check if a markdown file contains tracker-relevant frontmatter
   * This reads only the first ~4KB of the file for performance
   */
  private async hasTrackerFrontmatter(fullPath: string): Promise<boolean> {
    try {
      const fh = await fs.open(fullPath, 'r');
      try {
        const buffer = Buffer.alloc(4096);
        const { bytesRead } = await fh.read(buffer, 0, 4096, 0);
        const content = buffer.toString('utf-8', 0, bytesRead);

        // Check for YAML frontmatter with tracker content
        // Look for planStatus:, decisionStatus:, automationStatus:, trackerStatus:,
        // or inline tracker items like #bug[, #task[, etc.
        const hasTrackerFrontmatter = /^---[\s\S]*?(planStatus|decisionStatus|automationStatus|trackerStatus):/m.test(content);
        const hasInlineTracker = /#([a-z][\w-]*)\[/.test(content);

        return hasTrackerFrontmatter || hasInlineTracker;
      } finally {
        await fh.close();
      }
    } catch {
      return false;
    }
  }

  constructor(workspacePath: string) {
    this.workspacePath = workspacePath;

    // console.log(`[DocumentService] Constructor called for workspace: ${workspacePath}`);
    // console.log(`[DocumentService] SKIPPING initial scan - scan will happen on-demand only`);

    // DON'T scan on startup - it freezes the app for large projects.
    // Metadata initialization runs lazily when metadata APIs are first called.
    this.initializationPromise = null;

    // Disable automatic background scanning - only scan on-demand
    // Background scanning was causing performance issues with large projects
    // Documents will be scanned when listDocuments() is called (e.g., when @ mention is triggered)
  }

  private async initializeAsync(): Promise<void> {
    try {
      // Perform initial document scan and metadata extraction
      await this.refreshDocuments();
      // console.log(`[DocumentService] Initial metadata cache loaded: ${this.metadataCache.size} documents`);
      // console.log('[DocumentService] Sample metadata:', Array.from(this.metadataCache.values()).slice(0, 3).map(m => ({
      //   path: m.path,
      //   hasFrontmatter: Object.keys(m.frontmatter).length > 0,
      //   frontmatterKeys: Object.keys(m.frontmatter)
      // })));
    } catch (error) {
      console.error('[DocumentService] Failed to initialize metadata cache:', error);
    }
  }

  private async ensureInitialized(): Promise<void> {
    if (!this.initializationPromise) {
      this.initializationPromise = this.initializeAsync();
    }
    await this.initializationPromise;
  }

  /**
   * Start the background scan if not already started, but don't block on it.
   * Callers that can tolerate stale/empty data should use this instead of ensureInitialized().
   */
  private startScanIfNeeded(): void {
    if (!this.initializationPromise) {
      this.initializationPromise = this.initializeAsync();
    }
  }

  // Public method to trigger a full refresh (for tracker panel initialization, etc.)
  async refreshWorkspaceData() {
    if (!this.initializationPromise) {
      this.initializationPromise = this.refreshDocuments();
      await this.initializationPromise;
    } else {
      await this.refreshDocuments();
    }
  }

  private async refreshDocuments() {
    // Prevent concurrent scans
    if (this.isScanning) {
      return;
    }

    this.isScanning = true;
    try {
      const oldDocuments = this.documents;
      this.documents = await this.scanDocuments();

      // console.log(`[DocumentService] refreshDocuments: found ${this.documents.length} documents`);
      // if (this.documents.length > 0) {
      //   console.log(`[DocumentService] Sample documents:`, this.documents.slice(0, 3).map(d => d.path));
      // }

      // Update metadata cache
      await this.updateMetadataCache(oldDocuments, this.documents);

      // Only notify watchers if the document list actually changed
      if (this.hasDocumentListChanged(oldDocuments, this.documents)) {
        this.watchers.forEach(callback => callback(this.documents));
      }
    } finally {
      this.isScanning = false;
    }
  }

  private hasDocumentListChanged(oldDocs: Document[], newDocs: Document[]): boolean {
    if (oldDocs.length !== newDocs.length) return true;

    // Create a Set of document IDs for fast lookup
    const oldIds = new Set(oldDocs.map(d => d.id));
    const newIds = new Set(newDocs.map(d => d.id));

    // Check if any documents were added or removed
    if (oldIds.size !== newIds.size) return true;

    for (const id of newIds) {
      if (!oldIds.has(id)) return true;
    }

    return false;
  }

  private async updateMetadataCache(oldDocs: Document[], newDocs: Document[]) {
    const added: DocumentMetadataEntry[] = [];
    const updated: DocumentMetadataEntry[] = [];
    const removed: string[] = [];

    // Create maps for easier lookup
    const oldDocsMap = new Map(oldDocs.map(d => [d.id, d]));
    const newDocsMap = new Map(newDocs.map(d => [d.id, d]));

    // Check for removed documents
    for (const oldDoc of oldDocs) {
      if (!newDocsMap.has(oldDoc.id)) {
        removed.push(oldDoc.id);
        this.metadataCache.delete(oldDoc.id);
        this.metadataByPath.delete(oldDoc.path);
        this.fileStateCache.delete(oldDoc.path);
      }
    }

    // Check for added or updated documents
    for (const newDoc of newDocs) {
      const oldDoc = oldDocsMap.get(newDoc.id);
      const fullPath = path.join(this.workspacePath, newDoc.path);

      // Get current file state
      const stats = newDoc.lastModified ? { mtime: newDoc.lastModified.getTime(), size: 0 } : null;

      if (!stats) continue;

      const cachedState = this.fileStateCache.get(newDoc.path);
      const needsUpdate = !oldDoc || !cachedState ||
                         cachedState.mtime !== stats.mtime;

      if (needsUpdate) {
        // Skip directories - they don't have frontmatter
        if (newDoc.type === 'directory') {
          continue;
        }

        // TODO: Debug logging - uncomment if needed for troubleshooting
        // console.log(`[DocumentService] File needs update: ${newDoc.path} (oldDoc=${!!oldDoc}, cachedState=${!!cachedState}, mtimeChanged=${cachedState?.mtime !== stats.mtime})`);
        try {
          // Extract frontmatter
          // TODO: Debug logging - uncomment if needed for troubleshooting
          // console.log(`[DocumentService] Extracting frontmatter from: ${fullPath}`);
          const { data, hash, parseErrors } = await extractFrontmatter(fullPath);

          if (parseErrors) {
            console.warn(`[DocumentService] Parse errors for ${newDoc.path}:`, parseErrors);
          }

          // Debug: Log what we extracted for plan files
          if (newDoc.path.includes('plan')) {
            // console.log(`[DocumentService] Extracted data for ${newDoc.path}:`, data ? Object.keys(data) : 'null');
            if (data && data.planStatus) {
              // console.log(`[DocumentService] Found planStatus:`, data.planStatus);
            }
          }

          // Check if frontmatter actually changed
          if (!cachedState || cachedState.hash !== hash) {
            const commonFields = data ? extractCommonFields(data) : {};

            const metadata: DocumentMetadataEntry = {
              id: newDoc.id,
              path: newDoc.path,
              workspace: newDoc.workspace,
              frontmatter: data || {},
              summary: commonFields.summary,
              tags: commonFields.tags,
              lastModified: newDoc.lastModified || new Date(),
              lastIndexed: new Date(),
              hash: hash || undefined,
              parseErrors
            };

            // Update caches
            this.metadataCache.set(newDoc.id, metadata);
            this.metadataByPath.set(newDoc.path, metadata);
            this.fileStateCache.set(newDoc.path, {
              mtime: stats.mtime,
              size: stats.size || 0,
              hash: hash || undefined
            });

            if (!oldDoc) {
              added.push(metadata);
            } else {
              updated.push(metadata);
            }
          } else {
            // Frontmatter didn't change, but file mtime did - update mtime in cache
            this.fileStateCache.set(newDoc.path, {
              mtime: stats.mtime,
              size: stats.size || 0,
              hash: hash || undefined
            });
          }

          // Update tracker items cache whenever file content changes (mtime changed)
          // This only runs for files that actually changed, not all files
          await this.updateTrackerItemsCache(newDoc.path);
        } catch (error) {
          console.error(`[DocumentService] Failed to extract metadata for ${newDoc.path}:`, error);
        }
      } else {
        // console.log(`[DocumentService] Skipping file (no update needed): ${newDoc.path}`);
      }
    }

    // Notify metadata watchers if there are changes
    if (added.length > 0 || updated.length > 0 || removed.length > 0) {
      const changeEvent: MetadataChangeEvent = {
        added,
        updated,
        removed,
        timestamp: new Date()
      };

      this.metadataWatchers.forEach(callback => callback(changeEvent));
    }
  }

  // Number of fs operations between event loop yields during async scan
  private static readonly YIELD_INTERVAL = 100;

  private async scanDirectoryAsync(
    dirPath: string,
    basePath: string = '',
    depth: number = 0,
    scanState: { count: number; trackerCount: number; startTime: number; stopped: boolean; sinceYield: number }
  ): Promise<Document[]> {
    const documents: Document[] = [];

    // Check time limit BEFORE scanning this directory
    if (scanState.stopped) {
      return documents;
    }

    const elapsed = Date.now() - scanState.startTime;
    if (elapsed > ElectronDocumentService.MAX_SCAN_TIME_MS) {
      scanState.stopped = true;
      return documents;
    }

    if (depth > ElectronDocumentService.MAX_DEPTH) {
      return documents;
    }

    // Support all common text-based file types for @ mentions
    const supportedExtensions = [
      // Markdown
      '.md', '.markdown',
      // Web
      '.html', '.htm', '.css', '.scss', '.sass', '.less',
      // JavaScript/TypeScript
      '.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs',
      // Other programming languages
      '.py', '.rb', '.php', '.java', '.c', '.cpp', '.cc', '.h', '.hpp',
      '.cs', '.go', '.rs', '.swift', '.kt', '.scala', '.r',
      // Scripting and config
      '.sh', '.bash', '.zsh', '.fish', '.ps1',
      '.json', '.yaml', '.yml', '.toml', '.ini', '.cfg', '.conf',
      '.xml', '.graphql', '.proto',
      // Documentation
      '.txt', '.rst', '.adoc', '.tex',
      // SQL
      '.sql',
      // Other
      '.vue', '.svelte', '.astro'
    ];

    // Extension-contributed file types. Extensions declare these via
    // `contributions.customEditors[].filePatterns` in their manifest, and
    // `initializeExtensionFileTypes` populates the central registry at
    // boot. Merge them in here so files like `*.excalidraw`, `*.mockup.html`,
    // `*.mindmap` etc. show up in the `@` typeahead without anyone editing
    // this file.
    const extensionContributedExtensions = Array.from(getRegisteredExtensions());
    const supportedExtensionsSet = new Set<string>([
      ...supportedExtensions,
      ...extensionContributedExtensions,
    ]);

    // Markdown extensions for tracker content check
    const markdownExtensions = ['.md', '.markdown'];

    try {
      const items = await fs.readdir(dirPath);

      for (const item of items) {
        // Check time limit on EVERY iteration to bail out quickly
        if (Date.now() - scanState.startTime > ElectronDocumentService.MAX_SCAN_TIME_MS) {
          scanState.stopped = true;
          break;
        }

        if (scanState.stopped) {
          break;
        }

        // Skip .DS_Store
        if (item === '.DS_Store') {
          continue;
        }

        const fullPath = path.join(dirPath, item);
        const relativePath = basePath ? path.join(basePath, item) : item;

        try {
          // Yield the event loop periodically so IPC responses aren't starved
          scanState.sinceYield++;
          if (scanState.sinceYield >= ElectronDocumentService.YIELD_INTERVAL) {
            scanState.sinceYield = 0;
            await new Promise<void>(resolve => setImmediate(resolve));
          }

          const stats = await fs.stat(fullPath);

          if (stats.isDirectory()) {
            // Use centralized directory exclusion logic (worktrees, node_modules, .git, etc.)
            if (shouldExcludeDir(item)) {
              continue;
            }
            // Add directory as a mentionable document for @ mentions
            const dirId = crypto.createHash('md5').update(relativePath + '/').digest('hex');
            documents.push({
              id: dirId,
              name: item,
              path: relativePath,
              workspace: undefined,
              lastModified: stats.mtime,
              type: 'directory'
            });
            // Recursively scan subdirectories with incremented depth
            const subDocs = await this.scanDirectoryAsync(fullPath, relativePath, depth + 1, scanState);
            documents.push(...subDocs);
          } else if (stats.isFile()) {
            const ext = path.extname(item).toLowerCase();
            if (supportedExtensionsSet.has(ext)) {
              const isMarkdown = markdownExtensions.includes(ext);
              const underLimit = scanState.count < ElectronDocumentService.MAX_FILES_TO_SCAN;

              // Determine if we should add this file:
              // - Always add if under the limit
              // - For markdown files above the limit, check if they have tracker frontmatter
              let shouldAdd = underLimit;
              if (!underLimit && isMarkdown) {
                shouldAdd = await this.hasTrackerFrontmatter(fullPath);
                if (shouldAdd) {
                  scanState.trackerCount++;
                }
              }

              if (shouldAdd) {
                scanState.count++;

                const id = crypto.createHash('md5').update(relativePath).digest('hex');

                documents.push({
                  id,
                  name: item,
                  path: relativePath,
                  workspace: basePath || undefined,
                  lastModified: stats.mtime,
                  type: ext.slice(1)
                });
              }
            }
          }
        } catch (error) {
          // Skip files/dirs we can't stat (permissions, broken symlinks, etc.)
        }
      }
    } catch (error) {
      // Silent - directory scanning errors are not critical
    }

    return documents;
  }

  private async scanDocuments(): Promise<Document[]> {
    try {
      const scanState = { count: 0, trackerCount: 0, startTime: Date.now(), stopped: false, sinceYield: 0 };
      const docs = await this.scanDirectoryAsync(this.workspacePath, '', 0, scanState);

      // Log info about scan results
      const elapsed = Date.now() - scanState.startTime;
      if (scanState.stopped) {
        console.warn(
          `[DocumentService] Scan stopped early: scanned ${scanState.count} files in ${elapsed}ms. ` +
          `Time limit: ${ElectronDocumentService.MAX_SCAN_TIME_MS}ms, depth limit: ${ElectronDocumentService.MAX_DEPTH}. ` +
          `Some files may not appear in @ mentions.`
        );
      } else if (scanState.trackerCount > 0) {
        // console.log(
        //   `[DocumentService] Scan complete: ${scanState.count} files in ${elapsed}ms ` +
        //   `(${scanState.trackerCount} tracker files found beyond ${ElectronDocumentService.MAX_FILES_TO_SCAN} file limit)`
        // );
      }

      return docs;
    } catch (err) {
      // Silent - document scanning errors are not critical
      console.error('[DocumentService] Scan error:', err);
      return [];
    }
  }

  private lastScanTime = 0;
  private readonly SCAN_CACHE_MS = 30000; // Only rescan every 30 seconds max

  async listDocuments(): Promise<Document[]> {
    const now = Date.now();
    const timeSinceLastScan = now - this.lastScanTime;

    // Only scan if we have no documents OR it's been > 30 seconds since last scan
    if (this.documents.length === 0 || timeSinceLastScan > this.SCAN_CACHE_MS) {
      // Debug logging - comment out for production
      // console.log('[DocumentService] Scanning workspace (cache expired or empty)...');
      this.documents = await this.scanDocuments();
      this.lastScanTime = now;
      // console.log(`[DocumentService] Scan complete: found ${this.documents.length} documents`);
    } else {
      // Debug logging - comment out for production
      // console.log(`[DocumentService] Using cached documents: ${this.documents.length} (scanned ${Math.round(timeSinceLastScan/1000)}s ago)`);
    }
    return this.documents;
  }

  async searchDocuments(query: string): Promise<Document[]> {
    const documents = await this.listDocuments();
    const lowerQuery = query.toLowerCase();

    // Debug logging - comment out for production
    // console.log(`[DocumentService] searchDocuments: query="${query}", total docs=${documents.length}`);

    const results = documents.filter(doc =>
      doc.name.toLowerCase().includes(lowerQuery) ||
      doc.path.toLowerCase().includes(lowerQuery) ||
      (doc.workspace && doc.workspace.toLowerCase().includes(lowerQuery))
    );

    // Debug logging - comment out for production
    // console.log(`[DocumentService] searchDocuments: found ${results.length} matching documents`);
    return results;
  }

  async getDocument(id: string): Promise<Document | null> {
    const documents = await this.listDocuments();
    return documents.find(doc => doc.id === id) || null;
  }

  async getDocumentByPath(path: string): Promise<Document | null> {
    const documents = await this.listDocuments();
    return documents.find(doc => doc.path === path) || null;
  }

  watchDocuments(callback: (documents: Document[]) => void): () => void {
    const id = Date.now().toString();
    this.watchers.set(id, callback);

    // Send initial documents
    callback(this.documents);

    // Return unsubscribe function
    return () => {
      this.watchers.delete(id);
    };
  }

  async openDocument(documentId: string, fallback?: DocumentOpenOptions): Promise<void> {
    let doc: Document | null = null;

    if (documentId) {
      doc = await this.getDocument(documentId);
    }

    if (!doc && fallback?.path) {
      doc = await this.getDocumentByPath(fallback.path);
    }

    if (!doc && fallback?.name) {
      const documents = await this.listDocuments();
      doc =
        documents.find(d => d.name === fallback.name) ||
        documents.find(d => d.path.split(/[\\/]/).pop() === fallback.name) ||
        null;
    }

    if (!doc) {
      throw new Error(
        `Document not found (id=${documentId || 'n/a'}, path=${fallback?.path ?? 'n/a'}, name=${fallback?.name ?? 'n/a'})`
      );
    }

    // Send message to renderer to open the document
    const window = BrowserWindow.getFocusedWindow();
    if (window) {
      window.webContents.send('open-document', {
        path: path.join(this.workspacePath, doc.path)
      });
    }
  }

  // Metadata API methods
  async getDocumentMetadata(id: string): Promise<DocumentMetadataEntry | null> {
    await this.ensureInitialized();
    return this.metadataCache.get(id) || null;
  }

  async getDocumentMetadataByPath(path: string): Promise<DocumentMetadataEntry | null> {
    await this.ensureInitialized();
    return this.metadataByPath.get(path) || null;
  }

  /**
   * Returns cached metadata immediately without blocking on the scan.
   * On first call this may return an empty array. Callers that need
   * complete data must also subscribe via watchDocumentMetadata().
   */
  async listDocumentMetadata(): Promise<DocumentMetadataEntry[]> {
    this.startScanIfNeeded();
    return Array.from(this.metadataCache.values());
  }

  watchDocumentMetadata(listener: (change: MetadataChangeEvent) => void): () => void {
    const id = Date.now().toString();
    this.metadataWatchers.set(id, listener);

    // Return unsubscribe function
    return () => {
      this.metadataWatchers.delete(id);
    };
  }

  notifyFrontmatterChanged(path: string, frontmatter: Record<string, unknown>): void {
    const metadata = this.metadataByPath.get(path);
    if (!metadata) return;

    // Generate new hash - sort keys recursively for consistent hashing
    const sortedData = JSON.parse(JSON.stringify(frontmatter, (key, value) => {
      if (value && typeof value === 'object' && !Array.isArray(value)) {
        return Object.keys(value).sort().reduce((sorted, key) => {
          sorted[key] = value[key];
          return sorted;
        }, {} as Record<string, any>);
      }
      return value;
    }));
    const dataString = JSON.stringify(sortedData);
    const hash = crypto.createHash('sha256').update(dataString).digest('hex');

    // Check if frontmatter actually changed
    if (metadata.hash === hash) return;

    // Extract common fields
    const commonFields = extractCommonFields(frontmatter);

    // Update metadata
    const updatedMetadata: DocumentMetadataEntry = {
      ...metadata,
      frontmatter,
      summary: commonFields.summary,
      tags: commonFields.tags,
      lastIndexed: new Date(),
      hash
    };

    // Update caches
    this.metadataCache.set(metadata.id, updatedMetadata);
    this.metadataByPath.set(path, updatedMetadata);

    // Update file state cache
    const cachedState = this.fileStateCache.get(path);
    if (cachedState) {
      cachedState.hash = hash;
    }

    // Notify watchers
    const changeEvent: MetadataChangeEvent = {
      added: [],
      updated: [updatedMetadata],
      removed: [],
      timestamp: new Date()
    };

    this.metadataWatchers.forEach(callback => callback(changeEvent));
  }

  async refreshFileMetadata(filePath: string): Promise<void> {
    await this.ensureInitialized();

    // Convert to relative path if absolute
    // Use proper path boundary checking to avoid matching snake_worktrees when workspace is snake
    const relativeFromWorkspace = getRelativeWorkspacePath(filePath, this.workspacePath);
    const relativePath = relativeFromWorkspace !== null ? relativeFromWorkspace : filePath;

    // Only process markdown files
    if (!relativePath.endsWith('.md')) {
      return;
    }

    const fullPath = path.join(this.workspacePath, relativePath);

    try {
      const stats = await fs.stat(fullPath);
      const { data, hash, parseErrors } = await extractFrontmatter(fullPath);

      if (parseErrors) {
        console.warn(`[DocumentService] Parse errors for ${relativePath}:`, parseErrors);
      }

      const cachedState = this.fileStateCache.get(relativePath);

      // Always update if hash changed or no cache exists
      if (!cachedState || cachedState.hash !== hash) {
        const commonFields = data ? extractCommonFields(data) : {};

        // Find the document entry, or create one if it doesn't exist
        // (this can happen for files beyond the scan limit or newly created files)
        let doc = this.documents.find(d => d.path === relativePath);
        if (!doc) {
          // Create a document entry for this file
          const fileName = path.basename(relativePath);
          const ext = path.extname(fileName).toLowerCase();
          const id = crypto.createHash('md5').update(relativePath).digest('hex');

          const dirname = path.dirname(relativePath);
          doc = {
            id,
            name: fileName,
            path: relativePath,
            workspace: dirname && dirname !== '.' ? dirname : undefined,
            lastModified: stats.mtime,
            type: ext.slice(1)
          };

          // Add to documents list so future lookups work
          this.documents.push(doc);
          // console.log(`[DocumentService] Added document entry for agent-edited file: ${relativePath}`);
        }

        const metadata: DocumentMetadataEntry = {
          id: doc.id,
          path: relativePath,
          workspace: doc.workspace,
          frontmatter: data || {},
          summary: commonFields.summary,
          tags: commonFields.tags,
          lastModified: new Date(stats.mtime),
          lastIndexed: new Date(),
          hash: hash || undefined,
          parseErrors
        };

        // Update caches
        this.metadataCache.set(doc.id, metadata);
        this.metadataByPath.set(relativePath, metadata);
        this.fileStateCache.set(relativePath, {
          mtime: stats.mtimeMs,
          size: stats.size,
          hash: hash || undefined
        });

        // Notify watchers
        const changeEvent: MetadataChangeEvent = {
          added: [],
          updated: [metadata],
          removed: [],
          timestamp: new Date()
        };

        this.metadataWatchers.forEach(callback => callback(changeEvent));
      }

      // Also update tracker items for markdown files
      // This ensures inline tracker items (#bug, #task, etc.) are kept in sync
      await this.updateTrackerItemsCache(relativePath);
    } catch (error) {
      console.error(`[DocumentService] Failed to refresh metadata for ${relativePath}:`, error);
    }
  }

  /**
   * Load a virtual document by its path
   */
  async loadVirtualDocument(virtualPath: string): Promise<string | null> {
    if (!isVirtualPath(virtualPath)) {
      return null;
    }

    // Find the virtual document descriptor. Only built-in virtual docs (welcome,
    // tracker views, etc.) have loadable text content here. Extension-owned
    // virtual tabs (e.g. `virtual://com.nimbalyst.browser/…`) are rendered by
    // their custom editor and have no content to load, so a miss is expected --
    // return null quietly rather than logging an error on every such tab open.
    const virtualDoc = Object.values(VIRTUAL_DOCS).find(doc => doc.virtualPath === virtualPath);
    if (!virtualDoc) {
      return null;
    }

    try {
      // Determine asset path - in development use source path, in production use app resources
      let assetPath: string;
      if (app.isPackaged) {
        assetPath = path.join(process.resourcesPath, virtualDoc.assetPath);
      } else {
        // In development, use app.getAppPath() to get the package root reliably
        // (can't use __dirname because bundled chunks may be in nested directories)
        assetPath = path.join(app.getAppPath(), virtualDoc.assetPath);
      }

      // console.log('[DocumentService] Loading virtual document:', {
      //   virtualPath,
      //   assetPath,
      //   __dirname,
      //   exists: await fs.access(assetPath).then(() => true).catch(() => false)
      // });

      const content = await fs.readFile(assetPath, 'utf-8');
      return content;
    } catch (error) {
      console.error(`[DocumentService] Failed to load virtual document ${virtualPath}:`, error);
      return null;
    }
  }

  private async listFullDocumentTrackerItemsFromMetadata(): Promise<TrackerItem[]> {
    this.startScanIfNeeded();

    const { globalRegistry } = await import('@nimbalyst/runtime/plugins/TrackerPlugin/models/TrackerDataModel');
    const items: TrackerItem[] = [];

    for (const metadata of this.metadataCache.values()) {
      const pathLower = metadata.path.toLowerCase();
      if (pathLower.includes('/agents/') || pathLower.includes('\\agents\\')) {
        continue;
      }

      const resolved = resolveFullDocumentFrontmatter(metadata.frontmatter);
      if (!resolved) continue;

      const model = globalRegistry.get(resolved.trackerType);
      if (!model?.modes?.fullDocument) continue;

      const trackerData = resolved.trackerData;
      const title = (trackerData.title as string)
        || (metadata.frontmatter.title as string)
        || metadata.path.split('/').pop()?.replace(/\.md$/, '')
        || 'Untitled';

      const coreFieldKeys = new Set([
        'type', 'title', 'status', 'priority', 'owner', 'tags', 'created',
        'updated', 'dueDate', 'progress', 'description',
      ]);
      const customFields: Record<string, any> = {};
      for (const [key, value] of Object.entries(trackerData)) {
        if (!coreFieldKeys.has(key) && value !== undefined) {
          customFields[key] = value;
        }
      }

      items.push({
        id: buildFullDocumentTrackerId(resolved.trackerType, metadata.path),
        type: resolved.trackerType as TrackerItemType,
        typeTags: [resolved.trackerType],
        title,
        description: trackerData.description || undefined,
        status: ((trackerData.status || metadata.frontmatter.status || 'to-do') as string).toLowerCase() as TrackerItem['status'],
        priority: (trackerData.priority || metadata.frontmatter.priority || 'medium') as TrackerItem['priority'],
        owner: trackerData.owner || undefined,
        module: metadata.path,
        lineNumber: 0,
        workspace: this.workspacePath,
        tags: Array.isArray(trackerData.tags) ? trackerData.tags : undefined,
        created: trackerData.created ? String(trackerData.created) : undefined,
        updated: trackerData.updated ? String(trackerData.updated) : undefined,
        dueDate: trackerData.dueDate ? String(trackerData.dueDate) : undefined,
        progress: typeof trackerData.progress === 'number' ? trackerData.progress : undefined,
        lastIndexed: metadata.lastModified || metadata.lastIndexed || new Date(),
        archived: false,
        source: 'frontmatter',
        sourceRef: metadata.path,
        customFields: Object.keys(customFields).length > 0 ? customFields : undefined,
      });
    }

    return items;
  }

  private async listMergedTrackerItems(): Promise<TrackerItem[]> {
    const result = await database.query<any>(
      `SELECT * FROM tracker_items WHERE workspace = $1 ORDER BY kanban_sort_order ASC NULLS LAST, last_indexed DESC`,
      [this.workspacePath]
    );
    const dbItems = result.rows.map(row => this.rowToTrackerItem(row));
    const metadataItems = await this.listFullDocumentTrackerItemsFromMetadata();

    const merged = new Map<string, TrackerItem>();
    for (const item of metadataItems) {
      merged.set(item.id, item);
    }
    for (const item of dbItems) {
      const existing = merged.get(item.id);
      if (existing && item.source === 'frontmatter') {
        merged.set(item.id, {
          ...item,
          title: existing.title,
          description: existing.description,
          status: existing.status,
          priority: existing.priority,
          owner: existing.owner,
          module: existing.module,
          tags: existing.tags,
          created: existing.created,
          updated: existing.updated,
          dueDate: existing.dueDate,
          progress: existing.progress,
          lastIndexed: existing.lastIndexed,
          source: existing.source,
          sourceRef: existing.sourceRef,
          customFields: {
            ...(existing.customFields || {}),
            ...(item.customFields || {}),
          },
        });
      } else {
        merged.set(item.id, item);
      }
    }

    return Array.from(merged.values());
  }

  private async resolveTrackerRowForPublicId(
    itemId: string,
    options?: { createProjectionForFullDocument?: boolean }
  ): Promise<any | null> {
    const direct = await database.query<any>(
      `SELECT * FROM tracker_items WHERE id = $1`,
      [itemId]
    );
    if (direct.rows.length > 0) {
      return direct.rows[0];
    }

    const parsed = parseFullDocumentTrackerId(itemId);
    if (!parsed) return null;

    const bySourceRef = await database.query<any>(
      `SELECT * FROM tracker_items
       WHERE workspace = $1 AND source = 'frontmatter' AND source_ref = $2 AND type = $3
       ORDER BY updated DESC
       LIMIT 1`,
      [this.workspacePath, parsed.relativePath, parsed.trackerType]
    );
    if (bySourceRef.rows.length > 0) {
      return bySourceRef.rows[0];
    }

    if (!options?.createProjectionForFullDocument) {
      return null;
    }

    await this.ensureFrontmatterProjectionRow(parsed.relativePath, parsed.trackerType);

    const created = await database.query<any>(
      `SELECT * FROM tracker_items
       WHERE workspace = $1 AND source = 'frontmatter' AND source_ref = $2 AND type = $3
       ORDER BY updated DESC
       LIMIT 1`,
      [this.workspacePath, parsed.relativePath, parsed.trackerType]
    );
    return created.rows[0] || null;
  }

  private async ensureFrontmatterProjectionRow(
    relativePath: string,
    expectedType?: string,
  ): Promise<TrackerItem | null> {
    const fullPath = path.join(this.workspacePath, relativePath);

    let fileContent: string;
    try {
      fileContent = await fs.readFile(fullPath, 'utf-8');
    } catch {
      return null;
    }

    const { data: frontmatter } = await extractFrontmatter(fullPath);
    if (!frontmatter) return null;

    const resolved = resolveFullDocumentFrontmatter(frontmatter);
    if (!resolved) return null;
    if (expectedType && resolved.trackerType !== expectedType) return null;

    const title = (resolved.trackerData.title as string)
      || (frontmatter.title as string)
      || relativePath.split('/').pop()?.replace(/\.md$/, '')
      || 'Untitled';
    const bodyMatch = fileContent.match(/^---\s*\n[\s\S]*?\n---\s*\n([\s\S]*)$/);
    const markdownBody = bodyMatch ? bodyMatch[1].trim() : '';
    const canonicalId = buildFullDocumentTrackerId(resolved.trackerType, relativePath);

    const data: Record<string, any> = { title };
    for (const [key, value] of Object.entries(resolved.trackerData)) {
      if (key === 'type' || key === 'trackerStatus') continue;
      if (value !== undefined && value !== null) {
        data[key] = value;
      }
    }

    const existing = await database.query<any>(
      `SELECT id FROM tracker_items
       WHERE workspace = $1 AND source = 'frontmatter' AND source_ref = $2 AND type = $3
       LIMIT 1`,
      [this.workspacePath, relativePath, resolved.trackerType]
    );

    if (existing.rows.length > 0 && existing.rows[0].id !== canonicalId) {
      await database.query(
        `UPDATE tracker_items
         SET data = $1, content = $2, source = 'frontmatter', source_ref = $3, document_path = $3, updated = NOW()
         WHERE id = $4`,
        [
          JSON.stringify(data),
          markdownBody ? JSON.stringify(markdownBody) : null,
          relativePath,
          existing.rows[0].id,
        ]
      );
      const result = await database.query<any>(`SELECT * FROM tracker_items WHERE id = $1`, [existing.rows[0].id]);
      return result.rows.length > 0 ? this.rowToTrackerItem(result.rows[0]) : null;
    }

    await database.query(
      `INSERT INTO tracker_items (
        id, type, data, workspace, document_path, line_number,
        created, updated, last_indexed, sync_status,
        content, archived, source, source_ref
      ) VALUES ($1, $2, $3, $4, $5, 0, NOW(), NOW(), NOW(), 'local', $6, FALSE, 'frontmatter', $5)
      ON CONFLICT (id) DO UPDATE SET
        data = tracker_items.data || $3,
        content = $6,
        source = 'frontmatter',
        source_ref = $5,
        document_path = $5,
        updated = NOW()`,
      [
        canonicalId,
        resolved.trackerType,
        JSON.stringify(data),
        this.workspacePath,
        relativePath,
        markdownBody ? JSON.stringify(markdownBody) : null,
      ]
    );

    const result = await database.query<any>(`SELECT * FROM tracker_items WHERE id = $1`, [canonicalId]);
    return result.rows.length > 0 ? this.rowToTrackerItem(result.rows[0]) : null;
  }

  // Tracker Items API methods
  async listTrackerItems(): Promise<TrackerItem[]> {
    try {
      return await this.listMergedTrackerItems();
    } catch (error) {
      console.error('[DocumentService] Failed to list tracker items:', error);
      return [];
    }
  }

  async getTrackerItemsByType(type: TrackerItemType): Promise<TrackerItem[]> {
    try {
      const items = await this.listMergedTrackerItems();
      return items.filter(item => item.type === type);
    } catch (error) {
      console.error('[DocumentService] Failed to get tracker items by type:', error);
      return [];
    }
  }

  async getTrackerItemsByModule(module: string): Promise<TrackerItem[]> {
    try {
      const items = await this.listMergedTrackerItems();
      return items.filter(item => item.module === module);
    } catch (error) {
      console.error('[DocumentService] Failed to get tracker items by module:', error);
      return [];
    }
  }

  watchTrackerItems(listener: (change: TrackerItemChangeEvent) => void): () => void {
    const id = Date.now().toString();
    this.trackerItemWatchers.set(id, listener);

    // Return unsubscribe function
    return () => {
      this.trackerItemWatchers.delete(id);
    };
  }

  private rowToTrackerItem(row: any): TrackerItem {
    // Parse JSONB data field (PGLite returns object, SQLite returns JSON string)
    const data = parseJsonColumn<Record<string, any>>(row.data) ?? {};

    // type_tags from DB column; fall back to [type] for backward compat.
    // PGLite stored this as TEXT[]; SQLite stores it as a JSON-encoded string.
    const parsedTypeTags = parseJsonColumn<string[]>(row.type_tags);
    const typeTags: string[] =
      Array.isArray(parsedTypeTags) && parsedTypeTags.length > 0 ? parsedTypeTags : [row.type];

    return {
      id: getCanonicalTrackerItemIdFromRow(row),
      issueNumber: row.issue_number ?? undefined,
      issueKey: row.issue_key ?? undefined,
      type: row.type,
      typeTags,
      title: data.title || row.title, // Fallback to generated column
      description: data.description || undefined,
      status: data.status || row.status, // Fallback to generated column
      priority: data.priority || undefined,
      owner: data.owner || undefined,
      module: row.document_path || ((row.source === 'frontmatter' || row.source === 'import') ? row.source_ref : undefined),
      lineNumber: row.line_number || undefined,
      workspace: row.workspace,
      tags: data.tags || undefined,
      created: data.created || row.created || undefined,
      updated: data.updated || row.updated || undefined,
      dueDate: data.dueDate || undefined,
      lastIndexed: new Date(row.last_indexed),
      // Rich content (Lexical editor state)
      content: row.content != null ? row.content : undefined,
      // Archive state
      archived: row.archived ?? false,
      archivedAt: row.archived_at ? new Date(row.archived_at).toISOString() : undefined,
      // Source tracking
      source: row.source || (row.document_path ? 'inline' : 'native'),
      sourceRef: row.source_ref || undefined,
      // Collaborative fields from JSONB data
      assigneeEmail: data.assigneeEmail || undefined,
      reporterEmail: data.reporterEmail || undefined,
      authorIdentity: data.authorIdentity || undefined,
      lastModifiedBy: data.lastModifiedBy || undefined,
      createdByAgent: data.createdByAgent || false,
      assigneeId: data.assigneeId || undefined,
      reporterId: data.reporterId || undefined,
      labels: data.labels || undefined,
      linkedSessions: data.linkedSessions || undefined,
      linkedCommitSha: data.linkedCommitSha || undefined,
      documentId: data.documentId || undefined,
      syncStatus: row.sync_status || 'local',
      // Body Y.Doc version pointer (phase 4b). BIGINT in PGLite arrives
      // as string|number depending on the driver path; normalize.
      bodyVersion: row.body_version !== undefined && row.body_version !== null
        ? Number(row.body_version)
        : undefined,
      // Pass through extra JSONB data fields (e.g. kanbanSortOrder) so they
      // survive the TrackerItem -> TrackerRecord conversion via customFields.
      customFields: (() => {
        const known = new Set([
          'title', 'description', 'status', 'priority', 'owner', 'tags',
          'created', 'updated', 'dueDate', 'assigneeEmail', 'reporterEmail',
          'authorIdentity', 'lastModifiedBy', 'createdByAgent', 'assigneeId',
          'reporterId', 'labels', 'linkedSessions', 'linkedCommitSha', 'documentId',
        ]);
        const extra: Record<string, any> = {};
        if (data) {
          for (const [k, v] of Object.entries(data)) {
            if (!known.has(k) && v !== undefined) extra[k] = v;
          }
        }
        return Object.keys(extra).length > 0 ? extra : undefined;
      })(),
    };
  }

  /**
   * Get a single tracker item by ID, or null if not found.
   */
  async getTrackerItemById(itemId: string): Promise<TrackerItem | null> {
    const merged = await this.listMergedTrackerItems();
    const found = merged.find(item => item.id === itemId);
    if (found) return found;

    const row = await this.resolveTrackerRowForPublicId(itemId);
    return row ? this.rowToTrackerItem(row) : null;
  }

  /**
   * Ensure a backing projection row exists for a public tracker ID and return
   * the projected item. This is primarily used by MCP-facing code so
   * frontmatter-backed full-document items can participate in mutations that
   * still need a `tracker_items` row.
   */
  async ensureTrackerProjection(itemId: string): Promise<TrackerItem | null> {
    const row = await this.resolveTrackerRowForPublicId(itemId, {
      createProjectionForFullDocument: true,
    });
    return row ? this.rowToTrackerItem(row) : null;
  }

  /**
   * Update the sync_status of a tracker item.
   */
  async updateTrackerItemSyncStatus(itemId: string, syncStatus: string): Promise<void> {
    const row = await this.resolveTrackerRowForPublicId(itemId);
    if (!row) return;
    await database.query(
      `UPDATE tracker_items SET sync_status = $1 WHERE id = $2`,
      [syncStatus, row.id]
    );
    // Notify watchers
    const result = await database.query<any>(
      `SELECT * FROM tracker_items WHERE id = $1`,
      [row.id]
    );
    if (result.rows.length > 0) {
      const item = this.rowToTrackerItem(result.rows[0]);
      const changeEvent: TrackerItemChangeEvent = {
        added: [],
        updated: [item],
        removed: [],
        timestamp: new Date(),
      };
      this.trackerItemWatchers.forEach(callback => callback(changeEvent));
    }
  }

  /**
   * Update fields on a tracker item in PGLite.
   * Merges provided fields into the existing JSONB data column.
   */
  async updateTrackerItem(itemId: string, updates: Record<string, any>): Promise<TrackerItem> {
    const row = await this.resolveTrackerRowForPublicId(itemId, { createProjectionForFullDocument: true });
    if (!row) {
      throw new Error(`Tracker item not found: ${itemId}`);
    }
    const data = typeof row.data === 'string' ? JSON.parse(row.data) : (row.data || {});

    // Handle typeTags separately -- stored in SQL column, not JSONB
    if (updates.typeTags !== undefined) {
      const newTypeTags: string[] = Array.isArray(updates.typeTags) ? updates.typeTags : [row.type];
      // Ensure primary type is always included
      if (!newTypeTags.includes(row.type)) newTypeTags.unshift(row.type);
      await database.query(
        `UPDATE tracker_items SET type_tags = $1 WHERE id = $2`,
        [newTypeTags, row.id]
      );
    }

    // Stamp lastModifiedBy with current identity
    // getCurrentIdentity imported statically at top of file
    data.lastModifiedBy = getCurrentIdentity(row.workspace);

    // Merge remaining updates into data (skip typeTags since it's a column)
    for (const [key, value] of Object.entries(updates)) {
      if (key === 'typeTags') continue;
      data[key] = value;
    }

    await database.query(
      `UPDATE tracker_items SET data = $1, updated = NOW() WHERE id = $2`,
      [JSON.stringify(data), row.id]
    );

    const result = await database.query<any>(
      `SELECT * FROM tracker_items WHERE id = $1`,
      [row.id]
    );
    const updated = this.rowToTrackerItem(result.rows[0]);

    const changeEvent: TrackerItemChangeEvent = {
      added: [],
      updated: [updated],
      removed: [],
      timestamp: new Date(),
    };
    this.trackerItemWatchers.forEach(callback => callback(changeEvent));

    return updated;
  }

  /**
   * Update the rich content (Lexical editor state) of a tracker item.
   */
  async updateTrackerItemContent(itemId: string, content: any): Promise<void> {
    const row = await this.resolveTrackerRowForPublicId(itemId, { createProjectionForFullDocument: true });
    if (!row) {
      throw new Error(`Tracker item not found: ${itemId}`);
    }
    const contentJson = content != null ? JSON.stringify(content) : null;
    // Phase 4b: every body save bumps `body_version` and writes a row
    // into `tracker_body_cache` keyed by `(item_id, body_version)`. The
    // bumped version travels through the metadata sync envelope so
    // remote clients learn the body changed without re-fetching the Y.Doc.
    //
    // The UPDATE + cache INSERT are issued serially via the PGLite
    // worker, which serializes calls. A crash between the two leaves
    // tracker_items.body_version bumped but tracker_body_cache without
    // the new row -- on next save the bump re-fires and the cache row
    // gets a fresher version anyway, so we don't end up wedged.
    const updateResult = await database.query<{ body_version: string | number | null }>(
      `UPDATE tracker_items
         SET content = $1,
             body_version = COALESCE(body_version, 0) + 1,
             updated = NOW()
       WHERE id = $2
       RETURNING body_version`,
      [contentJson, row.id]
    );
    const newBodyVersion = Number(updateResult.rows[0]?.body_version ?? 0);

    if (contentJson !== null && newBodyVersion > 0) {
      // ON CONFLICT DO NOTHING covers the rare case where two saves race
      // on the same version assignment (shouldn't happen via PGLite's
      // single-writer worker, but cheap insurance).
      await database.query(
        `INSERT INTO tracker_body_cache (item_id, body_version, content, cached_at)
         VALUES ($1, $2, $3, NOW())
         ON CONFLICT (item_id, body_version) DO NOTHING`,
        [row.id, newBodyVersion, contentJson]
      );
    }

    const result = await database.query<any>(
      `SELECT * FROM tracker_items WHERE id = $1`,
      [row.id]
    );
    if (result.rows.length > 0) {
      const item = this.rowToTrackerItem(result.rows[0]);
      const changeEvent: TrackerItemChangeEvent = {
        added: [],
        updated: [item],
        removed: [],
        timestamp: new Date(),
      };
      this.trackerItemWatchers.forEach(callback => callback(changeEvent));

      // Phase 4b: fire a metadata-layer sync so remote cold clients
      // learn about the bumped body_version. Warm clients with the
      // DocumentRoom Y.Doc open already see body changes directly --
      // this push exists for the "search / preview / never-opened"
      // surface, which only ever reads the metadata projection. The
      // 800ms debounce upstream keeps the burst rate reasonable.
      if (isTrackerSyncActive(item.workspace)) {
        try {
          await syncTrackerItem(item);
        } catch (syncErr) {
          console.error('[DocumentService] updateTrackerItemContent sync failed:', syncErr);
        }
        // Intentionally NOT calling `applyHeadlessBodyMarkdown` here.
        //
        // The renderer save path that hits this IPC already wrote the
        // body to the live DocumentRoom Y.Doc through its own
        // `CollabLexicalProvider` -- the autosave fires AFTER the local
        // Y.Doc edit has propagated. Re-applying the same markdown via
        // the main-process headless peer is not just redundant: the
        // headless write does `root.clear()` + re-parse, generating
        // brand-new XmlElement IDs that the renderer's `@lexical/yjs`
        // binding sees as remote structural changes. That fires
        // `onDirtyChange` on the editor, which triggers another save,
        // which fires another headless write, and so on -- the loop
        // that just clobbered NIM-633's body cache 100+ times in 90
        // seconds with "asd" while we were debugging.
        //
        // MCP-driven body writes (handleTrackerCreate /
        // handleTrackerUpdate in trackerToolHandlers) still call
        // `applyHeadlessBodyMarkdown` themselves -- they are the path
        // that needs it because there is no live renderer peer to
        // write the Y.Doc.
      }
    }
  }

  /**
   * Read a body snapshot at a specific version from the cache. Used by
   * future cold-read paths (search, history, preview) so they don't pay
   * the cost of resolving the Y.Doc just to look at body text.
   *
   * Returns `null` when no cached row exists at that version (e.g. the
   * cache was provisioned after the version was written, or the row was
   * evicted by a future pruning policy).
   */
  async getTrackerBodyCacheAtVersion(itemId: string, bodyVersion: number): Promise<any | null> {
    const row = await this.resolveTrackerRowForPublicId(itemId);
    if (!row) return null;
    const result = await database.query<{ content: string | null }>(
      `SELECT content FROM tracker_body_cache
        WHERE item_id = $1 AND body_version = $2`,
      [row.id, bodyVersion]
    );
    const raw = result.rows[0]?.content;
    if (raw === undefined || raw === null) return null;
    try {
      return JSON.parse(raw);
    } catch {
      // Not JSON -- return as-is. The cache stores whatever the host wrote.
      return raw;
    }
  }

  /**
   * Read the latest body cache row for an item -- the one matching the
   * item's current `body_version`. Used by the renderer's cold-open path
   * so the editor can paint authoritative content before the
   * DocumentRoom Y.Doc finishes its initial sync. CollabLexicalProvider's
   * `deferInitialSync: true` mode ensures the bootstrap decision still
   * happens AFTER the server's initial sync response, so a non-empty
   * room won't be clobbered by this optimistic paint.
   *
   * Returns `null` when the item is missing, has never been saved
   * (body_version = 0), or the cache row was never written.
   */
  async getTrackerBodyCacheLatest(itemId: string): Promise<{ bodyVersion: number; content: any } | null> {
    const trackerRow = await this.resolveTrackerRowForPublicId(itemId);
    if (!trackerRow) return null;
    const result = await database.query<{ body_version: string | number | null; content: string | null }>(
      `SELECT t.body_version, c.content
         FROM tracker_items t
         LEFT JOIN tracker_body_cache c
           ON c.item_id = t.id AND c.body_version = t.body_version
        WHERE t.id = $1`,
      [trackerRow.id]
    );
    const row = result.rows[0];
    if (!row) return null;
    const bodyVersion = Number(row.body_version ?? 0);
    if (bodyVersion <= 0) return null;
    const raw = row.content;
    if (raw === undefined || raw === null) return null;
    let parsed: any = raw;
    try {
      parsed = JSON.parse(raw);
    } catch {
      // Not JSON -- return as-is. The cache stores whatever the host wrote.
    }
    return { bodyVersion, content: parsed };
  }

  /**
   * Get the rich content (Lexical editor state) of a tracker item.
   */
  async getTrackerItemContent(itemId: string): Promise<any | null> {
    const row = await this.resolveTrackerRowForPublicId(itemId);
    if (!row) return null;
    const result = await database.query<any>(
      `SELECT content FROM tracker_items WHERE id = $1`,
      [row.id]
    );
    if (result.rows.length === 0) return null;
    return result.rows[0].content ?? null;
  }

  /**
   * Archive or unarchive a tracker item.
   */
  async archiveTrackerItem(itemId: string, archive: boolean): Promise<TrackerItem> {
    const row = await this.resolveTrackerRowForPublicId(itemId, { createProjectionForFullDocument: true });
    if (!row) {
      throw new Error(`Tracker item not found: ${itemId}`);
    }

    // For inline/frontmatter items, write archived state back to the source file
    const documentPath = row.document_path || row.source_ref;
    if ((row.source === 'inline' || row.source === 'frontmatter') && documentPath) {
      try {
        await this.updateTrackerItemInFile(itemId, { archived: archive ? 'true' : null });
      } catch (err) {
        // File may be gone -- fall through to DB-only update
      }
    }

    if (archive) {
      await database.query(
        `UPDATE tracker_items SET archived = TRUE, archived_at = NOW(), updated = NOW() WHERE id = $1`,
        [row.id]
      );
    } else {
      await database.query(
        `UPDATE tracker_items SET archived = FALSE, archived_at = NULL, updated = NOW() WHERE id = $1`,
        [row.id]
      );
    }

    const result = await database.query<any>(
      `SELECT * FROM tracker_items WHERE id = $1`,
      [row.id]
    );
    if (result.rows.length === 0) {
      throw new Error(`Tracker item not found: ${itemId}`);
    }
    const item = this.rowToTrackerItem(result.rows[0]);

    const changeEvent: TrackerItemChangeEvent = {
      added: [],
      updated: [item],
      removed: [],
      timestamp: new Date(),
    };
    this.trackerItemWatchers.forEach(callback => callback(changeEvent));

    // Push archived state to sync server so other clients see it
    if (isTrackerSyncActive(item.workspace)) {
      try {
        await syncTrackerItem(item);
      } catch (syncErr) {
        console.error('[DocumentService] archiveTrackerItem sync failed:', syncErr);
      }
    }

    return item;
  }

  /**
   * Permanently delete a tracker item from the database.
   */
  async deleteTrackerItem(itemId: string): Promise<void> {
    const row = await this.resolveTrackerRowForPublicId(itemId);
    const rowId = row?.id || itemId;

    // For inline items, remove the line from the source file before deleting from DB
    if (row) {
      const { source, document_path: documentPath } = row;
      if (source === 'inline' && documentPath) {
        const fullPath = path.join(this.workspacePath, documentPath);
        try {
          const fileContent = await fs.readFile(fullPath, 'utf-8');
          const updated = removeInlineTrackerItem(fileContent, rowId);
          if (updated !== null) {
            await fs.writeFile(fullPath, updated, 'utf-8');
          }
        } catch (err: any) {
          if (err?.code !== 'ENOENT') {
            console.error(`[DocumentService] Failed to remove inline item ${itemId} from file:`, err);
          }
          // ENOENT: file already gone, proceed with DB delete
        }
      }
    }

    await database.query(
      `DELETE FROM tracker_items WHERE id = $1`,
      [rowId]
    );

    // Notify sync server so other clients remove the item too
    if (isTrackerSyncActive(this.workspacePath)) {
      try {
        await unsyncTrackerItem(rowId, this.workspacePath);
      } catch (syncErr) {
        console.error('[DocumentService] deleteTrackerItem sync failed:', syncErr);
      }
    }

    const changeEvent: TrackerItemChangeEvent = {
      added: [],
      updated: [],
      removed: [itemId],
      timestamp: new Date(),
    };
    this.trackerItemWatchers.forEach(callback => callback(changeEvent));
  }

  /**
   * Update a file-backed tracker item by writing field changes back to the file.
   * Handles both frontmatter-based items (YAML) and inline items (#type[...]).
   */
  async updateTrackerItemInFile(itemId: string, updates: Record<string, any>): Promise<TrackerItem> {
    let row = await this.resolveTrackerRowForPublicId(itemId, { createProjectionForFullDocument: false });
    const parsedFullDocumentId = parseFullDocumentTrackerId(itemId);
    if (!row && parsedFullDocumentId) {
      row = {
        id: itemId,
        type: parsedFullDocumentId.trackerType,
        source: 'frontmatter',
        source_ref: parsedFullDocumentId.relativePath,
        document_path: parsedFullDocumentId.relativePath,
        data: {},
        workspace: this.workspacePath,
      };
    }
    if (!row) {
      throw new Error(`Tracker item not found: ${itemId}`);
    }

    const source = row.source; // 'inline', 'frontmatter', 'import'
    const sourceRef = row.source_ref;
    const documentPath = row.document_path;
    const trackerType = row.type;

    // Determine the file path -- inline items use document_path, frontmatter uses source_ref
    const relativePath = source === 'inline' ? documentPath : (sourceRef || documentPath);
    if (!relativePath) {
      throw new Error(`Item ${itemId} has no source file reference`);
    }

    const fullPath = path.join(this.workspacePath, relativePath);

    // Read current file content -- if the source file was deleted, fall through
    // to a DB-only update (no file to write back to)
    let fileContent: string | null = null;
    try {
      fileContent = await fs.readFile(fullPath, 'utf-8');
    } catch (err: any) {
      if (err?.code === 'ENOENT') {
        // Source file was deleted -- we'll just update the DB below
        // console.log(`[DocumentService] Source file ${relativePath} no longer exists, updating DB only`);
      } else {
        throw new Error(`Failed to read source file: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    if (fileContent !== null) {
      let updatedContent: string;
      if (source === 'inline') {
        // Inline items: rewrite #type[...] metadata in the line
        const result = updateInlineTrackerItem(fileContent, itemId, updates);
        if (!result) {
          throw new Error(`Could not find inline item ${itemId} in ${relativePath}`);
        }
        updatedContent = result;
      } else {
        const { description, ...frontmatterUpdates } = updates;
        updatedContent = Object.keys(frontmatterUpdates).length > 0
          ? updateTrackerInFrontmatter(fileContent, trackerType, frontmatterUpdates)
          : fileContent;
        if (description !== undefined) {
          const normalizedBody = typeof description === 'string'
            ? description.replace(/\\n/g, '\n')
            : String(description ?? '');
          const frontmatterRegex = /^---\r?\n[\s\S]*?\r?\n---\r?\n?/;
          const frontmatterMatch = updatedContent.match(frontmatterRegex);
          if (frontmatterMatch) {
            updatedContent = `${frontmatterMatch[0]}${normalizedBody}${normalizedBody.endsWith('\n') ? '' : '\n'}`;
          } else {
            updatedContent = normalizedBody;
          }
        }
      }

      // Write back
      await fs.writeFile(fullPath, updatedContent, 'utf-8');
    }

    // Also update the database row so the UI reflects changes immediately
    // (the file watcher will re-index later, but this gives instant feedback)
    // Only update the data JSONB column -- top-level columns (status, title, etc.)
    // are generated columns and cannot be SET directly.
    const resolvedRow = await this.resolveTrackerRowForPublicId(itemId, {
      createProjectionForFullDocument: source === 'frontmatter' || source === 'import',
    });

    let item: TrackerItem;
    if (resolvedRow) {
      const existingData = typeof resolvedRow.data === 'string' ? JSON.parse(resolvedRow.data) : (resolvedRow.data || {});
      const mergedData = { ...existingData, ...updates };
      const normalizedDescription = typeof updates.description === 'string'
        ? updates.description.replace(/\\n/g, '\n')
        : undefined;
      if ((source === 'frontmatter' || source === 'import') && updates.description !== undefined) {
        delete mergedData.description;
        const contentJson = normalizedDescription != null ? JSON.stringify(normalizedDescription) : null;
        const versionResult = await database.query<{ body_version: string | number | null }>(
          `UPDATE tracker_items
             SET data = $1,
                 content = $2,
                 body_version = COALESCE(body_version, 0) + 1,
                 updated = NOW()
           WHERE id = $3
           RETURNING body_version`,
          [JSON.stringify(mergedData), contentJson, resolvedRow.id]
        );
        const newBodyVersion = Number(versionResult.rows[0]?.body_version ?? 0);
        if (contentJson !== null && newBodyVersion > 0) {
          await database.query(
            `INSERT INTO tracker_body_cache (item_id, body_version, content, cached_at)
             VALUES ($1, $2, $3, NOW())
             ON CONFLICT (item_id, body_version) DO NOTHING`,
            [resolvedRow.id, newBodyVersion, contentJson]
          );
        }
      } else {
        await database.query(
          `UPDATE tracker_items SET data = $1, updated = NOW() WHERE id = $2`,
          [JSON.stringify(mergedData), resolvedRow.id]
        );
      }

      const updated = await database.query<any>(
        `SELECT * FROM tracker_items WHERE id = $1`,
        [resolvedRow.id]
      );
      item = this.rowToTrackerItem(updated.rows[0]);
    } else {
      const metadata = this.metadataByPath.get(relativePath);
      if (!metadata) {
        throw new Error(`Tracker item ${itemId} was updated in file but could not be reloaded from metadata`);
      }
      const synthesized = (await this.listFullDocumentTrackerItemsFromMetadata())
        .find(candidate => candidate.id === itemId);
      if (!synthesized) {
        throw new Error(`Tracker item ${itemId} was updated in file but could not be synthesized`);
      }
      item = synthesized;
    }

    // Notify watchers
    const changeEvent: TrackerItemChangeEvent = {
      added: [],
      updated: [item],
      removed: [],
      timestamp: new Date(),
    };
    this.trackerItemWatchers.forEach(callback => callback(changeEvent));

    return item;
  }

  /**
   * Import a single markdown file as a native tracker item.
   * Reads frontmatter for metadata and the markdown body as content.
   * Returns the created item or null if the file has no tracker frontmatter.
   */
  async importTrackerItemFromFile(relativePath: string, options?: {
    skipDuplicates?: boolean;
  }): Promise<{ item: TrackerItem | null; skipped: boolean; error?: string }> {
    const fullPath = path.join(this.workspacePath, relativePath);

    // Check for duplicate by source_ref
    if (options?.skipDuplicates !== false) {
      const existing = await database.query<any>(
        `SELECT id FROM tracker_items WHERE workspace = $1 AND source = 'frontmatter' AND source_ref = $2`,
        [this.workspacePath, relativePath]
      );
      if (existing.rows.length > 0) {
        return { item: null, skipped: true };
      }
    }

    // Read the full file
    let fileContent: string;
    try {
      fileContent = await fs.readFile(fullPath, 'utf-8');
    } catch (err) {
      return { item: null, skipped: false, error: `Failed to read file: ${err instanceof Error ? err.message : String(err)}` };
    }

    // Parse frontmatter
    const { data: frontmatter } = await extractFrontmatter(fullPath);
    if (!frontmatter) {
      return { item: null, skipped: false, error: 'No valid frontmatter found' };
    }

    // Resolve tracker frontmatter. Keep this in sync with
    // `detectTrackerFromFrontmatter` / `resolveTrackerFrontmatter` so import
    // accepts extension-owned keys, canonical trackerStatus docs, and older
    // legacy per-type keys like `planStatus`. Otherwise import rejects files
    // that the tracker UI still considers valid tracker documents.
    let trackerData: Record<string, any> | null = null;
    let trackerType = 'plan'; // default

    for (const [extKey, extType] of Object.entries(EXTENSION_OWNED_KEYS)) {
      if (frontmatter[extKey] && typeof frontmatter[extKey] === 'object') {
        const extData = frontmatter[extKey] as Record<string, any>;
        const { [extKey]: _ext, trackerStatus: _ts, ...topLevel } = frontmatter;
        trackerType = extType;
        trackerData = { ...topLevel, ...extData };
        break;
      }
    }

    if (!trackerData && frontmatter.trackerStatus && typeof frontmatter.trackerStatus === 'object') {
      const ts = frontmatter.trackerStatus as Record<string, any>;
      trackerType = (ts.type as string) || 'plan';
      // Top-level fields are canonical, trackerStatus holds only type
      const { trackerStatus: _, ...topLevel } = frontmatter;
      trackerData = { ...ts, ...topLevel };
    }

    if (!trackerData) {
      for (const [legacyKey, legacyType] of Object.entries(LEGACY_KEY_TO_TYPE)) {
        if (frontmatter[legacyKey] && typeof frontmatter[legacyKey] === 'object') {
          const legacyData = frontmatter[legacyKey] as Record<string, any>;
          const { [legacyKey]: _, trackerStatus: _ts, ...topLevel } = frontmatter;
          trackerType = legacyType;
          trackerData = { ...legacyData, ...topLevel };
          break;
        }
      }
    }

    if (!trackerData) {
      return { item: null, skipped: false, error: 'No tracker frontmatter found' };
    }

    // Extract markdown body (everything after frontmatter)
    const bodyMatch = fileContent.match(/^---\s*\n[\s\S]*?\n---\s*\n([\s\S]*)$/);
    const markdownBody = bodyMatch ? bodyMatch[1].trim() : '';

    // Build title from frontmatter or file name
    const title = (trackerData.title as string)
      || (frontmatter.title as string)
      || relativePath.split('/').pop()?.replace(/\.md$/, '') || 'Untitled';

    // Generate stable canonical ID from tracker type + file path so UI, MCP,
    // and file-backed mutation paths all resolve the same logical item.
    const id = buildFullDocumentTrackerId(trackerType, relativePath);

    // Build JSONB data: ALL frontmatter fields go into the data bag generically.
    // No privileged field vocabulary -- the schema determines which fields matter.
    const systemKeys = new Set(['type', 'trackerStatus']);
    const data: Record<string, any> = { title };
    for (const [key, value] of Object.entries(trackerData)) {
      if (systemKeys.has(key)) continue;
      if (value !== undefined && value !== null) {
        data[key] = value;
      }
    }

    const contentJson = markdownBody ? JSON.stringify(markdownBody) : null;

    // Insert into database
    await database.query(
      `INSERT INTO tracker_items (
        id, type, data, workspace, document_path, line_number,
        created, updated, last_indexed, sync_status,
        content, archived, source, source_ref
      ) VALUES ($1, $2, $3, $4, $6, NULL, NOW(), NOW(), NOW(), 'local', $5, FALSE, 'frontmatter', $6)
      ON CONFLICT (id) DO UPDATE SET
        data = tracker_items.data || $3, content = $5, source = 'frontmatter', source_ref = $6, document_path = $6, updated = NOW()`,
      [id, trackerType, JSON.stringify(data), this.workspacePath, contentJson, relativePath]
    );

    const result = await database.query<any>(
      `SELECT * FROM tracker_items WHERE id = $1`,
      [id]
    );
    if (result.rows.length === 0) {
      return { item: null, skipped: false, error: 'Failed to read back created item' };
    }

    const created = this.rowToTrackerItem(result.rows[0]);

    // Notify watchers
    const changeEvent: TrackerItemChangeEvent = {
      added: [created],
      updated: [],
      removed: [],
      timestamp: new Date(),
    };
    this.trackerItemWatchers.forEach(callback => callback(changeEvent));

    return { item: created, skipped: false };
  }

  /**
   * Bulk import markdown files from a directory as native tracker items.
   * Scans for files with tracker frontmatter and imports them.
   */
  async bulkImportTrackerItems(directory: string, options?: {
    skipDuplicates?: boolean;
    recursive?: boolean;
  }): Promise<{ imported: number; skipped: number; errors: string[] }> {
    const fullDir = path.join(this.workspacePath, directory);
    const skipDuplicates = options?.skipDuplicates ?? true;
    const recursive = options?.recursive ?? true;

    let imported = 0;
    let skipped = 0;
    const errors: string[] = [];

    // Scan directory for markdown files
    const scanDir = async (dir: string) => {
      let entries: string[];
      try {
        entries = await fs.readdir(dir);
      } catch {
        errors.push(`Cannot read directory: ${dir}`);
        return;
      }

      for (const entry of entries) {
        const fullPath = path.join(dir, entry);
        let stat;
        try {
          stat = await fs.stat(fullPath);
        } catch {
          continue;
        }

        if (stat.isDirectory() && recursive) {
          await scanDir(fullPath);
        } else if (stat.isFile()) {
          const ext = path.extname(entry).toLowerCase();
          if (ext !== '.md' && ext !== '.markdown') continue;

          const relativePath = path.relative(this.workspacePath, fullPath);
          const result = await this.importTrackerItemFromFile(relativePath, { skipDuplicates });

          if (result.skipped) {
            skipped++;
          } else if (result.item) {
            imported++;
          } else if (result.error) {
            // Only report real errors, not "no frontmatter" which is expected for non-tracker files
            if (!result.error.includes('No tracker frontmatter') && !result.error.includes('No valid frontmatter')) {
              errors.push(`${relativePath}: ${result.error}`);
            }
          }
        }
      }
    };

    await scanDir(fullDir);
    return { imported, skipped, errors };
  }

  /**
   * Create a tracker item directly in PGLite (not from markdown parsing).
   * Used for proper collaborative tracked items created from the UI.
   * These items have empty document_path and don't correspond to any file.
   */
  async createTrackerItem(payload: {
    id: string;
    type: string;
    title: string;
    status: string;
    priority: string;
    workspace: string;
    description?: string;
    owner?: string;
    tags?: string[];
    customFields?: Record<string, any>;
    content?: any;
    source?: string;
    sourceRef?: string;
    syncMode?: string;
  }): Promise<TrackerItem> {
    // Check if this type allows creation
    const { globalRegistry } = await import('@nimbalyst/runtime/plugins/TrackerPlugin/models/TrackerDataModel');
    const model = globalRegistry.get(payload.type);
    if (model && model.creatable === false) {
      throw new Error(`Cannot create items of type '${payload.type}': type is not creatable`);
    }

    // Stamp author identity on creation
    // getCurrentIdentity imported statically at top of file
    const authorIdentity = getCurrentIdentity(payload.workspace);

    // Assign initial kanbanSortOrder: place new items at the top of their column.
    // Query the current minimum sort key for this workspace+status so the new item sorts before it.
    let initialSortOrder = 'a0';
    try {
      const minKeyResult = await database.query<any>(
        `SELECT MIN(kanban_sort_order) as min_key FROM tracker_items WHERE workspace = $1 AND status = $2 AND kanban_sort_order IS NOT NULL`,
        [payload.workspace, payload.status]
      );
      const minKey = minKeyResult.rows[0]?.min_key;
      if (minKey) {
        const { generateKeyBetween } = await import('@nimbalyst/runtime/utils/fractionalIndex');
        initialSortOrder = generateKeyBetween(null, minKey);
      }
    } catch (e) {
      // Non-fatal: fall back to default sort order
    }

    const data: Record<string, any> = {
      title: payload.title,
      status: payload.status,
      priority: payload.priority,
      kanbanSortOrder: initialSortOrder,
      created: new Date().toISOString().split('T')[0],
      authorIdentity,
      reporterEmail: authorIdentity.email || authorIdentity.gitEmail || undefined,
    };
    if (payload.description) data.description = payload.description;
    if (payload.owner) data.owner = payload.owner;
    if (payload.tags && payload.tags.length > 0) data.tags = payload.tags;
    if (payload.customFields) {
      Object.assign(data, payload.customFields);
    }

    const source = payload.source || 'native';
    const contentJson = payload.content ? JSON.stringify(payload.content) : null;
    const syncPolicy = getEffectiveTrackerSyncPolicy(payload.workspace, payload.type, payload.syncMode);
    const syncStatus = getInitialTrackerSyncStatus(syncPolicy);

    await database.query(
      `INSERT INTO tracker_items (
        id, type, data, workspace, document_path, line_number,
        created, updated, last_indexed, sync_status,
        content, archived, source, source_ref
      ) VALUES ($1, $2, $3, $4, '', NULL, NOW(), NOW(), NOW(), $5, $6, FALSE, $7, $8)`,
      [
        payload.id,
        payload.type,
        JSON.stringify(data),
        payload.workspace,
        syncStatus,
        contentJson,
        source,
        payload.sourceRef || null,
      ]
    );

    const result = await database.query<any>(
      `SELECT * FROM tracker_items WHERE id = $1`,
      [payload.id]
    );
    if (result.rows.length === 0) {
      throw new Error(`Failed to create tracker item ${payload.id}`);
    }

    const created = this.rowToTrackerItem(result.rows[0]);

    // Notify watchers
    const changeEvent: TrackerItemChangeEvent = {
      added: [created],
      updated: [],
      removed: [],
      timestamp: new Date(),
    };
    this.trackerItemWatchers.forEach(callback => callback(changeEvent));

    return created;
  }

  /**
   * Parse tracker items from markdown content
   * Note: This function is only called for .md and .markdown files
   */
  private async parseTrackerItems(filePath: string, relativePath: string): Promise<ParsedInlineTrackerCandidate[]> {
    try {
      const content = await fs.readFile(filePath, 'utf-8');
      const items: ParsedInlineTrackerCandidate[] = [];
      const lines = content.split('\n');

      // Anchor the tracker token on whitespace (or start-of-line) instead of
      // leading with a lazy `.+?`. The previous pattern
      // `/(.+?)\s+#([\w-]+)\[(.+?)\]/` had two unbounded lazy groups and
      // exhibited O(N^2)+ catastrophic backtracking on long lines containing
      // scattered `#`, `[`, `]` characters without a real tracker token. A
      // single inline base64 image (`![](data:image/png;base64,...)`,
      // ~300k chars on one line) locked the main process for 100+ seconds
      // during the file-watcher-driven cache refresh after AI edits.
      const trackerRegex = /(?:^|\s)#([\w-]+)\[([^\]\r\n]+)\]/;

      // Track whether we're inside a code block
      let inCodeBlock = false;

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];

        // Check for code block fences (``` or ~~~)
        if (line.trim().startsWith('```') || line.trim().startsWith('~~~')) {
          inCodeBlock = !inCodeBlock;
          continue;
        }

        // Skip lines inside code blocks
        if (inCodeBlock) {
          continue;
        }

        // Defense-in-depth: skip pathological lines before the regex runs.
        // Real tracker syntax is well under 500 chars; anything longer is an
        // inline base64 image, minified JSON, or similar — never a tracker.
        if (line.length > 4096) {
          continue;
        }

        // Cheap prefilter: a tracker token requires both `#` and `[`.
        if (line.indexOf('#') < 0 || line.indexOf('[') < 0) {
          continue;
        }

        // Skip lines that are indented code blocks (4+ spaces or tab at start)
        if (line.match(/^(\s{4,}|\t)/)) {
          continue;
        }

        const match = line.match(trackerRegex);

        if (match && match.index !== undefined) {
          // Reconstruct the title from the slice of the line preceding the
          // tag. The new regex no longer captures the title group; deriving
          // it positionally keeps the title O(N) instead of forcing the
          // engine into a lazy-prefix backtrack.
          const title = line.slice(0, match.index).trim();
          if (!title) {
            // Preserve original semantic: a tracker line must have a title.
            continue;
          }

          // Additional check: ensure the match is not inside inline code (backticks)
          // This prevents matching `#bug[...]` within inline code blocks
          const beforeMatch = line.substring(0, match.index);
          const backtickCount = (beforeMatch.match(/`/g) || []).length;

          // If odd number of backticks before the match, we're inside inline code
          if (backtickCount % 2 !== 0) {
            continue;
          }
          const [, type, propsStr] = match;

          // Parse key:value pairs
          const props: Record<string, string> = {};
          const propRegex = /(\w+):((?:"[^"]*")|(?:[^\s\]]+))/g;
          let propMatch;
          while ((propMatch = propRegex.exec(propsStr)) !== null) {
            const [, key, value] = propMatch;
            props[key] = value.startsWith('"') ? value.slice(1, -1).replace(/\\"/g, '"') : value;
          }

          // Extract description from indented lines below
          let description: string | undefined;
          const descriptionLines: string[] = [];
          let j = i + 1;
          while (j < lines.length) {
            const nextLine = lines[j];
            // Check if line is indented (starts with 2+ spaces or a tab)
            if (nextLine.match(/^(\s{2,}|\t)/)) {
              // Remove leading indentation and add to description
              descriptionLines.push(nextLine.replace(/^(\s{2,}|\t)/, ''));
              j++;
            } else {
              break;
            }
          }
          if (descriptionLines.length > 0) {
            description = descriptionLines.join('\n').trim();
          }

          items.push({
            id: props.id || undefined,
            explicitId: Boolean(props.id),
            type: type as TrackerItemType,
            title: title.replace(/^- /, '').replace(/^\[ \] /, '').replace(/^\[x\] /, ''),
            description,
            status: (props.status || 'to-do') as any,
            priority: props.priority as any,
            owner: props.owner,
            module: relativePath,
            lineNumber: i + 1,
            workspace: this.workspacePath,
            tags: props.tags ? props.tags.split(',') : undefined,
            created: props.created,
            updated: props.updated,
            dueDate: props.due || undefined,
            archived: props.archived === 'true',
            lastIndexed: new Date()
          });
        }
      }

      // console.log(`[DocumentService] Parsed ${items.length} tracker items from ${relativePath}`);
      return items;
    } catch (error) {
      console.error(`[DocumentService] Failed to parse tracker items from ${relativePath}:`, error);
      return [];
    }
  }

  /**
   * Update tracker items cache for a file
   * Only processes markdown files - tracker items are not parsed from code files
   */
  private async updateTrackerItemsCache(relativePath: string): Promise<void> {
    // Only parse tracker items from markdown files
    const ext = path.extname(relativePath).toLowerCase();
    if (ext !== '.md' && ext !== '.markdown') {
      return;
    }

    const fullPath = path.join(this.workspacePath, relativePath);

    // TODO: Debug logging - uncomment if needed for troubleshooting
    // console.log(`[DocumentService] updateTrackerItemsCache called for: ${relativePath}`);
    // console.log(`[DocumentService] Full path: ${fullPath}`);

    try {
      // Parse tracker items from the file
      const parsedItems = await this.parseTrackerItems(fullPath, relativePath);
      // TODO: Debug logging - uncomment if needed for troubleshooting
      // console.log(`[DocumentService] Found ${items.length} tracker items in ${relativePath}`);
      // if (items.length > 0) {
      //   console.log(`[DocumentService] Sample tracker item:`, items[0]);
      // }

      // Get existing items for this module
      // console.log(`[DocumentService] Querying database for existing tracker items...`);
      const existingResult = await database.query<any>(
        `SELECT id, type, line_number, title
         FROM tracker_items
         WHERE workspace = $1 AND document_path = $2`,
        [this.workspacePath, relativePath]
      );
      // console.log(`[DocumentService] Found ${existingResult.rows.length} existing tracker items in database`);
      const existingIds = new Set(existingResult.rows.map(row => row.id));
      const items = resolveInlineTrackerIds(parsedItems, existingResult.rows, relativePath);
      const newIds = new Set(items.map(item => item.id));

      // Find items to remove (existed before but not anymore)
      const removedIds = Array.from(existingIds).filter(id => !newIds.has(id));

      // Remove old items
      if (removedIds.length > 0) {
        // console.log(`[DocumentService] Removing ${removedIds.length} tracker items from database`);
        await database.query(
          `DELETE FROM tracker_items WHERE id = ANY($1)`,
          [removedIds]
        );
      }

      // Upsert new/updated items
      // console.log(`[DocumentService] Upserting ${items.length} tracker items to database`);
      for (const item of items) {
        // Build JSONB data object
        const data = {
          title: item.title,
          description: item.description,
          status: item.status,
          priority: item.priority,
          owner: item.owner,
          tags: item.tags || [],
          dueDate: item.dueDate,
          created: item.created,
          updated: item.updated
        };

        const isArchived = item.archived === true;

        // console.log(`[DocumentService] Inserting tracker item: ${item.id} (${item.type})`);
        // Only set archived on INSERT (new items default to false).
        // On UPDATE: only set archived=true if the file explicitly says so.
        // Never reset archived to false from re-indexing -- the DB is the authority
        // for archive state when the file doesn't have an archived prop.
        // On conflict: merge file-derived fields INTO existing JSONB (preserves
        // system metadata like authorIdentity, createdByAgent, linkedSessions,
        // activity, comments that the indexer doesn't know about).
        const result = await database.query(
          `INSERT INTO tracker_items (
            id, type, data, workspace, document_path, line_number, created, updated, last_indexed, archived, archived_at
          ) VALUES ($1, $2, $3, $4, $5, $6, NOW(), NOW(), $7, $8, $9)
          ON CONFLICT (id) DO UPDATE SET
            type = $2, data = tracker_items.data || $3, workspace = $4, document_path = $5, line_number = $6, updated = NOW(), last_indexed = $7,
            archived = CASE WHEN $8 = TRUE THEN TRUE ELSE tracker_items.archived END,
            archived_at = CASE WHEN $8 = TRUE THEN $9 ELSE tracker_items.archived_at END`,
          [
            item.id,
            item.type,
            JSON.stringify(data),
            item.workspace,
            item.module, // document_path
            item.lineNumber || null,
            item.lastIndexed,
            isArchived,
            isArchived ? new Date().toISOString() : null
          ]
        );
        // console.log(`[DocumentService] Insert result:`, result);
      }

      // Notify watchers if there are changes.
      // Re-read items from DB to get authoritative archived state
      // (the upsert preserves DB archived state via CASE, but parsed items may not have it)
      if (items.length > 0 || removedIds.length > 0) {
        const itemIds = items.map(item => item.id);
        let dbItems: TrackerItem[] = items;
        if (itemIds.length > 0) {
          try {
            const dbResult = await database.query<any>(
              `SELECT * FROM tracker_items WHERE id = ANY($1)`,
              [itemIds]
            );
            dbItems = dbResult.rows.map((row: any) => this.rowToTrackerItem(row));
          } catch {
            // Fall back to parsed items if DB read fails
          }
        }
        const changeEvent: TrackerItemChangeEvent = {
          added: dbItems.filter(item => !existingIds.has(item.id)),
          updated: dbItems.filter(item => existingIds.has(item.id)),
          removed: removedIds,
          timestamp: new Date()
        };

        // console.log(`[DocumentService] Notifying ${this.trackerItemWatchers.size} watchers of tracker item changes`);
        this.trackerItemWatchers.forEach(callback => callback(changeEvent));
      }

      // console.log(`[DocumentService] updateTrackerItemsCache completed successfully for ${relativePath}`);
    } catch (error) {
      console.error(`[DocumentService] Failed to update tracker items cache for ${relativePath}:`, error);
    }
  }

  // Asset management methods
  async storeAsset(buffer: Buffer, mimeType: string, documentPath?: string): Promise<{ hash: string, extension: string, relativePath: string }> {
    // Hash the image buffer
    const hash = crypto.createHash('sha256').update(buffer).digest('hex');

    // Determine file extension from MIME type
    const extensionMap: Record<string, string> = {
      'image/png': 'png',
      'image/jpeg': 'jpg',
      'image/jpg': 'jpg',
      'image/gif': 'gif',
      'image/webp': 'webp',
      'image/svg+xml': 'svg'
    };
    const extension = extensionMap[mimeType] || 'png';
    const filename = `${hash}.${extension}`;

    // Determine asset storage location based on document path
    let assetsDir: string;
    let relativePath: string;

    if (documentPath) {
      // Store in assets/ folder adjacent to the document
      const documentDir = path.dirname(documentPath);
      assetsDir = path.join(documentDir, 'assets');
      relativePath = `assets/${filename}`;
    } else {
      // Fallback to workspace-level storage (for backward compatibility)
      assetsDir = path.join(this.workspacePath, '.nimbalyst', 'assets');
      relativePath = `.nimbalyst/assets/${filename}`;
    }

    // Ensure assets directory exists
    await fs.mkdir(assetsDir, { recursive: true });

    // Write file with hash as name
    const assetPath = path.join(assetsDir, filename);

    // Only write if file doesn't already exist (deduplication)
    try {
      await fs.access(assetPath);
      // console.log(`[DocumentService] Asset ${filename} already exists at ${assetsDir}, skipping write`);
    } catch {
      await fs.writeFile(assetPath, buffer);
      // console.log(`[DocumentService] Stored asset ${filename} at ${assetsDir} (${buffer.length} bytes)`);
    }

    return { hash, extension, relativePath };
  }

  async getAssetPath(hash: string): Promise<string | null> {
    const assetsDir = path.join(this.workspacePath, '.nimbalyst', 'assets');

    // Try common extensions
    const extensions = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg'];
    for (const ext of extensions) {
      const assetPath = path.join(assetsDir, `${hash}.${ext}`);
      try {
        await fs.access(assetPath);
        return assetPath;
      } catch {
        // File doesn't exist, try next extension
      }
    }

    return null;
  }

  async garbageCollectAssets(): Promise<number> {
    const assetsDir = path.join(this.workspacePath, '.nimbalyst', 'assets');

    try {
      // Check if assets directory exists
      await fs.access(assetsDir);
    } catch {
      // No assets directory, nothing to collect
      return 0;
    }

    // Scan all markdown files for asset references
    const referencedHashes = new Set<string>();
    const assetRegex = /\.nimbalyst\/assets\/([a-f0-9]+)\./g;

    for (const doc of this.documents) {
      const fullPath = path.join(this.workspacePath, doc.path);
      try {
        const content = await fs.readFile(fullPath, 'utf-8');
        let match;
        while ((match = assetRegex.exec(content)) !== null) {
          referencedHashes.add(match[1]);
        }
      } catch (error) {
        console.error(`[DocumentService] Failed to scan ${doc.path} for asset refs:`, error);
      }
    }

    // Get all asset files
    const assetFiles = await fs.readdir(assetsDir);
    let deletedCount = 0;

    for (const file of assetFiles) {
      // Extract hash from filename (before the extension)
      const hash = file.split('.')[0];

      if (!referencedHashes.has(hash)) {
        const assetPath = path.join(assetsDir, file);
        await shell.trashItem(assetPath);
        // console.log(`[DocumentService] Deleted unreferenced asset: ${file}`);
        deletedCount++;
      }
    }

    return deletedCount;
  }

  destroy() {
    if (this.watchInterval) {
      clearInterval(this.watchInterval);
      this.watchInterval = null;
    }
    this.watchers.clear();
    this.metadataWatchers.clear();
    this.trackerItemWatchers.clear();
    this.metadataCache.clear();
    this.metadataByPath.clear();
    this.fileStateCache.clear();
  }
}

type DocumentServiceResolver = (event: IpcMainEvent | IpcMainInvokeEvent) => ElectronDocumentService | null;

let handlersRegistered = false;
let resolveDocumentService: DocumentServiceResolver | null = null;

function requireDocumentService(event: IpcMainEvent | IpcMainInvokeEvent): ElectronDocumentService {
  if (!resolveDocumentService) {
    throw new Error('[DocumentService] Resolver not registered');
  }
  const service = resolveDocumentService(event);
  if (!service) {
    throw new Error('[DocumentService] No document service available for sender');
  }
  return service;
}

// IPC handler setup
export function setupDocumentServiceHandlers(resolver: DocumentServiceResolver) {
  resolveDocumentService = resolver;

  if (handlersRegistered) {
    return;
  }
  handlersRegistered = true;

  safeHandle('document-service:list', async (event) => {
    try {
      // Debug logging - comment out for production
      // console.log('[DocumentService IPC] list handler called');
      const docs = await requireDocumentService(event).listDocuments();
      // console.log('[DocumentService IPC] list returning', docs.length, 'documents');
      return docs;
    } catch (error) {
      console.error('[DocumentService] list failed:', error);
      return [];
    }
  });

  safeHandle('document-service:search', async (event, query: string) => {
    try {
      // Debug logging - comment out for production
      // console.log('[DocumentService IPC] search handler called with query:', query);
      const results = await requireDocumentService(event).searchDocuments(query);
      // console.log('[DocumentService IPC] search returning', results.length, 'results');
      return results;
    } catch (error) {
      console.error('[DocumentService] search failed:', error);
      return [];
    }
  });

  safeHandle('document-service:get', async (event, id: string) => {
    try {
      return await requireDocumentService(event).getDocument(id);
    } catch (error) {
      console.error('[DocumentService] get failed:', error);
      return null;
    }
  });

  safeHandle('document-service:get-by-path', async (event, path: string) => {
    try {
      return await requireDocumentService(event).getDocumentByPath(path);
    } catch (error) {
      console.error('[DocumentService] getByPath failed:', error);
      return null;
    }
  });

  safeHandle('document-service:open', async (event, payload: { documentId: string; fallback?: DocumentOpenOptions }) => {
    try {
      const { documentId, fallback } = payload ?? { documentId: '' };
      return await requireDocumentService(event).openDocument(documentId, fallback);
    } catch (error) {
      console.error('[DocumentService] open failed:', error);
      throw error;
    }
  });

  // Handle watch subscriptions
  safeOn('document-service:watch', (event) => {
    let unsubscribe: (() => void) | undefined;
    try {
      const service = requireDocumentService(event);
      unsubscribe = service.watchDocuments((documents) => {
        event.sender.send('document-service:documents-changed', documents);
      });
    } catch (error) {
      console.error('[DocumentService] watch failed to start:', error);
      event.sender.send('document-service:documents-changed', []);
    }

    if (unsubscribe) {
      // Clean up when renderer is destroyed
      event.sender.once('destroyed', unsubscribe);
    }
  });

  // Metadata IPC handlers
  safeHandle('document-service:metadata-get', async (event, id: string) => {
    try {
      return await requireDocumentService(event).getDocumentMetadata(id);
    } catch (error) {
      console.error('[DocumentService] metadata-get failed:', error);
      return null;
    }
  });

  safeHandle('document-service:metadata-get-by-path', async (event, path: string) => {
    try {
      return await requireDocumentService(event).getDocumentMetadataByPath(path);
    } catch (error) {
      console.error('[DocumentService] metadata-get-by-path failed:', error);
      return null;
    }
  });

  safeHandle('document-service:metadata-list', async (event) => {
    try {
      // console.log('[DocumentService] metadata-list IPC handler called');
      const service = requireDocumentService(event);
      // console.log('[DocumentService] Got service:', !!service);
      const result = await service.listDocumentMetadata();
      // console.log('[DocumentService] Returning metadata:', result.length);
      return result;
    } catch (error) {
      console.error('[DocumentService] metadata-list failed:', error);
      return [];
    }
  });

  safeHandle('document-service:notify-frontmatter-changed', async (event, payload: { path: string; frontmatter: Record<string, unknown> }) => {
    try {
      const { path, frontmatter } = payload;
      requireDocumentService(event).notifyFrontmatterChanged(path, frontmatter);
      return { success: true };
    } catch (error) {
      console.error('[DocumentService] notify-frontmatter-changed failed:', error);
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  });

  safeHandle('document-service:refresh-file-metadata', async (event, filePath: string) => {
    try {
      await requireDocumentService(event).refreshFileMetadata(filePath);
      return { success: true };
    } catch (error) {
      console.error('[DocumentService] refresh-file-metadata failed:', error);
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  });

  // Handle metadata watch subscriptions
  // Track per-sender metadata watch subscriptions to prevent stacking on HMR
  const metadataWatchBySender = new WeakMap<Electron.WebContents, () => void>();

  safeOn('document-service:metadata-watch', (event) => {
    // Unsubscribe previous watcher for this sender (prevents stacking on HMR)
    const prevUnsub = metadataWatchBySender.get(event.sender);
    if (prevUnsub) prevUnsub();

    let unsubscribe: (() => void) | undefined;
    try {
      const service = requireDocumentService(event);
      unsubscribe = service.watchDocumentMetadata((change) => {
        event.sender.send('document-service:metadata-changed', change);
      });
    } catch (error) {
      console.error('[DocumentService] metadata-watch failed to start:', error);
    }

    if (unsubscribe) {
      metadataWatchBySender.set(event.sender, unsubscribe);
      event.sender.once('destroyed', () => {
        unsubscribe!();
        metadataWatchBySender.delete(event.sender);
      });
    }
  });

  // Refresh workspace data (scan documents and update tracker/metadata caches)
  safeHandle('document-service:refresh-workspace', async (event) => {
    try {
      await requireDocumentService(event).refreshWorkspaceData();
      return { success: true };
    } catch (error) {
      console.error('[DocumentService] refresh-workspace failed:', error);
      return { success: false, error: String(error) };
    }
  });

  // Virtual document handler
  safeHandle('document-service:load-virtual', async (event, virtualPath: string) => {
    try {
      return await requireDocumentService(event).loadVirtualDocument(virtualPath);
    } catch (error) {
      console.error('[DocumentService] load-virtual failed:', error);
      return null;
    }
  });

  // Tracker items handlers
  safeHandle('document-service:tracker-items-list', async (event) => {
    try {
      return await requireDocumentService(event).listTrackerItems();
    } catch (error) {
      console.error('[DocumentService] tracker-items-list failed:', error);
      return [];
    }
  });

  safeHandle('document-service:tracker-items-by-type', async (event, type: TrackerItemType) => {
    try {
      return await requireDocumentService(event).getTrackerItemsByType(type);
    } catch (error) {
      console.error('[DocumentService] tracker-items-by-type failed:', error);
      return [];
    }
  });

  safeHandle('document-service:tracker-items-by-module', async (event, module: string) => {
    try {
      return await requireDocumentService(event).getTrackerItemsByModule(module);
    } catch (error) {
      console.error('[DocumentService] tracker-items-by-module failed:', error);
      return [];
    }
  });

  // Track per-sender tracker item watch subscriptions to prevent stacking on HMR
  const trackerWatchBySender = new WeakMap<Electron.WebContents, () => void>();

  safeOn('document-service:tracker-items-watch', (event) => {
    // Unsubscribe previous watcher for this sender (prevents stacking on HMR)
    const prevUnsub = trackerWatchBySender.get(event.sender);
    if (prevUnsub) prevUnsub();

    let unsubscribe: (() => void) | undefined;
    try {
      const service = requireDocumentService(event);
      unsubscribe = service.watchTrackerItems((change: TrackerItemChangeEvent) => {
        event.sender.send('document-service:tracker-items-changed', change);
      });
    } catch (error) {
      console.error('[DocumentService] tracker-items-watch failed to start:', error);
    }

    if (unsubscribe) {
      trackerWatchBySender.set(event.sender, unsubscribe);
      event.sender.once('destroyed', () => {
        unsubscribe!();
        trackerWatchBySender.delete(event.sender);
      });
    }
  });

  // Tracker item sync status update
  safeHandle('document-service:tracker-item-update-sync-status', async (event, payload: { itemId: string; syncStatus: string }) => {
    try {
      const { itemId, syncStatus } = payload;
      await requireDocumentService(event).updateTrackerItemSyncStatus(itemId, syncStatus);
      return { success: true };
    } catch (error) {
      console.error('[DocumentService] tracker-item-update-sync-status failed:', error);
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  });

  // Get the current user's TrackerIdentity for "my items" filtering
  safeHandle('document-service:get-current-identity', async (event) => {
    try {
      // getCurrentIdentity imported statically at top of file
      const service = resolveDocumentService?.(event);
      // Pass workspace path for git config resolution if available
      const workspacePath = (service as any)?.workspacePath as string | undefined;
      return { success: true, identity: getCurrentIdentity(workspacePath) };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  });

  // Create tracker item directly in PGLite (bypassing markdown files)
  safeHandle('document-service:create-tracker-item', async (event, payload: {
    id: string;
    type: string;
    title: string;
    status: string;
    priority: string;
    workspace: string;
    description?: string;
    owner?: string;
    tags?: string[];
    customFields?: Record<string, any>;
    syncMode?: string;
  }) => {
    try {
      const syncPolicy = getEffectiveTrackerSyncPolicy(payload.workspace, payload.type, payload.syncMode);
      // console.log('[DocumentService] create-tracker-item called:', {
      //   id: payload.id,
      //   type: payload.type,
      //   requestedSyncMode: payload.syncMode,
      //   effectiveSyncPolicy: syncPolicy,
      //   workspace: payload.workspace,
      // });
      const item = await requireDocumentService(event).createTrackerItem(payload);
      // console.log('[DocumentService] create-tracker-item created locally:', item.id);

      if (shouldSyncTrackerPolicy(syncPolicy)) {
        const active = isTrackerSyncActive(payload.workspace);
        // console.log('[DocumentService] create-tracker-item sync check:', { syncPolicy, active });
        if (active) {
          try {
            await syncTrackerItem(item);
            // console.log('[DocumentService] create-tracker-item synced to TrackerRoom:', item.id);
          } catch (syncErr) {
            console.error('[DocumentService] create-tracker-item sync failed (item still created locally):', syncErr);
          }
        }
      }

      return { success: true, item };
    } catch (error) {
      console.error('[DocumentService] create-tracker-item failed:', error);
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  });

  // Update tracker item fields
  safeHandle('document-service:update-tracker-item', async (event, payload: {
    itemId: string;
    updates: Record<string, any>;
    syncMode?: string;
  }) => {
    try {
      // console.log('[DocumentService] update-tracker-item:', {
      //   itemId: payload.itemId,
      //   requestedSyncMode: payload.syncMode,
      //   updateKeys: Object.keys(payload.updates),
      // });
      const item = await requireDocumentService(event).updateTrackerItem(payload.itemId, payload.updates);
      const syncPolicy = getEffectiveTrackerSyncPolicy(item.workspace, item.type, payload.syncMode);

      if (shouldSyncTrackerPolicy(syncPolicy)) {
        const syncActive = isTrackerSyncActive(item.workspace);
        // console.log('[DocumentService] update-tracker-item sync gate:', { syncPolicy, workspace: item.workspace, syncActive });
        try {
          if (syncActive) {
            await syncTrackerItem(item);
            // console.log('[DocumentService] update-tracker-item synced:', item.id);
          } else {
            await requireDocumentService(event).updateTrackerItemSyncStatus(item.id, 'pending');
            // console.log('[DocumentService] update-tracker-item skipped: sync not active for workspace');
          }
        } catch (syncErr) {
          console.error('[DocumentService] update-tracker-item sync failed:', syncErr);
        }
      } else {
        // console.log('[DocumentService] update-tracker-item no sync: effective mode =', syncPolicy.mode);
      }

      return { success: true, item };
    } catch (error) {
      console.error('[DocumentService] update-tracker-item failed:', error);
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  });

  // Update tracker item content (Lexical editor state)
  safeHandle('document-service:tracker-item-update-content', async (event, payload: {
    itemId: string;
    content: any;
  }) => {
    try {
      await requireDocumentService(event).updateTrackerItemContent(payload.itemId, payload.content);

      // Trigger sync; the new sync engine orders writes by server-assigned syncId.
      try {
        const row = await database.query<any>(
          `SELECT workspace, type FROM tracker_items WHERE id = $1`,
          [payload.itemId],
        );
        if (row.rows.length > 0) {
          await syncAfterCommentMutation(event, payload.itemId, row.rows[0].workspace, row.rows[0].type);
        }
      } catch (syncErr) {
        console.error('[DocumentService] content sync failed:', syncErr);
      }

      return { success: true };
    } catch (error) {
      console.error('[DocumentService] tracker-item-update-content failed:', error);
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  });

  // Get tracker item content (Lexical editor state)
  safeHandle('document-service:tracker-item-get-content', async (event, payload: {
    itemId: string;
  }) => {
    try {
      const content = await requireDocumentService(event).getTrackerItemContent(payload.itemId);
      return { success: true, content };
    } catch (error) {
      console.error('[DocumentService] tracker-item-get-content failed:', error);
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  });

  // Latest body cache row for an item -- cold-open paint path. Returns
  // { bodyVersion, content } so the renderer can paint authoritative
  // content while the DocumentRoom Y.Doc connects in the background.
  safeHandle('document-service:get-tracker-body-cache-for-detail', async (event, payload: {
    itemId: string;
  }) => {
    try {
      const row = await requireDocumentService(event).getTrackerBodyCacheLatest(payload.itemId);
      return { success: true, row };
    } catch (error) {
      console.error('[DocumentService] get-tracker-body-cache-for-detail failed:', error);
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  });

  // Archive/unarchive tracker item
  safeHandle('document-service:tracker-item-archive', async (event, payload: {
    itemId: string;
    archive: boolean;
  }) => {
    try {
      const item = await requireDocumentService(event).archiveTrackerItem(payload.itemId, payload.archive);
      return { success: true, item };
    } catch (error) {
      console.error('[DocumentService] tracker-item-archive failed:', error);
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  });

  // Delete tracker item permanently
  safeHandle('document-service:tracker-item-delete', async (event, payload: {
    itemId: string;
  }) => {
    try {
      await requireDocumentService(event).deleteTrackerItem(payload.itemId);
      return { success: true };
    } catch (error) {
      console.error('[DocumentService] tracker-item-delete failed:', error);
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  });

  // Update tracker item in source file (frontmatter)
  safeHandle('document-service:tracker-item-update-in-file', async (event, payload: {
    itemId: string;
    updates: Record<string, any>;
  }) => {
    try {
      const item = await requireDocumentService(event).updateTrackerItemInFile(payload.itemId, payload.updates);
      return { success: true, item };
    } catch (error) {
      console.error('[DocumentService] tracker-item-update-in-file failed:', error);
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  });

  // Import tracker item from file
  safeHandle('document-service:tracker-item-import-file', async (event, payload: {
    relativePath: string;
    skipDuplicates?: boolean;
  }) => {
    try {
      const result = await requireDocumentService(event).importTrackerItemFromFile(
        payload.relativePath,
        { skipDuplicates: payload.skipDuplicates }
      );
      return { success: true, ...result };
    } catch (error) {
      console.error('[DocumentService] tracker-item-import-file failed:', error);
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  });

  // Bulk import tracker items from directory
  safeHandle('document-service:tracker-item-bulk-import', async (event, payload: {
    directory: string;
    skipDuplicates?: boolean;
    recursive?: boolean;
  }) => {
    try {
      const result = await requireDocumentService(event).bulkImportTrackerItems(
        payload.directory,
        { skipDuplicates: payload.skipDuplicates, recursive: payload.recursive }
      );
      return { success: true, ...result };
    } catch (error) {
      console.error('[DocumentService] tracker-item-bulk-import failed:', error);
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  });

  /** Trigger sync for a tracker item after a local mutation (same pattern as update-tracker-item) */
  async function syncAfterCommentMutation(event: IpcMainInvokeEvent, itemId: string, workspace: string, itemType: string): Promise<void> {
    try {
      const syncPolicy = getEffectiveTrackerSyncPolicy(workspace, itemType as any);
      if (shouldSyncTrackerPolicy(syncPolicy)) {
        if (isTrackerSyncActive(workspace)) {
          const service = requireDocumentService(event);
          const item = await service.getTrackerItemById(itemId);
          if (item) {
            await syncTrackerItem(item);
          }
        } else {
          await requireDocumentService(event).updateTrackerItemSyncStatus(itemId, 'pending');
        }
      }
    } catch (syncErr) {
      console.error('[DocumentService] comment sync failed:', syncErr);
    }
  }

  /** Re-read a tracker item from DB and broadcast change to the event sender */
  async function broadcastTrackerItemUpdate(event: IpcMainInvokeEvent, itemId: string): Promise<void> {
    try {
      const result = await database.query<any>(`SELECT * FROM tracker_items WHERE id = $1`, [itemId]);
      if (result.rows.length === 0) return;
      const r = result.rows[0];
      const d = parseJsonColumn<Record<string, any>>(r.data) ?? {};
      const parsedTags = parseJsonColumn<string[]>(r.type_tags);
      const typeTags: string[] =
        Array.isArray(parsedTags) && parsedTags.length > 0 ? parsedTags : [r.type];
      const item: TrackerItem = {
        id: r.id, issueNumber: r.issue_number ?? undefined, issueKey: r.issue_key ?? undefined,
        type: r.type, typeTags, title: d.title || r.title, description: d.description || undefined,
        status: d.status || r.status, priority: d.priority || undefined, owner: d.owner || undefined,
        module: r.document_path, lineNumber: r.line_number || undefined, workspace: r.workspace,
        tags: d.tags || undefined, created: d.created || r.created || undefined,
        updated: d.updated || r.updated || undefined, dueDate: d.dueDate || undefined,
        lastIndexed: new Date(r.last_indexed), content: r.content || undefined,
        archived: r.archived ?? false,
        archivedAt: r.archived_at ? new Date(r.archived_at).toISOString() : undefined,
        source: r.source || (r.document_path ? 'inline' : 'native'),
        sourceRef: r.source_ref || undefined,
        authorIdentity: d.authorIdentity || undefined, lastModifiedBy: d.lastModifiedBy || undefined,
        createdByAgent: d.createdByAgent || false,
        assigneeEmail: d.assigneeEmail || undefined, reporterEmail: d.reporterEmail || undefined,
        assigneeId: d.assigneeId || undefined, reporterId: d.reporterId || undefined,
        labels: d.labels || undefined, linkedSessions: d.linkedSessions || undefined,
        linkedCommitSha: d.linkedCommitSha || undefined, documentId: d.documentId || undefined,
        syncStatus: r.sync_status || 'local',
      };
      // Pass through extra JSONB data fields (activity, comments, etc.)
      // Uses the item's own keys as the "known" set -- no hardcoded list.
      const itemKeys = new Set(Object.keys(item));
      const extra: Record<string, any> = {};
      for (const [k, v] of Object.entries(d)) {
        if (v !== undefined && !itemKeys.has(k)) extra[k] = v;
      }
      if (Object.keys(extra).length > 0) (item as any).customFields = extra;
      event.sender.send('document-service:tracker-items-changed', {
        added: [], updated: [item], removed: [], timestamp: new Date(),
      });
    } catch { /* best-effort */ }
  }

  // Comment management handlers
  safeHandle('document-service:tracker-item-add-comment', async (event, payload: {
    itemId: string;
    body: string;
  }) => {
    try {
      const row = await database.query<any>(`SELECT * FROM tracker_items WHERE id = $1`, [payload.itemId]);
      if (row.rows.length === 0) return { success: false, error: 'Item not found' };

      const data = typeof row.rows[0].data === 'string' ? JSON.parse(row.rows[0].data) : row.rows[0].data || {};
      // getCurrentIdentity imported statically at top of file
      const authorIdentity = getCurrentIdentity(row.rows[0].workspace);

      const comments = data.comments || [];
      const commentId = `comment_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      comments.push({
        id: commentId,
        authorIdentity,
        body: payload.body,
        createdAt: Date.now(),
        updatedAt: null,
        deleted: false,
      });
      data.comments = comments;
      data.lastModifiedBy = authorIdentity;

      // Record activity for the comment
      const activity = data.activity || [];
      activity.push({
        id: `activity_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
        authorIdentity,
        action: 'commented',
        timestamp: Date.now(),
      });
      data.activity = activity.length > 100 ? activity.slice(-100) : activity;

      await database.query(
        `UPDATE tracker_items SET data = $1, updated = NOW() WHERE id = $2`,
        [JSON.stringify(data), payload.itemId]
      );

      // Re-read updated row and broadcast so UI refreshes
      await broadcastTrackerItemUpdate(event, payload.itemId);

      // Trigger sync
      await syncAfterCommentMutation(event, payload.itemId, row.rows[0].workspace, row.rows[0].type);

      return { success: true, commentId };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  });

  safeHandle('document-service:tracker-item-update-comment', async (event, payload: {
    itemId: string;
    commentId: string;
    body?: string;
    deleted?: boolean;
  }) => {
    try {
      const row = await database.query<any>(`SELECT * FROM tracker_items WHERE id = $1`, [payload.itemId]);
      if (row.rows.length === 0) return { success: false, error: 'Item not found' };

      const data = typeof row.rows[0].data === 'string' ? JSON.parse(row.rows[0].data) : row.rows[0].data || {};
      const comments = data.comments || [];
      const idx = comments.findIndex((c: any) => c.id === payload.commentId);
      if (idx === -1) return { success: false, error: 'Comment not found' };

      if (payload.body !== undefined) {
        comments[idx].body = payload.body;
        comments[idx].updatedAt = Date.now();
      }
      if (payload.deleted !== undefined) {
        comments[idx].deleted = payload.deleted;
      }
      data.comments = comments;

      await database.query(
        `UPDATE tracker_items SET data = $1, updated = NOW() WHERE id = $2`,
        [JSON.stringify(data), payload.itemId]
      );

      // Re-read updated row and broadcast so UI refreshes
      await broadcastTrackerItemUpdate(event, payload.itemId);

      // Trigger sync
      await syncAfterCommentMutation(event, payload.itemId, row.rows[0].workspace, row.rows[0].type);

      return { success: true };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  });

  // Asset management handlers
  safeHandle('document-service:store-asset', async (event, payload: { buffer: number[]; mimeType: string; documentPath?: string }) => {
    try {
      const { buffer, mimeType, documentPath } = payload;
      const bufferObj = Buffer.from(buffer);
      return await requireDocumentService(event).storeAsset(bufferObj, mimeType, documentPath);
    } catch (error) {
      console.error('[DocumentService] store-asset failed:', error);
      throw error;
    }
  });

  safeHandle('document-service:get-asset-path', async (event, hash: string) => {
    try {
      return await requireDocumentService(event).getAssetPath(hash);
    } catch (error) {
      console.error('[DocumentService] get-asset-path failed:', error);
      return null;
    }
  });

  safeHandle('document-service:gc-assets', async (event) => {
    try {
      return await requireDocumentService(event).garbageCollectAssets();
    } catch (error) {
      console.error('[DocumentService] gc-assets failed:', error);
      return 0;
    }
  });
}

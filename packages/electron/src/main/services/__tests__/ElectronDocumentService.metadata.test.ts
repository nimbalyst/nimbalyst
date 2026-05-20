import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';

// ElectronDocumentService transitively imports TrackerSyncManager, which pulls
// in the database initializer and the workspace watcher chain. Those modules
// touch Electron's `app` global at module load (auto-updater singleton,
// `app.on('before-quit')`, `app.isPackaged`) which is undefined in vitest's
// node environment. Mock the upstream modules so the import chain evaluates
// cleanly -- matches the pattern used in the sibling inlineIdentity and
// trackerSync tests.
vi.mock('../../database/PGLiteDatabaseWorker', () => ({
  database: {
    query: vi.fn(),
  },
}));

vi.mock('../TrackerSyncManager', () => ({
  syncTrackerItem: vi.fn(),
  unsyncTrackerItem: vi.fn(),
  isTrackerSyncActive: vi.fn(() => false),
}));

import { ElectronDocumentService } from '../ElectronDocumentService';
import type { MetadataChangeEvent } from '@nimbalyst/runtime';

describe('ElectronDocumentService - Metadata Cache', () => {
  let tempDir: string;
  let service: ElectronDocumentService;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'doc-service-test-'));
  });

  afterEach(async () => {
    if (service) {
      service.destroy();
    }
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  async function createTestFile(filename: string, content: string): Promise<string> {
    const filePath = path.join(tempDir, filename);
    await fs.writeFile(filePath, content);
    return filePath;
  }

  describe('metadata extraction', () => {
    it('should extract metadata from documents with frontmatter', async () => {
      await createTestFile('doc1.md', `---
title: Document 1
tags: [test, metadata]
priority: high
---

# Content`);

      await createTestFile('doc2.md', `---
title: Document 2
aiSummary: This is an AI generated summary
---

# More content`);

      service = new ElectronDocumentService(tempDir);
      await service.refreshWorkspaceData();

      const metadata = await service.listDocumentMetadata();

      expect(metadata).toHaveLength(2);

      const doc1Meta = metadata.find(m => m.path === 'doc1.md');
      expect(doc1Meta).toBeTruthy();
      expect(doc1Meta?.frontmatter.title).toBe('Document 1');
      expect(doc1Meta?.frontmatter.priority).toBe('high');
      expect(doc1Meta?.tags).toEqual(['test', 'metadata']);

      const doc2Meta = metadata.find(m => m.path === 'doc2.md');
      expect(doc2Meta).toBeTruthy();
      expect(doc2Meta?.frontmatter.title).toBe('Document 2');
      expect(doc2Meta?.summary).toBe('This is an AI generated summary');
    });

    it('should handle documents without frontmatter', async () => {
      await createTestFile('no-frontmatter.md', '# Just content\n\nNo frontmatter here');

      service = new ElectronDocumentService(tempDir);
      await service.refreshWorkspaceData();

      const metadata = await service.listDocumentMetadata();

      expect(metadata).toHaveLength(1);
      expect(metadata[0].frontmatter).toEqual({});
      expect(metadata[0].summary).toBeUndefined();
      expect(metadata[0].tags).toBeUndefined();
    });
  });

  describe('metadata caching', () => {
    it('should only re-parse when frontmatter changes', async () => {
      const filePath = await createTestFile('cached.md', `---
title: Original Title
version: 1
---

# Content`);

      service = new ElectronDocumentService(tempDir);
      await service.refreshWorkspaceData();

      const metadata1 = await service.listDocumentMetadata();
      const hash1 = metadata1[0].hash;

      // Update content but not frontmatter
      // Bump mtime by 1s so the cache detects a file change
      await fs.writeFile(filePath, `---
title: Original Title
version: 1
---

# Updated content but same frontmatter`);
      await fs.utimes(filePath, new Date(), new Date(Date.now() + 1000));

      // Trigger refresh
      await service.refreshWorkspaceData();

      const metadata2 = await service.listDocumentMetadata();
      const hash2 = metadata2[0].hash;

      expect(hash1).toBe(hash2);

      // Now update frontmatter
      await fs.writeFile(filePath, `---
title: Updated Title
version: 2
---

# Content`);
      await fs.utimes(filePath, new Date(), new Date(Date.now() + 2000));

      // Trigger refresh
      await service.refreshWorkspaceData();

      const metadata3 = await service.listDocumentMetadata();
      const hash3 = metadata3[0].hash;

      expect(hash3).not.toBe(hash1);
      expect(metadata3[0].frontmatter.title).toBe('Updated Title');
    });
  });

  describe('metadata API methods', () => {
    beforeEach(async () => {
      await createTestFile('api-test.md', `---
id: test-123
title: API Test Document
tags: [api, test]
---

Content`);

      service = new ElectronDocumentService(tempDir);

      await service.listDocumentMetadata();
    });

    it('should get metadata by document ID', async () => {
      const docs = await service.listDocuments();
      const doc = docs[0];

      const metadata = await service.getDocumentMetadata(doc.id);

      expect(metadata).toBeTruthy();
      expect(metadata?.frontmatter.title).toBe('API Test Document');
    });

    it('should get metadata by path', async () => {
      const metadata = await service.getDocumentMetadataByPath('api-test.md');

      expect(metadata).toBeTruthy();
      expect(metadata?.frontmatter.title).toBe('API Test Document');
    });

    it('should return null for non-existent documents', async () => {
      const metadata = await service.getDocumentMetadata('non-existent-id');
      expect(metadata).toBeNull();

      const metadataByPath = await service.getDocumentMetadataByPath('non-existent.md');
      expect(metadataByPath).toBeNull();
    });
  });

  describe('metadata change notifications', () => {
    it('should notify when frontmatter is updated programmatically', async () => {
      await createTestFile('notify-test.md', `---
title: Original
status: draft
---

Content`);

      service = new ElectronDocumentService(tempDir);
      await service.refreshWorkspaceData();

      // Prime metadata cache before programmatic updates
      const seededMetadata = await service.listDocumentMetadata();
      expect(seededMetadata).toHaveLength(1);
      const notifyPath = seededMetadata[0].path;

      const changeEvents: MetadataChangeEvent[] = [];
      const unsubscribe = service.watchDocumentMetadata((change) => {
        changeEvents.push(change);
      });

      // Programmatically update frontmatter
      service.notifyFrontmatterChanged(notifyPath, {
        title: 'Updated via API',
        status: 'published',
        aiSummary: 'New AI summary'
      });

      expect(changeEvents).toHaveLength(1);
      expect(changeEvents[0].updated).toHaveLength(1);
      expect(changeEvents[0].updated[0].frontmatter.title).toBe('Updated via API');
      expect(changeEvents[0].updated[0].summary).toBe('New AI summary');

      unsubscribe();
    });

    it('should notify when files are added or removed', async () => {
      service = new ElectronDocumentService(tempDir);

      const changeEvents: MetadataChangeEvent[] = [];
      const unsubscribe = service.watchDocumentMetadata((change) => {
        changeEvents.push(change);
      });

      // Add a new file
      await createTestFile('new-file.md', `---
title: New File
---

Content`);

      // Trigger refresh to detect the change
      await service.refreshWorkspaceData();

      const addEvent = changeEvents.find(e => e.added.length > 0);
      expect(addEvent).toBeTruthy();
      expect(addEvent?.added[0].frontmatter.title).toBe('New File');

      // Remove the file
      await fs.unlink(path.join(tempDir, 'new-file.md'));

      // Trigger refresh to detect the removal
      await service.refreshWorkspaceData();

      const removeEvent = changeEvents.find(e => e.removed.length > 0);
      expect(removeEvent).toBeTruthy();

      unsubscribe();
    });
  });

  describe('plan document support', () => {
    it('should extract metadata from plan frontmatter', async () => {
      await createTestFile('plan.md', `---
planStatus:
  planId: plan-42
  title: Test Plan
  status: in-progress
  tags: [planning, metadata]
  summary: This is a plan summary
---

# Plan content`);

      service = new ElectronDocumentService(tempDir);
      await service.refreshWorkspaceData();

      const metadata = await service.listDocumentMetadata();
      const planMeta = metadata[0];

      expect(planMeta.frontmatter.planStatus).toBeTruthy();
      expect(planMeta.tags).toEqual(['planning', 'metadata']);
      expect(planMeta.summary).toBe('This is a plan summary');
    });
  });
});

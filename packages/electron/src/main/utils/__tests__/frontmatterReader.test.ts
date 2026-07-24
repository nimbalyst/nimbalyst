import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { readFrontmatterOnly, extractFrontmatter, extractCommonFields } from '../frontmatterReader';

describe('frontmatterReader', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'frontmatter-test-'));
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  describe('readFrontmatterOnly', () => {
    it('should read frontmatter from a file', async () => {
      const testFile = path.join(tempDir, 'test.md');
      const content = `---
title: Test Document
tags: [test, metadata]
---

# Main Content

This is the main content of the document.`;

      await fs.writeFile(testFile, content);
      const result = await readFrontmatterOnly(testFile);

      expect(result).toContain('title: Test Document');
      expect(result).toContain('tags: [test, metadata]');
      expect(result).not.toContain('Main Content');
    });

    it('should return null for files without frontmatter', async () => {
      const testFile = path.join(tempDir, 'no-frontmatter.md');
      const content = '# Just a heading\n\nSome content';

      await fs.writeFile(testFile, content);
      const result = await readFrontmatterOnly(testFile);

      expect(result).toBeNull();
    });

    it('should handle large frontmatter by limiting read size', async () => {
      const testFile = path.join(tempDir, 'large.md');
      // Create frontmatter larger than 1024 bytes
      const fields = Array(100).fill(0).map((_, i) => `field${i}: "This is value number ${i}"`).join('\n');
      const largeFrontmatter = `---
title: Large Document
${fields}
---

Content after frontmatter`;

      await fs.writeFile(testFile, largeFrontmatter);
      const result = await readFrontmatterOnly(testFile, 1024);

      // Should return partial content or null if frontmatter end not found in first 1024 bytes
      if (result) {
        expect(result.length).toBeLessThanOrEqual(1024);
      } else {
        // If the closing --- wasn't found in first 1024 bytes, result should be null
        expect(result).toBeNull();
      }
    });
  });

  describe('extractFrontmatter', () => {
    it('should extract and parse frontmatter with hash', async () => {
      const testFile = path.join(tempDir, 'extract.md');
      const content = `---
title: Extract Test
priority: high
tags:
  - metadata
  - cache
---

# Content`;

      await fs.writeFile(testFile, content);
      const result = await extractFrontmatter(testFile);

      expect(result.data).toEqual({
        title: 'Extract Test',
        priority: 'high',
        tags: ['metadata', 'cache']
      });
      expect(result.hash).toBeTruthy();
      expect(result.parseErrors).toBeUndefined();
    });

    it('should handle malformed frontmatter', async () => {
      const testFile = path.join(tempDir, 'malformed.md');
      const content = `---
title: Malformed
invalid yaml [
---

Content`;

      await fs.writeFile(testFile, content);
      const result = await extractFrontmatter(testFile);

      // Should return error for malformed YAML
      expect(result.data).toBeNull();
      expect(result.hash).toBeNull();
      expect(result.parseErrors).toBeDefined();
      expect(result.parseErrors![0]).toContain('YAML parsing error');
    });

    it('should generate consistent hash for same frontmatter', async () => {
      const testFile = path.join(tempDir, 'hash-test.md');
      const content = `---
title: Hash Test
order: 1
---

Content`;

      await fs.writeFile(testFile, content);
      const result1 = await extractFrontmatter(testFile);
      const result2 = await extractFrontmatter(testFile);

      expect(result1.hash).toBe(result2.hash);
    });
  });

  describe('extractCommonFields', () => {
    it('should extract summary from aiSummary field', () => {
      const frontmatter = {
        title: 'Test',
        aiSummary: 'This is an AI generated summary',
        tags: ['test', 'metadata']
      };

      const result = extractCommonFields(frontmatter);

      expect(result.summary).toBe('This is an AI generated summary');
      expect(result.tags).toEqual(['test', 'metadata']);
    });

    it('should extract summary from alternative fields', () => {
      const frontmatter = {
        title: 'Test',
        description: 'This is a description',
        tags: 'tag1, tag2, tag3'
      };

      const result = extractCommonFields(frontmatter);

      expect(result.summary).toBe('This is a description');
      expect(result.tags).toEqual(['tag1', 'tag2', 'tag3']);
    });

    it('should extract from planStatus object', () => {
      const frontmatter = {
        planStatus: {
          summary: 'Plan summary',
          tags: ['planning', 'documentation']
        }
      };

      const result = extractCommonFields(frontmatter);

      expect(result.summary).toBe('Plan summary');
      expect(result.tags).toEqual(['planning', 'documentation']);
    });

    it('should handle missing fields gracefully', () => {
      const frontmatter = {
        title: 'Test'
      };

      const result = extractCommonFields(frontmatter);

      expect(result.summary).toBeUndefined();
      expect(result.tags).toBeUndefined();
    });
  });
});
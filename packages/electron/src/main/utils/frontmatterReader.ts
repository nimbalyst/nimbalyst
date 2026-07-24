import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import * as yaml from 'js-yaml';

/**
 * File extensions where --- delimiters contain code (not YAML).
 * These use the same --- syntax but the content is JavaScript/TypeScript.
 */
const NON_YAML_FRONTMATTER_EXTENSIONS = new Set(['.astro']);

/**
 * Reads only the frontmatter portion of a file using bounded reads
 * @param filePath Absolute path to the file
 * @param maxBytes Maximum bytes to read (default 4096 = 4KB)
 * @returns The frontmatter string or null if not found
 */
export async function readFrontmatterOnly(filePath: string, maxBytes: number = 4096): Promise<string | null> {
  return new Promise((resolve, reject) => {
    const stream = fs.createReadStream(filePath, {
      encoding: 'utf8',
      start: 0,
      end: maxBytes - 1
    });

    let content = '';
    let foundEnd = false;
    let resolved = false;

    const cleanup = () => {
      if (!resolved) {
        resolved = true;
        stream.destroy();
      }
    };

    stream.on('data', (chunk: string | Buffer) => {
      const chunkStr = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
      content += chunkStr;

      // Check if we have the complete frontmatter
      if (content.startsWith('---\n') || content.startsWith('---\r\n')) {
        // Look for the closing ---
        const endPattern = /\n---\s*(\n|$)/;
        const match = endPattern.exec(content);

        if (match) {
          foundEnd = true;
          const endIndex = match.index + match[0].length;
          content = content.substring(0, endIndex);
          cleanup();
          resolve(content);
        }
      } else if (!content.startsWith('---')) {
        // No frontmatter at all
        cleanup();
        resolve(null);
      }
    });

    stream.on('end', () => {
      if (!resolved) {
        resolved = true;
        if (foundEnd || (content.startsWith('---') && content.includes('\n---'))) {
          resolve(content);
        } else {
          resolve(null);
        }
      }
    });

    stream.on('error', (error) => {
      if (!resolved) {
        resolved = true;
        reject(error);
      }
    });

    stream.on('close', () => {
      if (!resolved) {
        resolved = true;
        resolve(null);
      }
    });
  });
}

/**
 * Extracts and parses frontmatter from a file
 * @param filePath Absolute path to the file
 * @returns Parsed frontmatter data or null
 */
export async function extractFrontmatter(filePath: string): Promise<{
  data: Record<string, unknown> | null;
  hash: string | null;
  parseErrors?: string[];
}> {
  try {
    // Skip files where --- delimiters contain code, not YAML
    const ext = path.extname(filePath).toLowerCase();
    if (NON_YAML_FRONTMATTER_EXTENSIONS.has(ext)) {
      return { data: null, hash: null };
    }

    // console.log(`[FrontmatterReader] Reading frontmatter from: ${filePath}`);
    const frontmatterContent = await readFrontmatterOnly(filePath);

    if (!frontmatterContent) {
      // console.log(`[FrontmatterReader] No frontmatter found in: ${filePath}`);
      return { data: null, hash: null };
    }

    // console.log(`[FrontmatterReader] Found frontmatter content (${frontmatterContent.length} chars) in: ${filePath}`);

    // Extract the YAML content between the --- markers
    const yamlMatch = frontmatterContent.match(/^---\s*\n([\s\S]*?)\n---/);
    if (!yamlMatch) {
      return { data: null, hash: null };
    }

    try {
      // Parse the YAML content
      const data = yaml.load(yamlMatch[1]) as Record<string, unknown>;

      if (data && typeof data === 'object' && !Array.isArray(data)) {
        // Generate hash of the frontmatter data
        // Sort keys recursively for consistent hashing
        const sortedData = JSON.parse(JSON.stringify(data, (key, value) => {
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

        return {
          data,
          hash,
          parseErrors: undefined
        };
      }

      return { data: null, hash: null };
    } catch (yamlError) {
      // If YAML parsing fails, return error but don't crash
      const errorMessage = yamlError instanceof Error ? yamlError.message : String(yamlError);
      return {
        data: null,
        hash: null,
        parseErrors: [`YAML parsing error: ${errorMessage}`]
      };
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    return {
      data: null,
      hash: null,
      parseErrors: [`Failed to extract frontmatter: ${errorMessage}`]
    };
  }
}

/**
 * Extracts common fields from frontmatter for convenience
 */
export function extractCommonFields(frontmatter: Record<string, unknown>): {
  summary?: string;
  tags?: string[];
} {
  const result: { summary?: string; tags?: string[] } = {};

  // Extract summary (check multiple possible keys)
  if (typeof frontmatter.aiSummary === 'string') {
    result.summary = frontmatter.aiSummary;
  } else if (typeof frontmatter.summary === 'string') {
    result.summary = frontmatter.summary;
  } else if (typeof frontmatter.description === 'string') {
    result.summary = frontmatter.description;
  }

  // Extract tags
  if (Array.isArray(frontmatter.tags)) {
    result.tags = frontmatter.tags.filter(tag => typeof tag === 'string');
  } else if (typeof frontmatter.tags === 'string') {
    // Handle comma-separated tags
    result.tags = frontmatter.tags.split(',').map(t => t.trim()).filter(Boolean);
  }

  // Also check in planStatus for plan documents
  if (frontmatter.planStatus && typeof frontmatter.planStatus === 'object') {
    const planStatus = frontmatter.planStatus as Record<string, unknown>;

    if (!result.tags && Array.isArray(planStatus.tags)) {
      result.tags = planStatus.tags.filter(tag => typeof tag === 'string');
    }

    if (!result.summary && typeof planStatus.summary === 'string') {
      result.summary = planStatus.summary;
    }
  }

  return result;
}

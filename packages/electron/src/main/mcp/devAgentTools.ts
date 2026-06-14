/**
 * Read-only developer tools for extension-agent sessions (e.g. gemini-antigravity).
 *
 * A standard (non-meta-agent) extension session is given these tools so the
 * model can investigate the workspace - read files, list directories, grep -
 * through the same simulated JSON tool-call loop the meta-agent path uses. The
 * read tools and write_file are gated on the minimal workspace-files permission;
 * shell execution is a separate tool gated on its own permission.
 *
 * Mirrors metaAgentServer.ts: the same OpenAI-shaped tool list is exposed to the
 * extension backend (which renders tools as JSON in its system prompt), and
 * dispatch goes through the PrivilegedExtensionHost broker. The broker gates
 * `devToolExecutor` on the minimal `workspace-files` permission (NOT the
 * high-risk `nimbalyst-database-write` that meta-agent orchestration needs).
 *
 * SECURITY: dispatchDevAgentTool resolves the filesystem service against the
 * HOST-trusted workspace path the broker supplies (ctx.workspacePath) - NEVER a
 * backend-supplied path - so a compromised backend cannot point the jail root
 * outside the bound workspace. Path traversal WITHIN a call is further blocked
 * by ElectronFileSystemService's SafePathValidator, and reads are size-capped.
 */

import { realpath, writeFile, mkdir } from 'fs/promises';
import { resolve as resolvePath, sep as pathSep, dirname } from 'path';
import type { MetaAgentOpenAITool } from './metaAgentServer';
import { getFileSystemService } from '../window/serviceRegistry';
import { ElectronFileSystemService } from '../services/ElectronFileSystemService';

/**
 * Phase 1 dev-tool names. The extension backend's session executor routes calls
 * with these names to ctx.services.devToolExecutor (workspace-files gate)
 * instead of ctx.services.toolExecutor (db-write gate). Keep in sync with
 * DEV_AGENT_TOOL_DEFS here and the backend's own DEV_AGENT_TOOL_NAMES.
 */
export const DEV_AGENT_TOOL_NAMES = new Set<string>([
  'read_file',
  'list_files',
  'search_files',
  'write_file',
]);

const DEV_AGENT_TOOL_DEFS: Array<{
  name: string;
  description: string;
  inputSchema: { type: 'object'; properties: Record<string, unknown>; required?: string[] };
}> = [
  {
    name: 'read_file',
    description:
      'Read a UTF-8 text file from the workspace. Returns the content with line numbers. Optionally restrict to a line range with start_line/end_line (1-based, inclusive). Very large files are truncated.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Workspace-relative file path, e.g. "src/index.ts".' },
        start_line: { type: 'number', description: 'Optional 1-based first line to return.' },
        end_line: { type: 'number', description: 'Optional 1-based last line to return (inclusive).' },
      },
      required: ['path'],
    },
  },
  {
    name: 'list_files',
    description:
      'List files and directories in the workspace. Without a pattern, lists the immediate contents of `path` (default the workspace root). With a glob `pattern`, lists matching files recursively.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Workspace-relative directory to list. Defaults to the workspace root.' },
        pattern: { type: 'string', description: 'Optional glob, e.g. "**/*.ts". When set, lists matching files recursively.' },
        max_depth: { type: 'number', description: 'Maximum recursion depth for glob listing (default 3).' },
        include_hidden: { type: 'boolean', description: 'Include dotfiles. Defaults to false.' },
      },
    },
  },
  {
    name: 'search_files',
    description:
      'Search file contents across the workspace with ripgrep. Returns matching file:line snippets. Use this to find symbols, strings, or patterns before reading whole files.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'The text or regex to search for.' },
        path: { type: 'string', description: 'Optional workspace-relative directory to scope the search.' },
        file_pattern: { type: 'string', description: 'Optional glob to restrict files, e.g. "*.ts".' },
        case_sensitive: { type: 'boolean', description: 'Case-sensitive search. Defaults to false.' },
        max_results: { type: 'number', description: 'Maximum matches to return (default 50).' },
      },
      required: ['query'],
    },
  },
  {
    name: 'write_file',
    description:
      'Create or overwrite a UTF-8 text file in the workspace. Writes the FULL file content (not a patch) - pass the complete intended contents. Parent directories are created automatically. When modifying an existing file, read_file it first, then write the complete updated contents.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Workspace-relative file path to write, e.g. "src/index.ts".' },
        content: { type: 'string', description: 'The complete UTF-8 text content to write to the file.' },
      },
      required: ['path', 'content'],
    },
  },
  {
    name: 'run_command',
    description:
      'Run a shell command in the workspace root and return its stdout, stderr, and exit code. Use this for git, build, and test commands the file tools do not cover, e.g. "git clone <url>", "npm test", "git status". Runs non-interactively with a time limit; output is truncated if very large.',
    inputSchema: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'The shell command to run, e.g. "git status" or "git clone https://github.com/owner/repo".' },
      },
      required: ['command'],
    },
  },
];

/**
 * Return the read-only dev tools in OpenAI function-calling shape. The
 * extension backend renders these as JSON in its tool-loop system prompt. Same
 * shape as getMetaAgentOpenAITools so the two share the MetaAgentOpenAITool type.
 */
export function getDevAgentOpenAITools(): MetaAgentOpenAITool[] {
  return DEV_AGENT_TOOL_DEFS.map((t) => ({
    type: 'function',
    function: {
      name: t.name,
      description: t.description,
      parameters: t.inputSchema as Record<string, unknown>,
    },
  }));
}

// Cap formatted tool output so a single read/list/search can't blow the model's
// context window. The model gets a truncation note when this trips.
const MAX_RESULT_CHARS = 48_000;

function clamp(text: string): string {
  if (text.length <= MAX_RESULT_CHARS) return text;
  return `${text.slice(0, MAX_RESULT_CHARS)}\n\n[output truncated at ${MAX_RESULT_CHARS} characters]`;
}

function asString(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}
function asNumber(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}
function asBool(v: unknown): boolean | undefined {
  return typeof v === 'boolean' ? v : undefined;
}

/**
 * Defense-in-depth against symlink jail-escape. SafePathValidator does
 * string-only validation and never resolves symlinks, so a symlink that lives
 * INSIDE the workspace but points outside it would otherwise be followed by the
 * underlying fs read/list. Resolve the real path and re-check containment
 * against the workspace's real path before the FS service touches it.
 *
 * Scoped to the dev-tool surface (the new, prompt-injectable model input) so
 * shared-service consumers - e.g. pnpm's symlinked node_modules - keep their
 * existing behavior. Returns an error string if `relPath` resolves outside the
 * workspace; null if it is safe or does not exist yet (the FS service then
 * surfaces the not-found error).
 */
async function assertInsideWorkspace(
  workspaceRoot: string,
  relPath: string
): Promise<string | null> {
  let realRoot: string;
  try {
    realRoot = await realpath(workspaceRoot);
  } catch {
    realRoot = resolvePath(workspaceRoot);
  }
  const target = resolvePath(realRoot, relPath);
  let realTarget: string;
  try {
    realTarget = await realpath(target);
  } catch {
    // Target (or a path component) does not exist - nothing to read; let the FS
    // service report the not-found error.
    return null;
  }
  const inside = realTarget === realRoot || realTarget.startsWith(realRoot + pathSep);
  return inside
    ? null
    : `Error: "${relPath}" resolves outside the workspace (symlink escape blocked).`;
}

// Cap a single write so a runaway model can't fill the disk.
const MAX_WRITE_BYTES = 5 * 1024 * 1024;

/**
 * Containment check for WRITES. assertInsideWorkspace realpaths the target and
 * so requires it to exist; a file being created does not. This variant verifies
 * the RESOLVED path is inside the workspace without requiring existence, and
 * realpaths the nearest existing ancestor to block symlink-escape via an
 * existing symlinked parent. Returns the absolute path to write, or an error.
 */
async function resolveWritePath(
  workspaceRoot: string,
  relPath: string
): Promise<{ absPath: string } | { error: string }> {
  let realRoot: string;
  try {
    realRoot = await realpath(workspaceRoot);
  } catch {
    realRoot = resolvePath(workspaceRoot);
  }
  const target = resolvePath(realRoot, relPath);
  if (target !== realRoot && !target.startsWith(realRoot + pathSep)) {
    return { error: `Error: "${relPath}" resolves outside the workspace; refusing to write.` };
  }
  // If the target itself already exists, resolve it (following symlinks) and
  // require the real path to stay inside the workspace. writeFile follows
  // symlinks, so without this an existing symlink whose link file is inside the
  // workspace but points outside would let the write escape the jail - the read
  // guard assertInsideWorkspace realpaths the target for exactly this reason.
  try {
    const realTarget = await realpath(target);
    if (realTarget !== realRoot && !realTarget.startsWith(realRoot + pathSep)) {
      return { error: `Error: "${relPath}" resolves outside the workspace (symlink escape blocked).` };
    }
  } catch {
    // Target does not exist yet; the ancestor chain is validated below.
  }
  // Walk up to the nearest existing ancestor; its real path must stay inside.
  let ancestor = dirname(target);
  for (let i = 0; i < 64; i++) {
    try {
      const realAncestor = await realpath(ancestor);
      if (realAncestor !== realRoot && !realAncestor.startsWith(realRoot + pathSep)) {
        return { error: `Error: "${relPath}" resolves outside the workspace (symlink escape blocked).` };
      }
      break;
    } catch {
      const parent = dirname(ancestor);
      if (parent === ancestor) break;
      ancestor = parent;
    }
  }
  return { absPath: target };
}

/**
 * Dispatch a read-only dev tool and return formatted text for the model.
 *
 * `workspaceRoot` MUST be the HOST-trusted workspace path (the broker passes
 * ctx.workspacePath). Callers must NOT forward a backend-supplied path here, or
 * the workspace jail could be redirected. The service is looked up from the
 * per-workspace registry, falling back to a freshly constructed service bound
 * to the same root (the constructor wires the SafePathValidator jail).
 */
export async function dispatchDevAgentTool(
  name: string,
  workspaceRoot: string,
  args: Record<string, unknown>
): Promise<string> {
  const svc = getFileSystemService(workspaceRoot) ?? new ElectronFileSystemService(workspaceRoot);

  switch (name) {
    case 'read_file': {
      const filePath = asString(args.path);
      if (!filePath) return 'Error: read_file requires a "path" argument.';
      const escaped = await assertInsideWorkspace(workspaceRoot, filePath);
      if (escaped) return escaped;
      const res = await svc.readFile(filePath);
      if (!res.success) return `Error reading ${filePath}: ${res.error ?? 'unknown error'}`;
      const allLines = (res.content ?? '').split('\n');
      const startLine = asNumber(args.start_line);
      const endLine = asNumber(args.end_line);
      const offset = startLine && startLine > 0 ? startLine - 1 : 0;
      const end = endLine && endLine > 0 ? endLine : allLines.length;
      const slice = allLines.slice(offset, end);
      const numbered = slice
        .map((line, i) => `${String(offset + i + 1).padStart(5)}  ${line}`)
        .join('\n');
      const truncNote = res.truncated ? '\n[file truncated at the read size cap]' : '';
      const sizeNote = typeof res.size === 'number' ? `, ${res.size} bytes` : '';
      return clamp(`${filePath} (${slice.length} line(s)${sizeNote})\n${numbered}${truncNote}`);
    }
    case 'list_files': {
      const listEscaped = await assertInsideWorkspace(workspaceRoot, asString(args.path) ?? '.');
      if (listEscaped) return listEscaped;
      const res = await svc.listFiles({
        path: asString(args.path),
        pattern: asString(args.pattern),
        maxDepth: asNumber(args.max_depth),
        includeHidden: asBool(args.include_hidden),
      });
      if (!res.success) return `Error listing files: ${res.error ?? 'unknown error'}`;
      const files = res.files ?? [];
      if (files.length === 0) return 'No files found.';
      const body = files
        .map((f) => {
          const kind = f.type === 'directory' ? 'd' : 'f';
          const size = f.type === 'file' && typeof f.size === 'number' ? `  (${f.size}b)` : '';
          return `${kind}  ${f.path}${size}`;
        })
        .join('\n');
      return clamp(`${files.length} entr${files.length === 1 ? 'y' : 'ies'}:\n${body}`);
    }
    case 'search_files': {
      const query = asString(args.query);
      if (!query) return 'Error: search_files requires a "query" argument.';
      const searchEscaped = await assertInsideWorkspace(workspaceRoot, asString(args.path) ?? '.');
      if (searchEscaped) return searchEscaped;
      const res = await svc.searchFiles(query, {
        path: asString(args.path),
        filePattern: asString(args.file_pattern),
        caseSensitive: asBool(args.case_sensitive),
        maxResults: asNumber(args.max_results),
      });
      if (!res.success) return `Error searching: ${res.error ?? 'unknown error'}`;
      const results = res.results ?? [];
      if (results.length === 0) return `No matches for "${query}".`;
      const body = results.map((r) => `${r.file}:${r.line}: ${r.content}`).join('\n');
      return clamp(`${results.length} match(es) for "${query}":\n${body}`);
    }
    case 'write_file': {
      const filePath = asString(args.path);
      if (!filePath) return 'Error: write_file requires a "path" argument.';
      const content = typeof args.content === 'string' ? args.content : undefined;
      if (content === undefined) return 'Error: write_file requires a string "content" argument.';
      const byteLen = Buffer.byteLength(content, 'utf8');
      if (byteLen > MAX_WRITE_BYTES) {
        return `Error: content is ${byteLen} bytes, over the ${MAX_WRITE_BYTES}-byte write cap.`;
      }
      const resolved = await resolveWritePath(workspaceRoot, filePath);
      if ('error' in resolved) return resolved.error;
      try {
        await mkdir(dirname(resolved.absPath), { recursive: true });
        await writeFile(resolved.absPath, content, 'utf8');
      } catch (err) {
        return `Error writing ${filePath}: ${err instanceof Error ? err.message : String(err)}`;
      }
      const lineCount = content.split('\n').length;
      return `Wrote ${filePath} (${byteLen} bytes, ${lineCount} line(s)).`;
    }
    default:
      return `Error: "${name}" is not a known dev tool. Available: ${[...DEV_AGENT_TOOL_NAMES].join(', ')}.`;
  }
}

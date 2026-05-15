// Reverse-apply codex apply_patch diffs to recover pre-edit content.
//
// The codex app-server `FileChange` item payload carries a `diff` string per
// affected path. The shape depends on the change kind:
//
//   kind=add    -> `diff` is the raw post-edit file content (NOT a unified diff).
//                  Pre-edit content is null (file did not exist before).
//   kind=update -> `diff` is one or more standard unified-diff hunks of the form
//                  `@@ -aStart,aLen +bStart,bLen @@` (or `@@ -aStart +bStart @@`
//                  for single-line hunks). Pre-edit content is recovered by
//                  reverse-applying the hunks against the post-edit disk
//                  content, which the host reads at item.completed time
//                  (race-free: the patch is on disk by then).
//   kind=delete -> `diff` carries the file content that was just removed,
//                  formatted as `-` lines. Pre-edit content is the
//                  concatenation of those lines.
//
// This helper is the load-bearing piece of the app-server transport's pre-edit
// pipeline -- with it, we never read disk to capture pre-edit state, so we no
// longer race apply_patch.

export type CodexPatchKind = 'add' | 'update' | 'delete';

export type CodexPatchReverseResult =
  | { ok: true; preEditContent: string | null }
  | { ok: false; reason: string };

export function reverseCodexPatch(
  diff: string,
  postEditContent: string | null,
  kind: CodexPatchKind,
): CodexPatchReverseResult {
  if (kind === 'add') {
    return { ok: true, preEditContent: null };
  }

  if (kind === 'delete') {
    return { ok: true, preEditContent: extractDeletedContent(diff) };
  }

  if (kind === 'update') {
    if (postEditContent == null) {
      return { ok: false, reason: 'update kind requires post-edit content; got null' };
    }
    return reverseUpdateHunks(diff, postEditContent);
  }

  return { ok: false, reason: `unknown kind: ${kind as string}` };
}

// Codex emits delete diffs as lines prefixed with '-'. We strip the leading
// '-' from each line; lines without the prefix are passed through (defensive,
// in case codex ever emits a hybrid format).
function extractDeletedContent(diff: string): string {
  // Preserve trailing newline iff the diff ended with one.
  const hadTrailingNewline = diff.endsWith('\n');
  const lines = diff.split('\n');
  if (hadTrailingNewline) lines.pop();
  const out: string[] = [];
  for (const line of lines) {
    if (line.startsWith('-')) {
      out.push(line.slice(1));
    } else {
      out.push(line);
    }
  }
  return out.join('\n') + (hadTrailingNewline ? '\n' : '');
}

interface Hunk {
  aStart: number; // 1-based
  aLen: number;
  bStart: number;
  bLen: number;
  lines: string[]; // ' '/'+'/'-' prefixed content lines (no header)
}

// Apply unified-diff hunks in reverse against postEditContent to recover the
// pre-edit content. The algorithm walks the post-edit file line-by-line and,
// for each hunk header, emits the pre-edit (`a`) side of the hunk in place of
// the post-edit (`b`) side.
function reverseUpdateHunks(diff: string, postEditContent: string): CodexPatchReverseResult {
  const hunks = parseHunks(diff);
  if (!hunks.ok) return hunks;

  // Track whether the post-edit content ended with a newline so we can
  // preserve EOF state through the round-trip.
  const postEndedWithNewline = postEditContent.endsWith('\n');
  const postLines = splitLinesPreservingEof(postEditContent);

  const preLines: string[] = [];
  let postIdx = 0; // 0-based index into postLines
  let preIdx = 0; // 0-based logical line in the pre-edit file (for sanity checks)

  for (const hunk of hunks.hunks) {
    // bStart is 1-based; copy lines from postLines[postIdx ... bStart-1)
    const copyUntilPostLine = hunk.bStart - 1; // 0-based index where the hunk begins in post
    while (postIdx < copyUntilPostLine) {
      if (postIdx >= postLines.length) {
        return { ok: false, reason: `hunk references post line ${hunk.bStart} but file only has ${postLines.length} lines` };
      }
      preLines.push(postLines[postIdx]);
      postIdx += 1;
      preIdx += 1;
    }

    // Walk the hunk content. For each line:
    //   ' ' (context) -> appears in both; advance post and write to pre.
    //   '-' (pre-only) -> write to pre; do NOT advance post.
    //   '+' (post-only) -> advance post; do NOT write to pre.
    for (const line of hunk.lines) {
      if (line.length === 0) {
        // Blank lines in diff bodies are degenerate; treat as a context blank.
        if (postIdx < postLines.length) {
          preLines.push(postLines[postIdx]);
          postIdx += 1;
        } else {
          preLines.push('');
        }
        preIdx += 1;
        continue;
      }
      const marker = line[0];
      const content = line.slice(1);
      if (marker === ' ') {
        if (postIdx >= postLines.length) {
          return { ok: false, reason: `context line "${content}" beyond end of post-edit content` };
        }
        // Be lenient about context-line mismatches: codex hunks are produced by
        // its own apply_patch and should match the post file exactly, but if
        // they don't, fall back to the post file's line (still correct).
        preLines.push(postLines[postIdx]);
        postIdx += 1;
        preIdx += 1;
      } else if (marker === '-') {
        preLines.push(content);
        preIdx += 1;
      } else if (marker === '+') {
        if (postIdx >= postLines.length) {
          return { ok: false, reason: `'+' line "${content}" beyond end of post-edit content` };
        }
        // Skip this line in the post file -- it's an addition that does not
        // appear in pre-edit.
        postIdx += 1;
      } else if (marker === '\\') {
        // `\ No newline at end of file` marker -- ignore for now; trailing
        // newline is tracked separately.
        continue;
      } else {
        return { ok: false, reason: `unrecognized hunk line marker: ${JSON.stringify(line.slice(0, 4))}` };
      }
    }
  }

  // Append any post-edit tail after the last hunk.
  while (postIdx < postLines.length) {
    preLines.push(postLines[postIdx]);
    postIdx += 1;
  }

  return {
    ok: true,
    preEditContent: joinLinesPreservingEof(preLines, postEndedWithNewline),
  };
}

const HUNK_HEADER = /^@@\s+-(\d+)(?:,(\d+))?\s+\+(\d+)(?:,(\d+))?\s+@@/;

function parseHunks(diff: string): { ok: true; hunks: Hunk[] } | { ok: false; reason: string } {
  const lines = diff.split('\n');
  const hunks: Hunk[] = [];
  let current: Hunk | null = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const headerMatch = HUNK_HEADER.exec(line);
    if (headerMatch) {
      if (current) hunks.push(current);
      const aStart = Number(headerMatch[1]);
      const aLen = headerMatch[2] === undefined ? 1 : Number(headerMatch[2]);
      const bStart = Number(headerMatch[3]);
      const bLen = headerMatch[4] === undefined ? 1 : Number(headerMatch[4]);
      current = { aStart, aLen, bStart, bLen, lines: [] };
      continue;
    }
    if (current) {
      // Skip the final empty string produced by a trailing newline on the diff.
      if (i === lines.length - 1 && line === '') continue;
      current.lines.push(line);
    }
    // Lines before the first hunk header are ignored (in this minimal subset
    // codex never emits a unified-diff file header for update kinds; only the
    // raw hunks).
  }
  if (current) hunks.push(current);
  if (hunks.length === 0) return { ok: false, reason: 'no hunk headers found in update diff' };
  return { ok: true, hunks };
}

// Split content into "logical lines" where each entry is one line WITHOUT its
// trailing newline. A trailing newline at EOF is represented by NOT producing
// an extra empty entry (we track EOF newline separately).
function splitLinesPreservingEof(content: string): string[] {
  if (content === '') return [];
  const hadTrailing = content.endsWith('\n');
  const parts = content.split('\n');
  if (hadTrailing) parts.pop(); // drop the empty after the final newline
  return parts;
}

function joinLinesPreservingEof(lines: string[], endWithNewline: boolean): string {
  if (lines.length === 0) return endWithNewline ? '' : '';
  return lines.join('\n') + (endWithNewline ? '\n' : '');
}

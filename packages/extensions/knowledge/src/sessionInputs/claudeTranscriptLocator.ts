/**
 * Finds the transcript of the Claude Code session that is calling this helper,
 * and proves it is that session's before anything is read from it.
 *
 * Claude Code starts one helper process per session with
 * `CLAUDE_CODE_SESSION_ID` and `CLAUDE_PROJECT_DIR` in its env, and every
 * `tools/call` carries `_meta["claudecode/toolUseId"]`: the id of the
 * `tool_use` block that made the call. That id is random and lands only in the
 * calling session's JSONL (70-110 ms after the call arrives, so this polls).
 * A file is accepted only once it holds an assistant `tool_use` with that id.
 *
 * Order: the file the env names; the same session id under any project dir;
 * then a scan of the project's recently written transcripts for the id (a
 * stale env after `/clear`). A call from a subagent lands in
 * `<session>/subagents/*.jsonl` and maps to the parent `<session>.jsonl`.
 *
 * Never "the newest file", never a path or session id from the model: with
 * several sessions in one repository a guess can put another conversation's
 * words into a team page. No proof, no transcript.
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

export interface LocatorEnv {
  CLAUDE_CODE_SESSION_ID?: string;
  CLAUDE_PROJECT_DIR?: string;
  CLAUDE_CONFIG_DIR?: string;
  HOME?: string;
}

export interface LocatorDeps {
  env: LocatorEnv;
  /** How long to wait for the call to be written. Default 3000 ms. */
  timeoutMs?: number;
  pollMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export type LocateResult =
  | { ok: true; sessionId: string; path: string }
  | { ok: false; reason: string };

/** Only plain ids are ever joined into a path. */
const SAFE_ID = /^[A-Za-z0-9_-]{1,128}$/;
/** Transcripts written this long ago or earlier are not scanned by the fallback. */
const RECENT_MS = 10 * 60 * 1000;

/** Claude Code's project folder name: every non-alphanumeric character becomes `-`. */
export function encodeProjectDir(dir: string): string {
  return dir.replace(/[^A-Za-z0-9]/g, '-');
}

function projectsRoot(env: LocatorEnv): string {
  return path.join(env.CLAUDE_CONFIG_DIR || path.join(env.HOME || homedir(), '.claude'), 'projects');
}

function listDir(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

function jsonlIn(dir: string): string[] {
  return listDir(dir).filter((name) => name.endsWith('.jsonl')).map((name) => path.join(dir, name));
}

/** Whether the file holds an assistant `tool_use` block with this id. */
export function holdsToolUse(file: string, toolUseId: string): boolean {
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    return false;
  }
  const needle = `"${toolUseId}"`;
  if (!text.includes(needle)) return false;
  for (const line of text.split('\n')) {
    if (!line.includes(needle)) continue;
    try {
      const record = JSON.parse(line);
      const content = record?.type === 'assistant' ? record.message?.content : null;
      if (Array.isArray(content) && content.some((block: any) => block?.type === 'tool_use' && block.id === toolUseId)) return true;
    } catch {
      // A line still being written; the next poll reads it whole.
    }
  }
  return false;
}

interface Candidate {
  file: string;
  /** The main transcript a hit in `file` means. */
  main: string;
}

function sessionCandidates(dir: string, sessionId: string): Candidate[] {
  const main = path.join(dir, `${sessionId}.jsonl`);
  return [
    { file: main, main },
    ...jsonlIn(path.join(dir, sessionId, 'subagents')).map((file) => ({ file, main })),
  ];
}

function candidates(env: LocatorEnv, now: number): Candidate[] {
  const root = projectsRoot(env);
  const projectDir = env.CLAUDE_PROJECT_DIR ? path.join(root, encodeProjectDir(env.CLAUDE_PROJECT_DIR)) : null;
  const sessionId = env.CLAUDE_CODE_SESSION_ID;
  const out: Candidate[] = [];
  if (sessionId && SAFE_ID.test(sessionId)) {
    if (projectDir) out.push(...sessionCandidates(projectDir, sessionId));
    // The same session under another folder name, should the encoding differ.
    for (const name of listDir(root)) {
      const dir = path.join(root, name);
      if (dir !== projectDir && existsSync(path.join(dir, `${sessionId}.jsonl`))) out.push(...sessionCandidates(dir, sessionId));
    }
  }
  if (projectDir) {
    const recent = (file: string) => {
      try {
        return now - statSync(file).mtimeMs < RECENT_MS;
      } catch {
        return false;
      }
    };
    for (const file of jsonlIn(projectDir).filter(recent)) out.push({ file, main: file });
    for (const name of listDir(projectDir)) {
      const main = path.join(projectDir, `${name}.jsonl`);
      if (!SAFE_ID.test(name)) continue;
      for (const file of jsonlIn(path.join(projectDir, name, 'subagents')).filter(recent)) out.push({ file, main });
    }
  }
  return out;
}

export async function locateTranscript(toolUseId: string | undefined, deps: LocatorDeps): Promise<LocateResult> {
  if (!toolUseId || !SAFE_ID.test(toolUseId)) {
    return { ok: false, reason: 'This Claude Code did not say which tool call is asking, so the session cannot be confirmed.' };
  }
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const deadline = now() + (deps.timeoutMs ?? 3000);
  for (;;) {
    for (const candidate of candidates(deps.env, now())) {
      if (!holdsToolUse(candidate.file, toolUseId)) continue;
      const sessionId = path.basename(candidate.main, '.jsonl');
      if (!SAFE_ID.test(sessionId) || !existsSync(candidate.main)) break;
      return { ok: true, sessionId, path: candidate.main };
    }
    if (now() >= deadline) return { ok: false, reason: "Could not confirm this session's transcript." };
    await sleep(deps.pollMs ?? 20);
  }
}

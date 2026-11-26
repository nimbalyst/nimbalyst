export interface ChildSessionReport {
  title: string;
  sessionId: string;
  status: string;
  event: string;
  before: string;
  files: string[];
  after: string;
}

export interface ChildUpdateSegment {
  text: string;
  report?: ChildSessionReport;
}

export interface ChildUpdateDisplay {
  kind: 'single' | 'coalesced';
  segments: ChildUpdateSegment[];
}

function parseReport(text: string): ChildSessionReport | undefined {
  const lines = text.split('\n');
  if (lines[0] !== '[Child Session Update]') return;
  const session = /^Session: "(.*)" \(([^\s()]+)\)$/.exec(lines[1] ?? '');
  const status = /^Status: (.+)$/.exec(lines[2] ?? '');
  const event = /^Event: (session:(?:completed|error|waiting|interrupted))$/.exec(lines[3] ?? '');
  if (!session || !status || !event) return;

  const candidates: Array<{ start: number; end: number }> = [];
  for (let i = 4; i < lines.length; i++) {
    if (lines[i] !== 'Files modified:') continue;
    let end = i + 1;
    while (end < lines.length && lines[end].startsWith('- ') && lines[end].length > 2
      && !/^- (User|Assistant): /.test(lines[end])) end++;
    if (end === i + 1) continue;
    if (end === lines.length || /^(Tool scope|Error): /.test(lines[end])
      || (lines[end] === '' && lines[end + 1]?.startsWith('ACTION REQUIRED:'))) {
      candidates.push({ start: i, end });
    }
  }
  // Free-form child text can itself contain a file list. Never guess between
  // competing blocks; keep all of it visible if boundaries are ambiguous.
  const block = candidates.length === 1 ? candidates[0] : undefined;
  return {
    title: session[1], sessionId: session[2], status: status[1], event: event[1],
    before: lines.slice(4, block?.start).join('\n'),
    files: block ? lines.slice(block.start + 1, block.end).map(line => line.slice(2)) : [],
    after: block ? lines.slice(block.end).join('\n') : '',
  };
}

/** Presentation only. Never use this parser to establish prompt authorship. */
export function parseChildSessionUpdate(text: string, promptActor?: string): ChildUpdateDisplay | null {
  const content = text.replace(/\s*<NIMBALYST_SYSTEM_MESSAGE>[\s\S]*?<\/NIMBALYST_SYSTEM_MESSAGE>/g, '').trim().replace(/\r\n/g, '\n');
  const lines = content.split('\n');
  // Since v0.84.1 queued parts carry a timestamp and a title/short-id sender.
  // Keep these labels visible; they express queue time, not report status.
  const queuedLabel = /^\[(?:\d{4}-\d{2}-\d{2} )?\d{2}:\d{2} · (user|agent|system|session: [^\]\r\n]+)\]$/;
  if (queuedLabel.test(lines[0])) {
    const boundaries: Array<{ index: number; author: string }> = [];
    lines.forEach((line, index) => {
      const match = queuedLabel.exec(line);
      if (match) boundaries.push({ index, author: match[1] });
    });
    if (boundaries.length > 20) return null;
    const segments: ChildUpdateSegment[] = [];
    boundaries.forEach((boundary, i) => {
      const body = lines.slice(boundary.index + 1, boundaries[i + 1]?.index).join('\n').trimEnd();
      const report = boundary.author.startsWith('session: ') ? parseReport(body) : undefined;
      const sender = boundary.author.slice('session: '.length);
      const shortId = /\(([^()\s]+)\)$/.exec(sender)?.[1] ?? sender;
      if (report && report.sessionId.slice(0, 8) === shortId) {
        segments.push({ text: lines[boundary.index] }, { text: body, report });
      } else {
        segments.push({ text: lines[boundary.index] + '\n' + body });
      }
    });
    return segments.some(segment => segment.report) ? { kind: 'coalesced', segments } : null;
  }
  const header = /^\[(\d+) messages arrived while you were working, oldest first\. Later messages may correct or supersede earlier ones -- read all of them before acting\. Each is labeled with its author; only messages labeled \(user\) come from the user\.\]$/.exec(lines[0]);
  if (header) {
    const count = Number(header[1]);
    if (count < 2 || count > 20 || lines[1] !== '') return null;
    const boundaries: Array<{ index: number; author?: string; id?: string }> = [];
    for (let i = 2; i < lines.length; i++) {
      const label = /^--- message (\d+) of (\d+)(?: \((user|agent)(?:: ([^)\s]+))?\))? ---$/.exec(lines[i]);
      if (!label) continue;
      if (Number(label[1]) !== boundaries.length + 1 || Number(label[2]) !== count) return null;
      boundaries.push({ index: i, author: label[3], id: label[4] });
    }
    if (boundaries.length !== count || boundaries[0].index !== 2) return null;
    const segments: ChildUpdateSegment[] = [{ text: lines[0] }];
    boundaries.forEach((boundary, i) => {
      const body = lines.slice(boundary.index + 1, boundaries[i + 1]?.index).join('\n').trimEnd();
      const report = boundary.author === 'agent' && boundary.id ? parseReport(body) : undefined;
      segments.push({
        text: lines[boundary.index] + '\n' + body,
        report: report?.sessionId === boundary.id ? report : undefined,
      });
    });
    return segments.some(segment => segment.report) ? { kind: 'coalesced', segments } : null;
  }
  if (promptActor === 'human' || promptActor === 'system') return null;
  const report = parseReport(content);
  return report ? { kind: 'single', segments: [{ text: content, report }] } : null;
}

const SINGLE_REPORT_PREFIX = '[Child Session Update]';
const SYSTEM_MESSAGE_OPEN = '<NIMBALYST_SYSTEM_MESSAGE>';

/**
 * Same answer as `parseChildSessionUpdate(text, promptActor)?.kind === 'single'`
 * for messages whose system blocks sit before or after the report, which is
 * how every producer emits them; a system block inside the header line is not
 * recognised here. Rejects ordinary messages with a prefix check instead of a
 * full parse.
 * Row grouping calls this on every streaming update, so a large pasted user
 * message must not be stripped and split each tick.
 */
export function isStandaloneChildSessionUpdate(text: string, promptActor?: string): boolean {
  if (promptActor === 'human' || promptActor === 'system') return false;
  let start = 0;
  while (start < text.length && /\s/.test(text[start])) start++;
  if (!text.startsWith(SINGLE_REPORT_PREFIX, start) && !text.startsWith(SYSTEM_MESSAGE_OPEN, start)) return false;
  return parseChildSessionUpdate(text, promptActor)?.kind === 'single';
}

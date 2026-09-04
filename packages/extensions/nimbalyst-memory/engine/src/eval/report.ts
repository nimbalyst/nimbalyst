/**
 * Scorecard formatting — plain text, side-by-side arms, no dependencies.
 *
 * The side-by-side layout is the deliverable: a single arm's recall number in
 * isolation answers nothing, because there is no scale on which 0.62 is good or
 * bad. Two arms in adjacent columns answer the only question anyone asks of
 * this harness, which is "did that change help".
 */
import type { EvalRunReport, GoldenQuestion } from './types.js';

function pct(x: number): string {
  return `${(x * 100).toFixed(1)}%`;
}

function pad(s: string, w: number): string {
  return s.length >= w ? s : s + ' '.repeat(w - s.length);
}

function padLeft(s: string, w: number): string {
  return s.length >= w ? s : ' '.repeat(w - s.length) + s;
}

/** The scorecard: one row per bucket, one column pair per arm. */
export function formatScorecard(report: EvalRunReport): string {
  const out: string[] = [];
  const { arms, recallAt, k } = report;
  if (arms.length === 0) return '(no arms ran)\n';

  // Bucket order comes from the first SCORED arm; declared-only columns have no
  // buckets of their own and are rendered as blanks against that row set.
  const scored = arms.find((a) => !a.declaredOnly);
  if (!scored) return '(every declared arm was unavailable — nothing was scored)\n';
  const bucketLabels = scored.buckets.map((b) => b.label);
  const labelWidth = Math.max(10, ...bucketLabels.map((l) => l.length)) + 2;
  const colWidth = Math.max(14, ...arms.map((a) => a.armLabel.length + 2));

  const head =
    pad('bucket', labelWidth) +
    pad('n', 5) +
    arms.map((a) => padLeft(a.armLabel, colWidth)).join('');
  const sub =
    pad('', labelWidth) +
    pad('', 5) +
    arms.map(() => padLeft(`r@${recallAt} / MRR@${k}`, colWidth)).join('');
  out.push(head);
  out.push(sub);
  out.push('-'.repeat(head.length));

  for (let i = 0; i < bucketLabels.length; i++) {
    const label = bucketLabels[i];
    const n = scored.buckets[i].questions;
    const cells = arms.map((a) => {
      if (a.declaredOnly) return padLeft('not measured', colWidth);
      const b = a.buckets.find((x) => x.label === label);
      return padLeft(b ? `${pct(b.recallAtN)} / ${b.mrr.toFixed(3)}` : '-', colWidth);
    });
    out.push(pad(label, labelWidth) + pad(String(n), 5) + cells.join(''));
    // A blank line after `overall` separates the headline from the breakdown.
    if (label === 'overall') out.push('');
  }

  const declared = arms.filter((a) => a.declaredOnly);
  if (declared.length) {
    out.push('');
    for (const a of declared) {
      out.push(`  ${a.armLabel}: not measured — ${a.unavailableReason}`);
    }
  }
  return out.join('\n') + '\n';
}

/**
 * Per-question ranks across arms. This is where a scorecard becomes actionable:
 * an aggregate says retrieval is weak, this says which questions it is weak on.
 */
export function formatPerQuestion(report: EvalRunReport, questions: GoldenQuestion[]): string {
  const scoredArms = report.arms.filter((a) => !a.declaredOnly);
  if (scoredArms.length === 0) return '(no arms were scored)\n';
  const byId = new Map(questions.map((q) => [q.id, q]));
  // Every scored arm covers the same question set, so the first one's results
  // define the row order.
  const ids = scoredArms[0].results.map((r) => r.questionId);
  const idWidth = Math.max(12, ...ids.map((id) => id.length)) + 2;
  const colWidth = Math.max(8, ...scoredArms.map((a) => a.armLabel.length + 2));
  const out: string[] = [];
  out.push(
    pad('question', idWidth) +
      scoredArms.map((a) => padLeft(a.armLabel, colWidth)).join('') +
      '   class'
  );
  out.push('-'.repeat(idWidth + scoredArms.length * colWidth + 12));
  for (const id of ids) {
    const cells = scoredArms.map((a) => {
      const r = a.results.find((x) => x.questionId === id);
      return padLeft(r?.rank == null ? '—' : String(r.rank), colWidth);
    });
    const cls = report.validation.classByQuestion[id] ?? '?';
    const tags = byId.get(id)?.tags?.length ? ` [${byId.get(id)!.tags!.join(',')}]` : '';
    out.push(pad(id, idWidth) + cells.join('') + `   ${cls}${tags}`);
  }
  out.push('');
  out.push('(rank of the first correct hit; — means absent from the top-' + report.k + ')');
  return out.join('\n') + '\n';
}

/** Validation problems, printed before any number so they cannot be missed. */
export function formatValidation(report: EvalRunReport): string {
  const v = report.validation;
  const out: string[] = [];
  if (v.unresolved.length) {
    out.push(`UNRESOLVED TARGETS (${v.unresolved.length}) — excluded from scoring:`);
    for (const u of v.unresolved) {
      const where = u.target.heading ? `${u.target.path}#${u.target.heading}` : u.target.path;
      out.push(`  ${u.questionId}: ${where}  (${u.reason})`);
    }
    out.push('');
  }
  if (v.coarse.length) {
    out.push(`COARSE TARGETS (${v.coarse.length}) — accept most of their file, so they`);
    out.push('measure "found the right document", not "found the right section":');
    for (const c of v.coarse) {
      const where = c.target.heading ? `${c.target.path}#${c.target.heading}` : c.target.path;
      out.push(`  ${c.questionId}: ${where}  (${pct(c.coverage)} of ${c.fileChunks} chunks)`);
    }
    out.push('');
  }
  return out.join('\n');
}

export function formatCorpus(report: EvalRunReport): string {
  const { corpus, slots } = report;
  const classes = Object.entries(corpus.bySourceClass).sort((a, b) => b[1] - a[1]);
  const out: string[] = [];
  out.push(`corpus: ${corpus.chunks} chunks across ${corpus.sourceFiles} files`);
  out.push('  ' + classes.map(([c, n]) => `${c}=${n}`).join('  '));
  out.push('embedders:');
  for (const s of slots) {
    const dims = s.info ? `${s.info.model} (${s.info.dims}d)` : '—';
    out.push(
      `  ${pad(s.key, 10)} ${s.available ? 'ready ' : 'absent'}  ${dims}` +
        (s.unavailableReason ? `  — ${s.unavailableReason}` : '')
    );
  }
  return out.join('\n') + '\n';
}

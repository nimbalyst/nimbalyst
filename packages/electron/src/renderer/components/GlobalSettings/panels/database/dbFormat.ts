/**
 * Formatting shared by the Settings > Database sections.
 *
 * The size wording matters more than it looks. Assessment works in buckets
 * because buckets are what may travel to analytics, but a user deciding
 * between two copies of their own database is owed the measured size as well —
 * so both are shown, and neither is described as "about" when it is exact.
 */

import type { RecoverySizeBucket } from '../../../../store/atoms/dbMigration';

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`;
  const mins = Math.floor(ms / 60_000);
  const secs = ((ms % 60_000) / 1000).toFixed(0);
  return `${mins} min ${secs} s`;
}

/** Binary units, matching the cohort ceilings the rollout is defined in. */
const BUCKET_LABELS: Record<RecoverySizeBucket, string> = {
  'empty': 'empty',
  'under-32mb': 'under 32 MiB',
  'under-256mb': '32 MiB to 256 MiB',
  'under-1gb': '256 MiB to 1 GiB',
  'under-3gb': '1 GiB to 3 GiB',
  'over-3gb': 'over 3 GiB',
};

export function sizeBucketLabel(bucket: RecoverySizeBucket): string {
  return BUCKET_LABELS[bucket] ?? String(bucket);
}

/**
 * Artifact dates are the primary way a user tells two copies apart, so an
 * unparseable one says so rather than falling back to something invented.
 */
export function formatArtifactDate(iso: string | null): string {
  if (!iso) return 'no date recorded in the name';
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) return 'no date recorded in the name';
  return parsed.toLocaleString();
}

/**
 * The public recovery API.
 *
 * Callers name a candidate by identifier, never by path. The identifier is
 * only ever minted here, from a scan of the userData root, so there is no
 * argument a caller can construct that points recovery at an arbitrary
 * directory. `.claude/rules/destructive-data-paths.md` calls this out
 * explicitly, and the plan's safety invariant 5 says the same thing: recovery
 * acts on an explicitly allowlisted artifact and never silently picks
 * whichever path sorts first.
 *
 * The other half of the contract is invariant 6: artifact presence is evidence
 * to investigate, not proof the live database is empty. So discovery reports
 * candidates with a verdict attached and only `recovery_recommended` is
 * allowed to become a launch-time offer. Everything else sits in Settings,
 * described accurately, waiting for the user.
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import {
  countConfiguredProjects,
  findRecoveryArtifacts,
} from '../sqlite/recoveryArtifacts';
import { assessRecoveryCandidate } from './candidateAssessment';
import { pathSizeBytes } from './recoveryFs';
import type { RecoveryJournalPort } from './recoveryJournal';
import { runRecoveryTransaction, type RecoveryBackendAdapter } from './recoveryTransaction';
import {
  sizeBucketFor,
  type ActiveBackend,
  type CandidateAssessment,
  type CandidateAssessmentFacts,
  type ContentIndicators,
  type DatabaseFacts,
  type DatabasePathKind,
  type RecoveryCandidate,
  type RecoveryDomainEvent,
  type RecoveryLogFn,
  type RecoveryOutcome,
  type RecoveryStep,
  type RecoveryVerification,
} from './types';

/** Identifiers are namespaced so a bare path can never be mistaken for one. */
const CANDIDATE_ID_PREFIX = 'artifact:';

/** Where the user's resolutions are recorded, next to the databases they describe. */
const RESOLUTION_FILENAME = 'db-recovery-state.json';

export interface RecoveryResolutionState {
  /** Artifact names the user has restored from, kept, or dismissed. */
  resolvedArtifacts: string[];
}

export interface RecoveryServiceOptions {
  userDataPath: string;
  activeBackend: ActiveBackend;
  adapter: RecoveryBackendAdapter;
  /**
   * Probe a database at an arbitrary path. Off the main thread. For a PGLite
   * artifact this is a short-lived PGLite worker; for a SQLite file it is
   * `createRecoveryVerifier`.
   */
  probeCandidate: (candidatePath: string) => Promise<RecoveryVerification>;
  /**
   * Content indicators for the live database, read through the production
   * query path. Must resolve with `null` counts rather than throwing when the
   * database cannot be read — unreadable is not empty.
   */
  readLiveIndicators: () => Promise<ContentIndicators>;
  /**
   * Rows in `ai_agent_messages` in the live database. The one signal that
   * separates "the app opened a window over an empty store" from "the user
   * worked in this database"; see `CandidateAssessmentFacts`. Optional, and
   * `null` when absent, which makes the assessment fall back to the stricter
   * session-count rule rather than to a more permissive one.
   */
  readLiveAgentMessageCount?: () => Promise<number | null>;
  /**
   * Durable record of the swap. Production always supplies one; without it a
   * process killed between the two renames leaves the next launch to guess
   * from directory presence, which is the #1347 failure mode exactly.
   */
  journal?: RecoveryJournalPort;
  emit?: (event: RecoveryDomainEvent) => void;
  log?: RecoveryLogFn;
}

export class RecoveryService {
  private readonly opts: RecoveryServiceOptions;
  private readonly log: RecoveryLogFn;

  constructor(opts: RecoveryServiceOptions) {
    this.opts = opts;
    this.log = opts.log ?? (() => {});
  }

  /**
   * Every root-level corruption artifact, each with a verdict. Never throws:
   * a launch must not fail because a directory went away mid-scan.
   */
  async listCandidates(): Promise<RecoveryCandidate[]> {
    const { userDataPath } = this.opts;
    let names: string[] = [];
    try {
      names = findRecoveryArtifacts(userDataPath).corruptionBackupDirs;
    } catch (err) {
      this.log('warn', '[Recovery] Could not scan for recovery artifacts', err);
      return [];
    }

    const resolved = await this.loadResolutions();
    const liveFacts = await this.gatherLiveFacts();
    const liveAgentMessageCount = await this.gatherLiveAgentMessageCount();
    const configuredProjectCount = safeProjectCount(userDataPath);

    const candidates: RecoveryCandidate[] = [];
    for (const name of names) {
      const candidatePath = path.join(userDataPath, name);
      try {
        const candidateFacts = await this.gatherFacts(candidatePath);
        const assessment = assessRecoveryCandidate({
          activeBackend: this.opts.activeBackend,
          live: liveFacts,
          candidate: candidateFacts,
          configuredProjectCount,
          liveAgentMessageCount,
          alreadyResolved: resolved.resolvedArtifacts.includes(name),
        });
        // Local log only, and the counts are the whole point of it: a verdict
        // on its own cannot be argued with, and the two verdicts that decline
        // to offer recovery -- `assessment_blocked` and `needs_review` -- are
        // the ones a user disagrees with. Analytics still gets buckets.
        this.log('info', '[Recovery] Assessed a recovery candidate', {
          name,
          verdict: assessment.verdict,
          reasonCode: assessment.reasonCode,
          configuredProjectCount,
          liveAgentMessageCount,
          live: liveFacts.indicators,
          candidate: candidateFacts.indicators,
          candidateIntegrity: candidateFacts.integrity,
        });
        candidates.push({
          id: `${CANDIDATE_ID_PREFIX}${name}`,
          name,
          path: candidatePath,
          sizeBytes: candidateFacts.sizeBytes,
          sizeBucket: candidateFacts.sizeBucket,
          createdAt: timestampFromArtifactName(name),
          assessment,
        });
      } catch (err) {
        this.log('warn', '[Recovery] Could not assess artifact', { name, err });
      }
    }
    return candidates;
  }

  /**
   * The one candidate, if any, that may be raised unprompted at launch.
   * Returns null whenever more than one qualifies: a choice between two
   * databases is not something to make on the user's behalf.
   */
  async proactiveOffer(): Promise<RecoveryCandidate | null> {
    const recommended = (await this.listCandidates()).filter(
      (c) => c.assessment.mayOfferProactively,
    );
    return recommended.length === 1 ? recommended[0] : null;
  }

  /**
   * Recover from a discovered candidate. The identifier must have come from
   * `listCandidates`; anything else is refused before a single byte moves.
   *
   * `expectedFingerprint` is the fingerprint the user saw. Facts are gathered
   * again inside the transaction and the attempt is refused if they moved.
   */
  async recover(args: {
    candidateId: string;
    expectedFingerprint: string;
    /** Fault-injection seam, for tests and failure-path E2E. */
    beforeStep?: (step: RecoveryStep) => void | Promise<void>;
  }): Promise<RecoveryOutcome> {
    const backend = this.opts.activeBackend;
    const candidates = await this.listCandidates();
    const candidate = candidates.find((c) => c.id === args.candidateId);
    if (!candidate) {
      // Covers an absolute path, a bare directory name, an artifact that has
      // been removed, and an identifier from a different install.
      this.log('warn', '[Recovery] Refused an identifier that is not a discovered artifact', {
        candidateId: args.candidateId,
      });
      this.opts.emit?.({
        type: 'recovery_failed',
        backend,
        code: 'unknown_candidate',
        failedStep: null,
        rolledBack: false,
      });
      return {
        ok: false,
        candidateId: args.candidateId,
        backend,
        code: 'unknown_candidate',
        failedStep: null,
        rolledBack: false,
        artifacts: {},
        message: 'That recovery candidate is not one of the artifacts found on this computer.',
      };
    }

    const outcome = await runRecoveryTransaction({
      candidateId: candidate.id,
      candidatePath: candidate.path,
      adapter: this.opts.adapter,
      eligibility: {
        reassess: async () => this.reassess(candidate.name),
        expectedFingerprint: args.expectedFingerprint,
      },
      context: {
        candidateSizeBucket: candidate.assessment.candidateSizeBucket,
        liveSizeBucket: candidate.assessment.liveSizeBucket,
        reasonCode: candidate.assessment.reasonCode,
      },
      journal: this.opts.journal,
      operationId: `recovery-${candidate.name}-${Date.now()}`,
      emit: this.opts.emit,
      log: this.log,
      beforeStep: args.beforeStep,
    });

    if (outcome.ok) await this.markResolved(candidate.name);
    return outcome;
  }

  /**
   * Record that the user has dealt with an artifact — restored from it, or
   * decided to keep it as-is. This only stops us asking again. It never
   * deletes anything; removing a copy of a database is always an explicit,
   * separately-confirmed action.
   */
  async markResolved(artifactName: string): Promise<void> {
    const state = await this.loadResolutions();
    if (state.resolvedArtifacts.includes(artifactName)) return;
    state.resolvedArtifacts.push(artifactName);
    try {
      await fs.writeFile(
        path.join(this.opts.userDataPath, RESOLUTION_FILENAME),
        JSON.stringify(state, null, 2),
        'utf-8',
      );
    } catch (err) {
      this.log('warn', '[Recovery] Could not record artifact resolution', err);
    }
  }

  // -------------------------------------------------------------------------

  private async reassess(artifactName: string): Promise<CandidateAssessment> {
    const facts = await this.gatherAssessmentFacts(artifactName);
    return assessRecoveryCandidate(facts);
  }

  private async gatherAssessmentFacts(
    artifactName: string,
  ): Promise<CandidateAssessmentFacts> {
    const resolved = await this.loadResolutions();
    return {
      activeBackend: this.opts.activeBackend,
      live: await this.gatherLiveFacts(),
      candidate: await this.gatherFacts(path.join(this.opts.userDataPath, artifactName)),
      configuredProjectCount: safeProjectCount(this.opts.userDataPath),
      liveAgentMessageCount: await this.gatherLiveAgentMessageCount(),
      alreadyResolved: resolved.resolvedArtifacts.includes(artifactName),
    };
  }

  private async gatherLiveAgentMessageCount(): Promise<number | null> {
    if (!this.opts.readLiveAgentMessageCount) return null;
    try {
      return await this.opts.readLiveAgentMessageCount();
    } catch {
      return null;
    }
  }

  /**
   * Live facts come from the running database rather than from a second probe:
   * opening the live store from another process is exactly what the database
   * rules forbid.
   */
  private async gatherLiveFacts(): Promise<DatabaseFacts> {
    const livePath = this.opts.adapter.livePath;
    const before = await pathSizeBytes(livePath);
    if (before === 0 && !(await this.opts.adapter.exists(livePath))) {
      return {
        pathKind: 'missing',
        sizeBytes: 0,
        sizeBucket: 'empty',
        requiredSchemaPresent: null,
        integrity: 'not-checked',
        indicators: { sessionCount: null, documentHistoryCount: null, projectCount: null },
      };
    }
    let indicators: ContentIndicators;
    try {
      indicators = await this.opts.readLiveIndicators();
    } catch {
      indicators = { sessionCount: null, documentHistoryCount: null, projectCount: null };
    }
    const after = await pathSizeBytes(livePath);
    return {
      pathKind: this.opts.activeBackend === 'pglite' ? 'pglite-directory' : 'sqlite-file',
      sizeBytes: after,
      sizeBucket: sizeBucketFor(after),
      // A database we just read counts through is by definition schema-bearing.
      requiredSchemaPresent: indicators.sessionCount !== null,
      integrity: indicators.sessionCount !== null ? 'not-checked' : 'unreadable',
      indicators,
    };
  }

  private async gatherFacts(candidatePath: string): Promise<DatabaseFacts> {
    const before = await pathSizeBytes(candidatePath);
    if (before === 0) {
      const exists = await pathExistsSafe(candidatePath);
      return {
        pathKind: exists ? 'unrecognized' : 'missing',
        sizeBytes: 0,
        sizeBucket: 'empty',
        requiredSchemaPresent: null,
        integrity: exists ? 'unreadable' : 'not-checked',
        indicators: { sessionCount: null, documentHistoryCount: null, projectCount: null },
      };
    }

    // No "is this artifact moving?" check here, deliberately.
    //
    // There used to be one: sample the size, probe, sample again, and call a
    // mismatch `facts_changed_while_reading`. It measured US. `probeCandidate`
    // opens the store to count rows, and opening a PGLite store writes to it --
    // lock file, WAL, postmaster state -- so the two samples bracketed our own
    // write and the mismatch was guaranteed. Moving both samples before the
    // probe did not fix it either: verification workers are `terminate()`d
    // rather than closed, so writes from an EARLIER probe land asynchronously
    // and straddle any two samples we take.
    //
    // It could not be made sound without excluding a version-dependent list of
    // Postgres internals, which would also blind it to a real third-party
    // writer, whose writes land in the same files. Meanwhile it failed in the
    // worst direction: `assessment_blocked` refuses recovery, and it refused
    // every first look at every artifact, so `proactiveOffer()` -- which only
    // ever gets a first look -- could never return anything. A check that
    // cannot tell our writes from someone else's is worse than no check.
    //
    // The property it was reaching for is enforced where it belongs and where
    // it works: `runRecoveryTransaction` re-gathers these facts immediately
    // before the first destructive step and refuses on any fingerprint change,
    // and `sizeBytes` is part of that fingerprint. An artifact something else
    // is genuinely writing to keeps changing, so it trips that; a settled one
    // does not. See the `facts_changed` refusal in `recoveryTransaction.ts`.
    const probe = await this.opts.probeCandidate(candidatePath);
    return {
      pathKind: await classifyPath(candidatePath),
      sizeBytes: before,
      sizeBucket: sizeBucketFor(before),
      requiredSchemaPresent: probe.integrity === 'unreadable' ? null : probe.requiredSchemaPresent,
      integrity: probe.integrity,
      indicators: probe.indicators,
    };
  }

  private async loadResolutions(): Promise<RecoveryResolutionState> {
    try {
      const raw = await fs.readFile(
        path.join(this.opts.userDataPath, RESOLUTION_FILENAME),
        'utf-8',
      );
      const parsed = JSON.parse(raw) as Partial<RecoveryResolutionState>;
      return {
        resolvedArtifacts: Array.isArray(parsed.resolvedArtifacts)
          ? parsed.resolvedArtifacts.filter((n): n is string => typeof n === 'string')
          : [],
      };
    } catch {
      return { resolvedArtifacts: [] };
    }
  }
}

async function pathExistsSafe(target: string): Promise<boolean> {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}

async function classifyPath(target: string): Promise<DatabasePathKind> {
  try {
    const stat = await fs.stat(target);
    if (stat.isDirectory()) {
      const entries = await fs.readdir(target);
      return entries.includes('PG_VERSION') ? 'pglite-directory' : 'unrecognized';
    }
    return target.endsWith('.sqlite') ? 'sqlite-file' : 'unrecognized';
  } catch {
    return 'missing';
  }
}

function safeProjectCount(userDataPath: string): number {
  try {
    return countConfiguredProjects(userDataPath);
  } catch {
    return 0;
  }
}

/** `pglite-db.backup-2026-08-21T10-13-22-000Z` -> an ISO string, or null. */
export function timestampFromArtifactName(name: string): string | null {
  const match = name.match(/(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z)$/);
  if (!match) return null;
  const iso = match[1].replace(
    /T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z$/,
    'T$1:$2:$3.$4Z',
  );
  const parsed = new Date(iso);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

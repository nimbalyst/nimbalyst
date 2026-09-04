/**
 * Makes the vote repository reachable from inside a `DecisionNode`'s decorator.
 *
 * A Lexical decorator cannot take props from the host -- it is constructed by
 * the node -- so the config has to arrive through context. This is the one
 * place that owns the repository's lifetime: created when a Y.Doc appears,
 * destroyed when it goes away or the editor unmounts.
 *
 * The provider is always mounted, including with no config at all. A block in a
 * plain local file still renders and is still answerable; it simply has nowhere
 * to put a vote, and `useDecisionVotes` reports that rather than pretending.
 */

import React, {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
} from "react";
import {
  isValidDecisionAnswer,
  isValidStoredDecisionAnswer,
  type DecisionBlockSource,
  type DecisionRecommendation,
  type DecisionVote,
} from "@nimbalyst/collab-protocol";

import {
  YDocDecisionRepository,
  emptyDecisionSnapshot,
  type DecisionRepositorySnapshot,
  type DecisionSealClaim,
} from "./YDocDecisionRepository";
import type { DecisionMember, DecisionsConfig } from "./types";

interface DecisionsContextValue {
  repository: YDocDecisionRepository | null;
  config: DecisionsConfig | null;
}

const DecisionsContext = createContext<DecisionsContextValue>({
  repository: null,
  config: null,
});

export const DecisionsProvider: React.FC<{
  config?: DecisionsConfig;
  children: React.ReactNode;
}> = ({ config, children }) => {
  const [repository, setRepository] = useState<YDocDecisionRepository | null>(
    null
  );

  useEffect(() => {
    const doc = config?.getYDoc() ?? null;
    if (!doc) {
      setRepository(null);
      return;
    }
    const created = new YDocDecisionRepository(doc);
    setRepository(created);
    return () => {
      created.destroy();
      setRepository(null);
    };
  }, [config]);

  const value = useMemo<DecisionsContextValue>(
    () => ({ repository, config: config ?? null }),
    [repository, config]
  );

  return (
    <DecisionsContext.Provider value={value}>
      {children}
    </DecisionsContext.Provider>
  );
};

export interface DecisionVotingState {
  votes: readonly DecisionVote[];
  recommendations: readonly DecisionRecommendation[];
  sealClaim: DecisionSealClaim | undefined;
  /** The current viewer's own vote, when they have cast one. */
  myVote: DecisionVote | undefined;
  viewer: { id: string; name: string } | null;
  members: readonly DecisionMember[];
  /**
   * False when there is no room to vote in. The block stays usable -- a solo
   * reader can still pick and seal -- but nothing is recorded for anyone else.
   */
  canRecordVotes: boolean;
  canVote: boolean;
  /** No-ops on an answer that is malformed for this ask, or on a sealed block. */
  castVote: (answer: DecisionVote["answer"], note?: string) => void;
  retractVote: () => void;
  claimSeal: (claim: DecisionSealClaim) => void;
  /** Absent when the host cannot render embeds (web console, mobile editor). */
  renderArtifact: DecisionsConfig["renderArtifact"];
}

const NO_VOTES: readonly DecisionVote[] = Object.freeze([]);
const NO_RECOMMENDATIONS: readonly DecisionRecommendation[] = Object.freeze([]);
const NO_MEMBERS: readonly DecisionMember[] = Object.freeze([]);

export function useDecisionVotes(
  source: DecisionBlockSource
): DecisionVotingState {
  const { repository, config } = useContext(DecisionsContext);
  const blockId = source.id;

  const snapshot = useSyncExternalStore<DecisionRepositorySnapshot>(
    (listener) => repository?.subscribe(listener) ?? (() => undefined),
    () => repository?.getSnapshot() ?? emptyDecisionSnapshot(),
    () => repository?.getSnapshot() ?? emptyDecisionSnapshot()
  );

  const storedVotes = snapshot.votesByBlock[blockId] ?? NO_VOTES;
  const votes = useMemo(
    () =>
      storedVotes.filter((vote) =>
        isValidStoredDecisionAnswer(source, vote.answer)
      ),
    [source, storedVotes]
  );
  const recommendations =
    snapshot.recommendationsByBlock[blockId] ?? NO_RECOMMENDATIONS;
  const sealClaim = snapshot.sealClaimsByBlock[blockId];
  const viewer =
    config?.currentUser ??
    (config === null ? { id: "local", name: "You" } : null);
  const isSolo =
    repository === null && (config === null || config.isHydrated === undefined);
  const myVote = viewer
    ? votes.find((vote) => vote.voterId === viewer.id)
    : undefined;

  return useMemo<DecisionVotingState>(
    () => ({
      votes,
      recommendations,
      sealClaim,
      myVote,
      viewer,
      members: config?.getMembers?.() ?? NO_MEMBERS,
      canRecordVotes: repository !== null,
      canVote:
        isSolo ||
        (repository !== null &&
          viewer !== null &&
          (config?.canVote?.() ?? true) &&
          (config?.isHydrated?.() ?? true)),
      castVote: (answer, note) => {
        if (!repository || !viewer) return;
        // Validated against the ask before it reaches the CRDT. A malformed
        // answer written into the Y.Doc is durable and would be replicated to
        // everyone before anything noticed.
        //
        // See `isValidDecisionAnswer` for why the shape rules are restated in
        // the protocol package rather than imported from `feedbackRequest.ts`.
        if (!isValidDecisionAnswer(source, answer)) return;
        repository.castVote(blockId, {
          voterId: viewer.id,
          voterName: viewer.name,
          answer,
          at: Date.now(),
          ...(note !== undefined ? { note } : {}),
        });
      },
      retractVote: () => {
        if (!repository || !viewer) return;
        repository.retractVote(blockId, viewer.id);
      },
      claimSeal: (claim) => repository?.claimSeal(blockId, claim),
      renderArtifact: config?.renderArtifact,
    }),
    [
      blockId,
      config,
      isSolo,
      myVote,
      recommendations,
      repository,
      sealClaim,
      source,
      viewer,
      votes,
    ]
  );
}

export interface ParsedCodexToolLookupId {
  itemId: string;
  timestampMs: number;
  index: number;
}

export interface GitCommitProposalLookupCandidate {
  proposalId: string;
  createdAtMs: number;
  toolUseId?: string;
}

/**
 * Build a turn-scoped lookup ID for Codex tool calls.
 * Raw Codex item IDs like item_0 are reused across turns, so callers that need
 * a durable lookup key should include a timestamp/index suffix.
 */
export function buildCodexToolLookupId(
  itemId: string,
  timestampMs: number,
  index: number,
): string {
  return `nimtc|${encodeURIComponent(itemId)}|${timestampMs}|${index}`;
}

/**
 * Parse a Codex synthetic tool-call lookup ID.
 * Format: nimtc|<encodeURIComponent(rawItemId)>|<timestamp>|<index>
 */
export function parseCodexToolLookupId(promptId: string): ParsedCodexToolLookupId | null {
  if (!promptId || !promptId.startsWith('nimtc|')) {
    return null;
  }

  const parts = promptId.split('|');
  if (parts.length !== 4) {
    return null;
  }

  const encodedItemId = parts[1];
  if (!encodedItemId) {
    return null;
  }

  const timestampMs = Number(parts[2]);
  const index = Number(parts[3]);
  if (!Number.isFinite(timestampMs) || !Number.isFinite(index)) {
    return null;
  }

  try {
    const itemId = decodeURIComponent(encodedItemId);
    if (!itemId) {
      return null;
    }
    return { itemId, timestampMs, index };
  } catch {
    return null;
  }
}

/**
 * Resolve a renderer prompt ID back to the durable git commit proposal row.
 *
 * Direct proposalId/toolUseId matches win. For synthetic Codex IDs, pick the
 * closest proposal in time. The caller should pass unresolved proposals first
 * when it wants to bias toward active prompts.
 */
export function resolveGitCommitProposalLookup(
  promptId: string,
  proposals: GitCommitProposalLookupCandidate[],
): string | null {
  const directMatch = proposals.find(
    (proposal) =>
      proposal.proposalId === promptId || proposal.toolUseId === promptId,
  );
  if (directMatch) {
    return directMatch.proposalId;
  }

  const parsed = parseCodexToolLookupId(promptId);
  if (!parsed || proposals.length === 0) {
    return null;
  }

  const best = proposals
    .slice()
    .sort((a, b) => {
      const aDistance = Math.abs(a.createdAtMs - parsed.timestampMs);
      const bDistance = Math.abs(b.createdAtMs - parsed.timestampMs);
      if (aDistance !== bDistance) {
        return aDistance - bDistance;
      }
      return b.createdAtMs - a.createdAtMs;
    })[0];

  return best?.proposalId ?? null;
}

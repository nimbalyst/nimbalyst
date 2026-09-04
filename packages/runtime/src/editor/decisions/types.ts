import type { ReactNode } from 'react';
import type { Doc } from 'yjs';

/** A person who can be shown against a vote: avatar initial, name, attribution. */
export interface DecisionMember {
  id: string;
  name: string;
  email?: string;
}

/**
 * Host-supplied configuration enabling in-document decision voting.
 *
 * Mirrors `CommentsConfig` deliberately: same lazy `getYDoc`, same
 * `currentUser`, same lazily-read roster. A decision block and a comment thread
 * are the two things that hang off a document rather than living in its text,
 * and they should be wired the same way.
 *
 * **Absence is the solo case, not an error.** When this config is missing, or
 * `getYDoc()` returns null, there is no room and therefore no second person to
 * conflict with: the block renders, the reader can still pick and seal straight
 * to markdown, and nothing is stored. Do not fall back to a local simulation of
 * the vote map -- a locally-simulated tally would show a reader "3 of 4
 * answered" for votes that exist nowhere.
 */
export interface DecisionsConfig {
  /**
   * The document's Y.Doc, where votes live under top-level `decisions` and
   * `decisionRecommendations` maps. Null until the collaboration provider is
   * ready, and null forever for a plain local file.
   */
  getYDoc: () => Doc | null;
  /**
   * The signed-in user, stamped onto their vote.
   *
   * In a collab document this is the **team** member id from the team JWT --
   * never the personal one, and never a roster id resolved separately, since
   * Stytch issues a different member id per org. On a local file it is the git
   * identity, so an attributed seal reads correctly across machines.
   */
  currentUser: { id: string; name: string };
  /** Roster for rendering names and avatars against votes. Read lazily so it stays fresh. */
  getMembers?: () => DecisionMember[];
  /** True once the collaborative document has hydrated enough for mutations. */
  isHydrated?: () => boolean;
  /** False for a read-only viewer; blocks voting and sealing without hiding the block. */
  canVote?: () => boolean;

  /**
   * Renders an option's `artifact:` as a live embed, so "which of these three
   * mockups" is a visual question rather than three strings.
   *
   * Host-supplied because the thing that can do this -- `EmbedFrame` plus the
   * custom-editor registry -- lives in the Electron renderer and reads its own
   * Jotai state. Threading it as a callback keeps the block host-agnostic, so
   * the same block still renders in the web console and the mobile editor,
   * just without the preview. `entryId` identifies the option; `artifact` is
   * the workspace-relative path written in the fence.
   */
  renderArtifact?: (entryId: string, artifact: string) => ReactNode;
}

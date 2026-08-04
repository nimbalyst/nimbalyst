/**
 * Shared comment renderer and composer.
 *
 * Every messaging surface -- organization rooms, document discussions, DMs,
 * tracker comments, and inline document comments -- renders through these
 * components over a source-specific `CommentAdapter`.
 */

export { CommentThread } from './CommentThread';
export {
  createConversationCommentAdapter,
  materializeConversationComments,
  type ConversationCommentAdapterConfig,
} from './ConversationCommentAdapter';
export { CommentRow } from './CommentRow';
export { CommentBody } from './CommentBody';
export { CommentComposer, type ComposerSubmission } from './CommentComposer';
export { CommentActionMenu } from './CommentActionMenu';
export { MentionPicker } from './MentionPicker';
export { ReactionBar } from './ReactionBar';
export { ResourcePill } from './ResourcePill';
export { EmojiPicker, EmojiAutocomplete, EmojiTriggerButton } from './EmojiPicker';
export { ActivityRow, suppressDuplicateActivity, shouldGroupWithPrevious } from './ActivityRow';

export {
  aggregateReactions,
  buildCommentView,
  buildPillViews,
  describeComposerRestriction,
  isOwnComment,
  mentionCandidates,
  resolveActions,
  toPillView,
  toggleReactionAggregate,
  validateDraft,
  formatAbsoluteTime,
  formatRelativeTime,
  type BuildCommentViewContext,
  type DraftState,
  type DraftValidation,
  type MentionCandidate,
} from './commentViewModel';

export { parseCommentBody, segmentsToPlainText, initialsFor } from './commentBodyParser';
export {
  agentMentionUrn,
  conversationUrn,
  mentionUrn,
  messageUrn,
  parseAgentMentionUrn,
  parseMentionUrn,
  parseResourceUrn,
  resourceRefToUrn,
} from './resourceUrn';
export {
  EMPTY_POOL,
  addAgentToPool,
  addPersonToPool,
  addRefToPool,
  deriveDraft,
  detectTrigger,
  labeledToken,
  replaceRange,
  urnsInText,
  type DraftPool,
} from './composerDraft';
export { EMOJI_CATALOG, QUICK_REACTIONS, emojiGlyph, emojiGlyphOrShortcode, searchEmoji } from './emojiCatalog';
export { useResourcePreviews } from './useResourcePreviews';

export * from './commentTypes';

/**
 * The recipient's side of a feedback request, embedded wherever the request was
 * delivered, and the author's results tab. The compose surface lives in the
 * runtime transcript widgets; all three render the same shared
 * interactive-widget chrome.
 */

export {
  FeedbackRequestResults,
  type FeedbackRequestResultsProps,
  type FeedbackResultsActionResult,
  type FeedbackResultsHost,
} from './FeedbackRequestResults';
export {
  FeedbackRequestResultsTab,
  type FeedbackRequestResultsTabProps,
} from './FeedbackRequestResultsTab';
export {
  createFeedbackResultsHost,
  startFeedbackRequestSync,
  type FeedbackResultsHostConfig,
} from './createFeedbackResultsHost';
export {
  createFeedbackComposeHost,
  type FeedbackComposeHost,
  type FeedbackComposeHostConfig,
} from './createFeedbackComposeHost';
export {
  isPublishableSubjectKind,
  prepareFeedbackSubjectPublish,
  publishFeedbackSubject,
  unpublishableSubjectMessage,
  type FeedbackPublishOutcome,
  type FeedbackPublishPlan,
} from './publishFeedbackSubject';
export {
  FEEDBACK_REQUEST_OPEN_EVENT,
  FEEDBACK_REQUEST_TAB_PREFIX,
  FEEDBACK_REQUEST_TAB_TITLE,
  feedbackRequestTabUri,
  isFeedbackRequestTab,
  openFeedbackRequestResults,
  parseFeedbackRequestTabUri,
  type FeedbackRequestTabRef,
} from './feedbackRequestTab';
export {
  FeedbackBacklinkHeaderButton,
  FeedbackBacklinkSection,
  useFeedbackBacklinks,
  type FeedbackBacklinkSectionProps,
} from './FeedbackBacklinks';
export {
  feedbackBacklinkAuthorLabel,
  feedbackBacklinkProgressLabel,
  feedbackBacklinkStatus,
  sortFeedbackBacklinks,
  type FeedbackBacklinkStatus,
  type FeedbackBacklinkTone,
} from './feedbackBacklinkModel';
export {
  buildFeedbackResults,
  consolidateRankedAnswers,
  feedbackResultsAreAttributed,
  isRankedItemContested,
  type FeedbackAskResult,
  type FeedbackOutstanding,
  type FeedbackRankedEntry,
  type FeedbackResults,
} from './feedbackResultsModel';

export {
  FeedbackRequestRespond,
  type FeedbackRequestRespondProps,
  type FeedbackRespondHost,
  type FeedbackRespondSubmitResult,
} from './FeedbackRequestRespond';
export {
  createFeedbackRespondHost,
  type FeedbackRespondHostConfig,
} from './createFeedbackRespondHost';
export {
  createFeedbackDiscussionAdapter,
  materializeFeedbackDiscussion,
  type FeedbackDiscussionAdapterConfig,
} from './feedbackDiscussionAdapter';
export {
  FeedbackRespondOptionCards,
  type FeedbackOptionPreviewRenderer,
} from './FeedbackRespondOptionCards';
export { FeedbackRespondAskField } from './FeedbackRespondAskField';
export {
  FEEDBACK_RESPOND_BLOCKED_MESSAGES,
  attributedAnswersForViewer,
  feedbackRespondAsks,
  feedbackRespondSignature,
  feedbackRespondSubmitPlan,
  initialFeedbackRespondDraft,
  isAnswerComplete,
  seedAnswerForAsk,
  setFeedbackRespondAnswer,
  type FeedbackRespondBlockedReason,
  type FeedbackRespondDraft,
  type FeedbackRespondSubmitPlan,
} from './feedbackRespondDraft';

/**
 * Wire-format types for the Nimbalyst collaboration sync protocol.
 *
 * This package is the single source of truth for the WebSocket message
 * contracts between Nimbalyst clients (desktop, mobile) and the sync
 * server. Both sides must import from here; there is no other copy.
 */

export * from "./identityScope.js";
export * from "./roomIds.js";
export * from "./collabUri.js";
export * from "./comments.js";
export * from "./structuredInput.js";
export * from "./feedbackRequest.js";
export * from "./feedbackRequestRoom.js";
export * from "./decisionBlock.js";
export * from "./conversation.js";
export * from "./conversationRoom.js";
export * from "./teamInbox.js";
export * from "./personal.js";
export * from "./teamDocument.js";
export * from "./teamDocumentHistory.js";
export * from "./teamTracker.js";
export * from "./teamRoom.js";
export * from "./projectSync.js";

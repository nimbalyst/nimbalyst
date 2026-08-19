import { BrowserWindow } from 'electron';

import type {
  FeedbackRequestCloseIpcRequest,
  FeedbackRequestCommentIpcRequest,
  FeedbackRequestCreateIpcRequest,
  FeedbackRequestNudgeIpcRequest,
  FeedbackRequestRespondIpcRequest,
  FeedbackRequestServiceTarget,
} from '../../shared/feedbackRequest';
import type {
  FeedbackRequestIndexSnapshotIpcRequest,
  FeedbackRequestIndexSubjectIpcRequest,
  FeedbackRequestIndexTarget,
  FeedbackRequestIndexUpsertIpcRequest,
} from '../../shared/feedbackRequestIndex';
import {
  getFeedbackRequestIndexService,
  shutdownFeedbackRequestIndexService,
} from '../services/FeedbackRequestIndexService';
import {
  getFeedbackRequestService,
  shutdownFeedbackRequestService,
} from '../services/FeedbackRequestService';
import { safeHandle } from '../utils/ipcRegistry';

let cleanupSubscription: (() => void) | null = null;
let cleanupIndexSubscription: (() => void) | null = null;

export function registerFeedbackRequestHandlers(): void {
  if (cleanupSubscription) return;
  const service = getFeedbackRequestService();
  const indexService = getFeedbackRequestIndexService();
  cleanupSubscription = service.subscribe((state) => {
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.isDestroyed()) {
        window.webContents.send('feedback-request:state-changed', state);
      }
    }
  });
  cleanupIndexSubscription = indexService.subscribe((payload) => {
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.isDestroyed()) {
        window.webContents.send('feedback-request-index:changed', payload);
      }
    }
  });

  safeHandle(
    'feedback-request:start',
    async (_event, target: FeedbackRequestServiceTarget) => service.start(target),
  );
  safeHandle(
    'feedback-request:get-cached',
    async (_event, target: FeedbackRequestServiceTarget) => service.getCached(target),
  );
  safeHandle(
    'feedback-request:create',
    async (_event, input: FeedbackRequestCreateIpcRequest) => service.create(
      input.target,
      input.clientMutationId,
      input.request,
    ),
  );
  safeHandle(
    'feedback-request:respond',
    async (_event, input: FeedbackRequestRespondIpcRequest) => service.respond(
      input.target,
      input.clientMutationId,
      input.askId,
      input.answer,
    ),
  );
  safeHandle(
    'feedback-request:comment',
    async (_event, input: FeedbackRequestCommentIpcRequest) => service.comment(
      input.target,
      input.clientMutationId,
      input.body,
      input.replyToCommentId,
    ),
  );
  safeHandle(
    'feedback-request:close',
    async (_event, input: FeedbackRequestCloseIpcRequest) => service.close(
      input.target,
      input.clientMutationId,
      input.status,
    ),
  );
  safeHandle(
    'feedback-request:nudge',
    async (_event, input: FeedbackRequestNudgeIpcRequest) => service.nudge(
      input.target,
      input.clientMutationId,
      input.recipientUserIds,
    ),
  );
  safeHandle(
    'feedback-request-index:replace-snapshot',
    async (_event, input: FeedbackRequestIndexSnapshotIpcRequest) => (
      indexService.replaceSnapshot(input)
    ),
  );
  safeHandle(
    'feedback-request-index:upsert',
    async (_event, input: FeedbackRequestIndexUpsertIpcRequest) => (
      indexService.enqueueUpsert(input)
    ),
  );
  safeHandle(
    'feedback-request-index:list',
    async (_event, target: FeedbackRequestIndexTarget) => indexService.list(target),
  );
  safeHandle(
    'feedback-request-index:find-by-subject',
    async (_event, input: FeedbackRequestIndexSubjectIpcRequest) => (
      indexService.findBySubject(input)
    ),
  );
}

export function shutdownFeedbackRequestHandlers(): void {
  cleanupSubscription?.();
  cleanupSubscription = null;
  cleanupIndexSubscription?.();
  cleanupIndexSubscription = null;
  shutdownFeedbackRequestIndexService();
  shutdownFeedbackRequestService();
}

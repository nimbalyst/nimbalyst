/**
 * The consent prompt for an `@agent` ask that arrived over the shared board.
 *
 * Lifted out of CanvasSurface unchanged. It is a *prompt*, not a notification:
 * confirming it starts an agent session on this machine, in this workspace,
 * with this user's permissions, from text a teammate's client published and
 * nothing authenticated -- see `canvasPendingAgentRequests`. The warning copy
 * and the deliberately plain "Not now" are the security boundary's user-facing
 * half and should not be softened.
 */
import type { ReactElement } from 'react';
import { Panel } from '@xyflow/react';

import type { CanvasAgentThreadRequest } from './canvasComments';

export interface CanvasAgentRequestPanelProps {
  request: CanvasAgentThreadRequest;
  onConfirm(commentId: string): void;
  onDismiss(commentId: string): void;
}

export function CanvasAgentRequestPanel({
  request,
  onConfirm,
  onDismiss,
}: CanvasAgentRequestPanelProps): ReactElement {
  return (
    <Panel
      position="bottom-center"
      className="canvas-agent-request"
      data-canvas-agent-request={request.commentId}
    >
      <div className="canvas-agent-request__title">
        Start a session for this comment?
      </div>
      <div className="canvas-agent-request__where">{request.anchorLabel}</div>
      <blockquote className="canvas-agent-request__body select-text">
        {request.body.trim()}
      </blockquote>
      <p className="canvas-agent-request__warning">
        This comment came from the shared board and nothing has verified who
        wrote it. A session runs here, in this workspace, with your permissions.
        Start it only if you recognise the request.
      </p>
      <div className="canvas-agent-request__actions">
        <button
          type="button"
          className="canvas-agent-request__button canvas-agent-request__button--dismiss"
          onClick={() => onDismiss(request.commentId)}
        >
          Not now
        </button>
        <button
          type="button"
          className="canvas-agent-request__button canvas-agent-request__button--confirm"
          onClick={() => onConfirm(request.commentId)}
        >
          Start session
        </button>
      </div>
    </Panel>
  );
}

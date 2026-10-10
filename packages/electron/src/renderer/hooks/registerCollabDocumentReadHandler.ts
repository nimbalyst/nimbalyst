import { isCollabUri } from "@nimbalyst/collab-protocol";
import { HeadlessCollabDocumentError } from "../services/HeadlessCollabDocument";
import { readCollabDocWithDecisionState } from "../services/readCollabDecisionState";
import {
  assertCurrentProjectPage,
  OtherProjectPageError,
  readCollabDocForAgent,
} from "../services/agentDocumentAccess";
import { isPersonalPageUri } from "../../shared/personalPageUri";

/** One read handler for editable source and optional read-only decision responses. */
export function registerCollabDocumentReadHandler(
  resolveWorkspacePath: () => string | null | undefined
): () => void {
  if (!window.electronAPI.onMcpReadCollabDoc) return () => {};
  return window.electronAPI.onMcpReadCollabDoc(
    async ({
      targetFilePath,
      resultChannel,
      workspacePath: routedWorkspacePath,
      includeDecisionState,
    }) => {
      try {
        // Personal pages are local: no room, no decision blocks to project.
        if (isPersonalPageUri(targetFilePath)) {
          const { content } = await readCollabDocForAgent(
            targetFilePath,
            routedWorkspacePath ?? resolveWorkspacePath()
          );
          window.electronAPI.sendMcpReadCollabDocResult(resultChannel, { success: true, content });
          return;
        }
        if (!targetFilePath || !isCollabUri(targetFilePath)) {
          window.electronAPI.sendMcpReadCollabDocResult(resultChannel, {
            success: false,
            error: `readCollabDoc requires a collab:// URI. Got: ${
              targetFilePath ?? "(missing)"
            }`,
          });
          return;
        }

        // Reachable whether or not anyone has it open -- a shared document
        // lives on the server, not in a tab (NIM-3754).
        // Both read modes must use the same authorized privacy boundary. A
        // mounted editor can still contain an older, unsafe local projection.
        const workspacePath = routedWorkspacePath ?? resolveWorkspacePath();
        // Another project's page is read through that project (main re-routes).
        assertCurrentProjectPage(targetFilePath, workspacePath);
        const result = await readCollabDocWithDecisionState(
          targetFilePath,
          workspacePath
        );
        window.electronAPI.sendMcpReadCollabDocResult(resultChannel, {
          success: true,
          content: result.content,
          title: result.title,
          documentType: result.documentType,
          ...(includeDecisionState
            ? { decisionState: result.decisionState }
            : {}),
        });
      } catch (error) {
        window.electronAPI.sendMcpReadCollabDocResult(resultChannel, {
          success: false,
          ...(error instanceof HeadlessCollabDocumentError
            ? { code: error.code }
            : {}),
          ...(error instanceof OtherProjectPageError
            ? { code: error.code, projectId: error.projectId }
            : {}),
          error:
            error instanceof Error
              ? error.message
              : "Unknown error reading collab doc",
        });
      }
    }
  );
}

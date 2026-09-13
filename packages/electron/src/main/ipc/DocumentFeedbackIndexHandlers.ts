import { BrowserWindow } from "electron";
import { safeHandle } from "../utils/ipcRegistry";
import { DocumentFeedbackIndexService } from "../services/DocumentFeedbackIndexService";
import { database } from "../database/PGLiteDatabaseWorker";
import { getOrgScopedJwt } from "../services/TeamService";
import { getSubFromJwt } from "../services/jwtOrg";
import type {
  DocumentFeedbackIndexTarget,
  DocumentFeedbackIndexUpdate,
} from "../../shared/documentFeedbackIndex";

export function registerDocumentFeedbackIndexHandlers(): void {
  const service = new DocumentFeedbackIndexService({
    query: database.query.bind(database),
    viewer: async (orgId) => getSubFromJwt(await getOrgScopedJwt(orgId)),
    emit: (update) => {
      for (const window of BrowserWindow.getAllWindows())
        if (!window.isDestroyed())
          window.webContents.send("document-feedback-index:changed", update);
    },
  });
  safeHandle(
    "document-feedback-index:replace",
    async (_event, input: DocumentFeedbackIndexUpdate) => service.replace(input)
  );
  safeHandle(
    "document-feedback-index:list",
    async (
      _event,
      target: Pick<DocumentFeedbackIndexTarget, "workspacePath" | "orgId">
    ) => service.list(target)
  );
}

/**
 * The share-to-team flow, split into the half that asks the author and the half
 * that does the work.
 *
 * This used to live inside `CommonFileActions`, where the only entry point was a
 * context-menu click. A second caller needs it now: sending a feedback request
 * whose subject is a local file has to make that file team-visible first, and
 * the author -- not the sender -- owns the answers (shared name, destination
 * folder, which embedded documents come along). Pre-answering them would publish
 * something the author never described; refusing would leave the flagship flow
 * ("ask a teammate which of these three mockups they prefer") dead.
 *
 * The split is the part that matters:
 *
 * - `askShareToTeam` opens the real dialog and resolves with the author's
 *   answers, or `cancelled`. It has **no side effects on the team**, so a caller
 *   with several subjects can collect every answer before creating anything and
 *   abandon the whole batch on the first cancel.
 * - `shareFileToTeam` performs the share: asset migration, embedded-document
 *   cascade, document creation, toasts, and remembering the destination folder.
 *
 * `openAfterCreate` is the one behavioral knob. The context menu opens the new
 * shared copy (that is what the author asked for); the feedback path does not,
 * because the author is mid-compose in the transcript and the results tab is the
 * thing that should surface.
 */

import { copyToClipboard, getEmbeddableExtensions } from "@nimbalyst/runtime";
import { store } from "@nimbalyst/runtime/store";

import { dialogRef, DIALOG_IDS } from "../dialogs";
import type { ShareToTeamData } from "../dialogs";
import {
  activeTeamOrgIdAtom,
  buildSharedDocumentDeepLink,
  getPersonalCollabHost,
  resolveDesktopCollabScope,
  trashSharedDocument,
  workspaceHasTeamAtom,
} from "../store/atoms/collabDocuments";
import { activeWorkspacePathAtom } from "../store/atoms/openProjects";
import { getRelativePath } from "../utils/pathUtils";
import {
  joinCollabPath,
  normalizeCollabPath,
} from "../components/CollabMode/collabTree";
import {
  getCollaborativeDocumentTypeCatalog,
  type CollaborativeDocumentTypeDescriptor,
} from "./CollaborativeDocumentTypeCatalog";
import { readShareToTeamSourceContent } from "./shareToTeamSourceContent";
import { personalPageSupportsType } from "./personalPageTypes";
import {
  CollaborativeDocumentCreationError,
  createCollaborativeDocument,
} from "./collaborativeDocumentCreationOrchestrator";
import {
  discoverCanvasEmbeddedDocuments,
  discoverEmbeddedDocuments,
  rewriteCanvasEmbeddedDocuments,
  rewriteEmbeddedDocumentLinks,
  shareEmbeddedDocuments,
  type EmbeddedDocumentCandidate,
} from "./embeddedDocumentShare";
import {
  bucketItemCount,
  categorizeTeamAnalyticsError,
  toStableAnalyticsCategory,
} from "../../shared/analytics/teamAnalytics";
import { trackTeamAnalyticsEvent } from "../utils/teamAnalytics";

/** The Pages section a copy lands in. */
export type PagesSection = "team" | "personal";

/** Everything the share dialog asks the author for. */
export interface ShareToTeamAnswers {
  descriptor: CollaborativeDocumentTypeDescriptor;
  /** Team when absent (callers from before Personal existed). */
  section?: PagesSection;
  folderId: string | null;
  folderPath: string;
  sharedName: string;
  embeddedDocuments: EmbeddedDocumentCandidate[];
  selectedEmbeddedDocumentPaths: string[];
}

export type ShareToTeamAsk =
  | { status: "answered"; answers: ShareToTeamAnswers }
  | { status: "cancelled" }
  | { status: "unavailable"; reason: string };

export interface ShareToTeamAskOptions {
  /**
   * Pre-answers the folder question. The feedback path asks it once for the
   * whole request, in the compose surface, before the author commits to
   * sending; re-asking per file would put the question back in a modal after
   * the decision, which is the thing that change removes.
   */
  destination?: { folderId: string | null; folderPath: string };
  /**
   * With a destination supplied and nothing else left to ask, resolve without
   * opening a dialog at all. Only honoured when there are no embedded
   * documents: which embeds come along is a real question with no default, and
   * silently answering it would publish files the author never saw named.
   */
  skipWhenFullyAnswered?: boolean;
  /** Pre-selects the section; the dialog still lets the author switch when both are offered. */
  section?: PagesSection;
}

export type ShareFileToTeamResult =
  | {
      status: "shared";
      documentId: string;
      orgId: string;
      title: string;
      /** Degradations that did not fail the share (lost embeds, lost assets). */
      warnings?: string[];
    }
  | { status: "failed"; error: string };

export interface ShareToTeamTarget {
  filePath: string;
  fileName: string;
}

/**
 * Open the share dialog and wait for the author.
 *
 * Resolves `cancelled` when the dialog closes without a confirmation, which is
 * why `ShareToTeamData` carries `onDismiss`: the dialog closes on both paths and
 * a caller that cannot tell them apart would treat a dismissal as an answer.
 */
/**
 * Which already-local documents this file embeds, and would therefore drag
 * along when it becomes collaborative.
 *
 * Extracted from `askShareToTeam` because "is there anything left to ask?" has
 * to be answerable *without* opening a dialog. The feedback path decides
 * whether it needs a modal at all from this result: no candidates means the
 * folder was the only open question, and that one is already answered.
 */
export async function discoverShareEmbeddedDocuments(
  filePath: string,
  descriptor: CollaborativeDocumentTypeDescriptor
): Promise<EmbeddedDocumentCandidate[]> {
  const workspacePath = store.get(activeWorkspacePathAtom);
  if (
    (descriptor.documentType !== "markdown" &&
      descriptor.documentType !== "canvas") ||
    !workspacePath
  ) {
    return [];
  }

  try {
    const catalog = getCollaborativeDocumentTypeCatalog();
    const source = await readShareToTeamSourceContent(filePath, descriptor);
    const common = {
      sourceFilePath: filePath,
      workspacePath,
      catalog,
      expectedOrgId: store.get(activeTeamOrgIdAtom),
      fileExists: async (absolutePath: string) => {
        const exists = await window.electronAPI?.invoke?.(
          "file:exists",
          absolutePath
        );
        return exists === true;
      },
      findExisting: async (absolutePath: string) => {
        const result =
          await window.electronAPI?.documentSync?.findLocalOriginLink?.(
            workspacePath,
            absolutePath
          );
        const binding = result?.success ? result.binding : null;
        return binding
          ? { documentId: binding.documentId, orgId: binding.orgId }
          : null;
      },
    };
    if (descriptor.documentType === "markdown" && typeof source === "string") {
      return await discoverEmbeddedDocuments({
        markdown: source,
        embeddableExtensions: getEmbeddableExtensions(),
        ...common,
      });
    }
    return await discoverCanvasEmbeddedDocuments({ canvas: source, ...common });
  } catch (error) {
    console.warn(
      "[shareToTeamFlow] Could not inspect embedded documents:",
      error
    );
    return [];
  }
}

/** The document type that will own the shared copy, or why there is none. */
export function resolveShareDescriptor(
  fileName: string
): { ok: true; descriptor: CollaborativeDocumentTypeDescriptor } | { ok: false; reason: string } {
  const shareability = getCollaborativeDocumentTypeCatalog().resolveShareability(fileName);
  return shareability.state === "ready"
    ? { ok: true, descriptor: shareability.descriptor }
    : { ok: false, reason: shareability.reason };
}

/** Where a copy of this type can go: Team needs a team; Personal holds any type but code. */
export function shareSectionsFor(
  descriptor: CollaborativeDocumentTypeDescriptor,
  hasTeam: boolean
): PagesSection[] {
  return [
    ...(hasTeam ? (["team"] as const) : []),
    ...(personalPageSupportsType(descriptor.documentType) ? (["personal"] as const) : []),
  ];
}

export async function askShareToTeam(
  target: ShareToTeamTarget,
  options: ShareToTeamAskOptions = {}
): Promise<ShareToTeamAsk> {
  const resolved = resolveShareDescriptor(target.fileName);
  if (!resolved.ok) {
    return { status: "unavailable", reason: resolved.reason };
  }
  const descriptor = resolved.descriptor;
  const sections = shareSectionsFor(descriptor, store.get(workspaceHasTeamAtom));
  if (sections.length === 0) {
    return {
      status: "unavailable",
      reason: `${descriptor.displayName} files can only be copied to Team pages, and this project has no team.`,
    };
  }
  const initialSection =
    options.section && sections.includes(options.section) ? options.section : sections[0]!;

  const workspacePath = store.get(activeWorkspacePathAtom);
  const sourceRelPath = workspacePath
    ? getRelativePath(workspacePath, target.filePath) || target.fileName
    : target.fileName;

  // Only document types that can embed anything pay for the lookup. Without
  // this guard a spreadsheet would await a call that can only return [], which
  // pushes opening the dialog into a later microtask for no reason.
  const embeddedDocuments =
    sections.includes("team") &&
    (descriptor.documentType === "markdown" || descriptor.documentType === "canvas")
      ? await discoverShareEmbeddedDocuments(target.filePath, descriptor)
      : [];

  // Every question already has an answer: do not open a dialog to collect
  // nothing. This is what makes "get feedback on this mockup" publish with no
  // modal at all.
  if (
    options.destination &&
    options.skipWhenFullyAnswered &&
    (embeddedDocuments.length === 0 || initialSection === "personal")
  ) {
    return {
      status: "answered",
      answers: {
        descriptor,
        section: initialSection,
        folderId: options.destination.folderId,
        folderPath: options.destination.folderPath,
        sharedName: target.fileName,
        embeddedDocuments: [],
        selectedEmbeddedDocumentPaths: [],
      },
    };
  }

  const dialogs = dialogRef.current;
  if (!dialogs) {
    return {
      status: "unavailable",
      reason: "The share dialog is not available in this window.",
    };
  }

  return new Promise<ShareToTeamAsk>((resolve) => {
    let answered = false;
    dialogs.open<ShareToTeamData>(DIALOG_IDS.SHARE_TO_TEAM, {
      fileName: target.fileName,
      sourceRelPath,
      descriptor,
      embeddedDocuments,
      sections,
      initialSection,
      // Only the folder is pre-answered; the dialog still asks the rest.
      ...(options.destination
        ? { initialFolderId: options.destination.folderId }
        : {}),
      onConfirm: ({
        section,
        folderId,
        folderPath,
        sharedName,
        selectedEmbeddedDocumentPaths,
      }) => {
        answered = true;
        resolve({
          status: "answered",
          answers: {
            descriptor,
            section,
            folderId,
            folderPath,
            sharedName,
            embeddedDocuments,
            selectedEmbeddedDocumentPaths,
          },
        });
      },
      // `DialogProvider` calls this on every removal, including the close that
      // follows a confirmation, so it only means "cancelled" when no answer
      // came first.
      onDismiss: () => {
        if (!answered) resolve({ status: "cancelled" });
      },
    });
  });
}

/**
 * Perform the share the author just described.
 *
 * Toasts stay here rather than moving to the callers: both surfaces report the
 * same operation, and the asset/linked-document outcomes are only knowable at
 * this level.
 */
export async function shareFileToTeam(params: {
  filePath: string;
  fileName: string;
  answers: ShareToTeamAnswers;
  /** Defaults to the context-menu behavior: open the new shared copy. */
  openAfterCreate?: boolean;
  /**
   * Defaults to true. A caller sharing several files as one action turns this
   * off and records the destination once itself; otherwise each file overwrites
   * the previous one's write with the same value.
   */
  persistLastSharedFolder?: boolean;
  /**
   * Defaults to true. A folder promote turns this off: one toast per file is a
   * notification storm for the author and hides the only number that matters,
   * which is how many of the N files actually landed. That caller reports the
   * batch once from the results.
   */
  showNotifications?: boolean;
}): Promise<ShareFileToTeamResult> {
  const { filePath, fileName, answers } = params;
  const showNotifications = params.showNotifications !== false;
  const personal = answers.section === "personal";
  const failTitle = personal ? "Could not copy to Personal" : "Could not share to team";
  const {
    folderId,
    folderPath,
    sharedName,
    embeddedDocuments,
    selectedEmbeddedDocumentPaths,
  } = answers;
  const { errorNotificationService } = await import(
    "./ErrorNotificationService"
  );
  const documentTypeCatalog = getCollaborativeDocumentTypeCatalog();

  const fail = (
    message: string,
    options?: { details?: string; duration?: number }
  ): ShareFileToTeamResult => {
    if (showNotifications) {
      if (options)
        errorNotificationService.showError(failTitle, message, options);
      else errorNotificationService.showError(failTitle, message);
    }
    return { status: "failed", error: message };
  };
  const trackShareFailure = (error: unknown) => {
    trackTeamAnalyticsEvent("collab_operation_failed", {
      surface: "desktop",
      operation: "share_to_team",
      source: "share_to_team",
      actorType: "user",
      documentType: toStableAnalyticsCategory(answers.descriptor.documentType),
      errorCategory: categorizeTeamAnalyticsError("document", error),
    });
  };

  const matchedSuffix =
    [...answers.descriptor.fileExtensions]
      .sort((left, right) => right.length - left.length)
      .find((suffix) =>
        fileName.toLowerCase().endsWith(suffix.toLowerCase())
      ) ?? answers.descriptor.defaultExtension;
  const liveResolution = documentTypeCatalog.resolveMetadata(
    answers.descriptor.documentType,
    matchedSuffix,
    documentTypeCatalog.editorIdForDescriptor(answers.descriptor)
  );
  if (liveResolution.state !== "ready") {
    trackShareFailure(liveResolution.reason);
    return fail(liveResolution.reason);
  }
  const descriptor = liveResolution.descriptor;
  const documentType = descriptor.documentType;

  // Read file content to seed the collaborative document on first share.
  let initialContent: string | Uint8Array;
  try {
    initialContent = await readShareToTeamSourceContent(filePath, descriptor);
  } catch (err) {
    trackShareFailure(err);
    return fail(err instanceof Error ? err.message : String(err));
  }

  // Pre-seed migration of pasted image attachments. Local refs like
  // `assets/<hash>.png` only exist on this user's disk; without migration
  // collaborators see broken images. We upload through the encrypted
  // collab-asset path and rewrite the markdown before it ever reaches the
  // Y.Doc. Best-effort: failures are reported in the toast but don't
  // block the share unless every asset failed.
  //
  // Markdown only -- non-markdown asset shapes (Excalidraw's inline
  // base64 images, mindmap's no-attachments) are handled differently or
  // not at all; we skip the markdown rewriter for them entirely.
  const workspacePath = store.get(activeWorkspacePathAtom);
  // A Personal copy is a local page: no team scope, no image upload, no linked
  // documents (their links stay as they were in the file).
  const scope = !workspacePath
    ? null
    : personal
    ? getPersonalCollabHost(workspacePath).scope
    : (await resolveDesktopCollabScope(workspacePath)).scope;
  if (!scope) {
    trackShareFailure("Collaboration scope is unavailable.");
    return fail(personal ? "No open project for Personal pages." : "The active team collaboration scope is unavailable.");
  }
  const normalizedFolder = normalizeCollabPath(folderPath);
  const trimmedName = sharedName.trim() || fileName;
  // joinCollabPath handles empty parent -> root and normalizes separators.
  const shareTitle = joinCollabPath(normalizedFolder, trimmedName);
  const documentId = crypto.randomUUID();
  const documentSync = window.electronAPI?.documentSync;
  let migratedContent = initialContent;
  let migrationToast: {
    kind: "ok" | "partial" | "no-assets" | "unavailable" | "total-failure";
    message?: string;
    failedCount?: number;
    okCount?: number;
  } = { kind: "no-assets" };

  if (
    !personal &&
    documentType === "markdown" &&
    typeof initialContent === "string" &&
    initialContent &&
    workspacePath &&
    documentSync?.open &&
    documentSync?.migrateLocalAssets
  ) {
    try {
      const openResult = await documentSync.open(
        workspacePath,
        documentId,
        shareTitle,
        documentType
      );
      if (!openResult.success || !openResult.config) {
        throw new Error(
          openResult.error || "Failed to open collab document for migration"
        );
      }
      const { orgId, documentId: openedDocumentId } = openResult.config;
      try {
        const migration = await documentSync.migrateLocalAssets({
          workspacePath,
          orgId,
          documentId: openedDocumentId,
          sourceFilePath: filePath,
          markdown: initialContent,
        });
        if (
          migration.success &&
          migration.rewrittenMarkdown !== undefined &&
          migration.results
        ) {
          const okCount = migration.results.filter(
            (r) => r.status === "ok"
          ).length;
          const failedCount = migration.results.filter(
            (r) =>
              r.status === "failed" ||
              r.status === "missing" ||
              r.status === "rejected"
          ).length;
          const attempted = okCount + failedCount;
          if (attempted > 0 && okCount === 0) {
            migrationToast = { kind: "total-failure", failedCount };
          } else {
            migratedContent = migration.rewrittenMarkdown;
            migrationToast =
              attempted === 0
                ? { kind: "no-assets" }
                : failedCount > 0
                ? { kind: "partial", okCount, failedCount }
                : { kind: "ok", okCount };
          }
        } else if (!migration.success) {
          migrationToast = { kind: "unavailable", message: migration.error };
        }
      } finally {
        // Drop the migration-pass registration. CollabMode will reopen the
        // doc when its tab mounts; otherwise we'd permanently inflate the
        // sender refcount by 1.
        await documentSync.closeDoc(openedDocumentId).catch(() => {});
      }
    } catch (err) {
      console.warn("[shareToTeamFlow] Asset migration failed:", err);
      migrationToast = {
        kind: "unavailable",
        message: err instanceof Error ? err.message : String(err),
      };
    }
  }

  if (migrationToast.kind === "total-failure") {
    trackTeamAnalyticsEvent("collab_share_asset_migration_completed", {
      surface: "desktop",
      outcome: "failed",
      assetCountBucket: bucketItemCount(migrationToast.failedCount ?? 0),
      linkedDocumentCountBucket: bucketItemCount(
        selectedEmbeddedDocumentPaths.length
      ),
      errorCategory: "asset_migration_failed",
    });
    trackShareFailure(new Error("Asset migration failed"));
    return fail(
      `All ${
        migrationToast.failedCount ?? ""
      } attached images failed to upload. Check your connection and try again.`,
      { duration: 8000 }
    );
  }

  let embeddedShareResult: Awaited<ReturnType<typeof shareEmbeddedDocuments>> =
    {
      sharedReferences: new Map(),
      createdDocumentIds: [],
      failures: [],
    };
  if (
    !personal &&
    (documentType === "markdown" || documentType === "canvas") &&
    workspacePath &&
    embeddedDocuments.length > 0 &&
    selectedEmbeddedDocumentPaths.length > 0
  ) {
    embeddedShareResult = await shareEmbeddedDocuments({
      candidates: embeddedDocuments,
      selectedPaths: new Set(selectedEmbeddedDocumentPaths),
      parentFolderId: folderId,
      readSourceContent: (candidate) =>
        readShareToTeamSourceContent(
          candidate.absolutePath,
          candidate.descriptor
        ),
      createDocument: (input) =>
        createCollaborativeDocument({ ...input, scope }),
      generateId: () => crypto.randomUUID(),
      resolveOrgId: async () => {
        const orgId = store.get(activeTeamOrgIdAtom);
        if (!orgId) {
          throw new Error("The active team organization is unavailable.");
        }
        return orgId;
      },
    });
    migratedContent =
      documentType === "canvas"
        ? rewriteCanvasEmbeddedDocuments({
            canvas: migratedContent,
            sourceFilePath: filePath,
            workspacePath,
            candidates: embeddedDocuments,
            sharedReferences: embeddedShareResult.sharedReferences,
          })
        : rewriteEmbeddedDocumentLinks({
            markdown: migratedContent as string,
            sourceFilePath: filePath,
            workspacePath,
            candidates: embeddedDocuments,
            sharedReferences: embeddedShareResult.sharedReferences,
          });
  }

  let createdDocument;
  try {
    createdDocument = await createCollaborativeDocument({
      scope,
      descriptor,
      requestedName: trimmedName,
      parentFolderId: folderId,
      sourceContent: migratedContent,
      ...(personal
        ? {}
        : { localOrigin: { sourceFilePath: filePath, sourceContent: initialContent } }),
      operationId: documentId,
      documentId,
      ...(params.openAfterCreate === false ? { openAfterCreate: false } : {}),
      analyticsSource: "share_to_team",
      analyticsActorType: "user",
      analyticsLinkedDocumentCount: selectedEmbeddedDocumentPaths.length,
      analyticsAssetMigrationOutcome:
        migrationToast.kind === "no-assets"
          ? "not_needed"
          : migrationToast.kind === "ok"
          ? "success"
          : migrationToast.kind === "partial"
          ? "partial"
          : "failed",
    });
  } catch (error) {
    // The cascade already created the child documents. Without this the
    // team is left with orphaned embeds whose parent never existed.
    for (const orphanId of embeddedShareResult.createdDocumentIds) {
      try {
        trashSharedDocument(scope, orphanId);
      } catch (rollbackError) {
        console.warn(
          "[shareToTeamFlow] Could not roll back linked document:",
          rollbackError
        );
      }
    }
    const details =
      error instanceof CollaborativeDocumentCreationError
        ? `${error.code} (document ${error.documentId})`
        : undefined;
    return fail(error instanceof Error ? error.message : String(error), {
      details,
      duration: 10000,
    });
  }
  const finalTitle = createdDocument.title;
  const teamOrgId = personal ? null : store.get(activeTeamOrgIdAtom);
  const copyLinkAction = teamOrgId
    ? {
        label: "Copy Link",
        onClick: () => {
          const deepLink = buildSharedDocumentDeepLink(
            createdDocument.documentId,
            teamOrgId
          );
          void copyToClipboard(deepLink).catch((error: unknown) => {
            console.error(
              "[shareToTeamFlow] Failed to copy shared document link:",
              error
            );
            errorNotificationService.showError(
              "Copy failed",
              "Could not write the link to the clipboard."
            );
          });
        },
      }
    : undefined;
  const linkedCount = embeddedShareResult.sharedReferences.size;
  const linkedFailureCount = embeddedShareResult.failures.length;
  const assetCount =
    (migrationToast.okCount ?? 0) + (migrationToast.failedCount ?? 0);
  const migrationOutcome =
    migrationToast.kind === "partial" ||
    migrationToast.kind === "unavailable" ||
    linkedFailureCount > 0
      ? "partial"
      : "success";
  trackTeamAnalyticsEvent("collab_share_asset_migration_completed", {
    surface: "desktop",
    outcome: migrationOutcome,
    assetCountBucket: bucketItemCount(assetCount),
    linkedDocumentCountBucket: bucketItemCount(
      linkedCount + linkedFailureCount
    ),
    ...(migrationToast.kind === "partial" ||
    migrationToast.kind === "unavailable"
      ? { errorCategory: "asset_migration_failed" as const }
      : linkedFailureCount > 0
      ? { errorCategory: "linked_document_failed" as const }
      : {}),
  });

  // Remember the destination folder so the next share defaults to it.
  if (
    params.persistLastSharedFolder !== false
    && !personal
    && workspacePath
    && window.electronAPI?.invoke
  ) {
    window.electronAPI
      .invoke("workspace:update-state", workspacePath, {
        collabTree: {
          lastSharedFolderId: folderId,
          // Keep the path during migration so older clients retain their
          // last-used destination behavior.
          lastSharedFolder: normalizedFolder,
        },
      })
      .catch((error: unknown) => {
        console.warn(
          "[shareToTeamFlow] Failed to persist lastSharedFolder:",
          error
        );
      });
  }

  // Attachment and linked-document outcomes are independent: a doc can lose
  // an image upload AND a linked embed. Report both in one toast rather than
  // letting either result hide the other.
  const linkedParts: string[] = [];
  if (linkedCount > 0) {
    linkedParts.push(
      `Shared ${linkedCount} linked document${linkedCount === 1 ? "" : "s"}.`
    );
  }
  if (linkedFailureCount > 0) {
    linkedParts.push(
      `${linkedFailureCount} linked document${
        linkedFailureCount === 1 ? "" : "s"
      } could not be shared and remain local links.`
    );
  }
  const linkedSummary =
    linkedParts.length > 0 ? ` ${linkedParts.join(" ")}` : "";
  const linkedDetails =
    linkedFailureCount > 0
      ? embeddedShareResult.failures
          .map((failure) => `${failure.fileName}: ${failure.error}`)
          .join("\n")
      : undefined;

  // A share can succeed and still lose something. A caller that suppressed the
  // toasts has no other way to learn that, so the degradations ride back on the
  // result rather than only existing as pixels.
  const warnings: string[] = [];
  if (linkedFailureCount > 0) {
    warnings.push(
      `${linkedFailureCount} linked document${
        linkedFailureCount === 1 ? "" : "s"
      } could not be shared`
    );
  }
  if (migrationToast.kind === "partial") {
    warnings.push(`${migrationToast.failedCount} attachment(s) failed to upload`);
  } else if (migrationToast.kind === "unavailable") {
    warnings.push("attachments could not be migrated");
  }

  if (!showNotifications) {
    return {
      status: "shared",
      documentId: createdDocument.documentId,
      orgId: scope.orgId,
      title: finalTitle,
      warnings,
    };
  }

  switch (migrationToast.kind) {
    case "ok":
    case "no-assets":
    default: {
      const body =
        migrationToast.kind === "ok"
          ? `"${finalTitle}" is now a collaborative document. Migrated ${
              migrationToast.okCount
            } attachment${
              migrationToast.okCount === 1 ? "" : "s"
            }.${linkedSummary}`
          : personal
          ? `"${finalTitle}" is now a page in Personal.`
          : `"${finalTitle}" is now a collaborative document.${linkedSummary}`;
      if (linkedFailureCount > 0) {
        errorNotificationService.showWarning(
          "Shared with missing linked documents",
          body,
          { details: linkedDetails, duration: 10000, action: copyLinkAction }
        );
      } else {
        errorNotificationService.showInfo(personal ? "Copied to Personal" : "Shared to team", body, {
          duration: 4000,
          action: copyLinkAction,
        });
      }
      break;
    }
    case "partial":
      errorNotificationService.showWarning(
        "Shared with missing attachments",
        `"${finalTitle}" was shared but ${
          migrationToast.failedCount
        } attachment${
          migrationToast.failedCount === 1 ? "" : "s"
        } failed to upload.${linkedSummary}`,
        { details: linkedDetails, duration: 8000, action: copyLinkAction }
      );
      break;
    case "unavailable":
      errorNotificationService.showWarning(
        "Shared to team",
        `"${finalTitle}" is now collaborative, but image attachments could not be migrated${
          migrationToast.message ? `: ${migrationToast.message}` : "."
        }${linkedSummary}`,
        { details: linkedDetails, duration: 8000, action: copyLinkAction }
      );
      break;
  }

  return {
    status: "shared",
    documentId: createdDocument.documentId,
    orgId: scope.orgId,
    title: finalTitle,
    warnings,
  };
}

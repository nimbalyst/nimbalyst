/**
 * Team Dialogs Registration
 *
 * Dialogs for team management. Organization creation has exactly one surface —
 * `OrgCreationWizard` — since the one-field `CreateTeamDialog` was folded into
 * it; every entry point opens `DIALOG_IDS.ORG_CREATION_WIZARD`.
 */

import React from 'react';
import { registerDialog } from '../contexts/DialogContext';
import type { DialogConfig } from '../contexts/DialogContext.types';
import { DIALOG_IDS } from './registry';
import { ShareToTeamDialog } from '../components/ShareToTeamDialog';
import { ShareFolderToTeamDialog } from '../components/ShareToTeamDialog/ShareFolderToTeamDialog';
import { FeedbackDestinationDialog } from '../components/ShareToTeamDialog/FeedbackDestinationDialog';
import { OrgCreationWizard } from '../components/TeamMode/onboarding/OrgCreationWizard';
import { OrgManagementDialog } from '../components/OrgManagement/OrgManagementDialog';
import {
  OrgProjectWalkDialog,
  type ProjectWalkOutcome,
} from '../components/TeamMode/onboarding/OrgProjectWalkDialog';
import type { ProjectWalkOrg } from '../../shared/orgProjectWalk';
import type { AdminTab } from '../components/TeamMode/orgWindowState';
import type { CollaborativeDocumentTypeDescriptor } from '../services/CollaborativeDocumentTypeCatalog';
import type { EmbeddedDocumentCandidate } from '../services/embeddedDocumentShare';
import type { FolderShareSkippedFile } from '../services/folderShareCandidates';
import type { FeedbackComposeDestination } from '@nimbalyst/runtime/ui/AgentTranscript/components/CustomToolWidgets/InteractiveWidgetHost';

// ============================================================================
// Types
// ============================================================================

export interface ShareToTeamData {
  fileName: string;
  sourceRelPath: string;
  descriptor: CollaborativeDocumentTypeDescriptor;
  embeddedDocuments?: EmbeddedDocumentCandidate[];
  /** Pre-selects a folder the caller already got an answer for. */
  initialFolderId?: string | null;
  /** Pages sections offered; Team only when absent. */
  sections?: readonly ('team' | 'personal')[];
  initialSection?: 'team' | 'personal';
  onConfirm: (params: {
    section: 'team' | 'personal';
    folderId: string | null;
    folderPath: string;
    sharedName: string;
    selectedEmbeddedDocumentPaths: string[];
  }) => void;
  /**
   * Fires when the dialog closes, confirmed or not -- `DialogProvider` calls it
   * on removal. A caller awaiting the author's answers needs the dismissal too;
   * without it a cancelled share is indistinguishable from one still waiting.
   */
  onDismiss?: () => void;
}

export interface ShareFolderToTeamData {
  folderName: string;
  sourceRelPath: string;
  candidateCount: number;
  skipped: FolderShareSkippedFile[];
  subfolderCount: number;
  truncated: boolean;
  onConfirm: (params: {
    folderId: string | null;
    folderPath: string;
    sharedFolderName: string;
  }) => void;
  /** Same contract as `ShareToTeamData.onDismiss`: closing is not an answer. */
  onDismiss?: () => void;
}

export interface FeedbackDestinationData {
  initialFolderId: string | null;
  subjectCount: number;
  onConfirm: (destination: FeedbackComposeDestination) => void;
  /** Same contract as `ShareToTeamData.onDismiss`: closing is not an answer. */
  onDismiss?: () => void;
}

// ============================================================================
// Registration
// ============================================================================

function ShareToTeamDialogWrapper({
  isOpen,
  onClose,
  data,
}: {
  isOpen: boolean;
  onClose: () => void;
  data: ShareToTeamData;
}) {
  return (
    <ShareToTeamDialog
      isOpen={isOpen}
      onClose={onClose}
      fileName={data.fileName}
      sourceRelPath={data.sourceRelPath}
      descriptor={data.descriptor}
      embeddedDocuments={data.embeddedDocuments}
      initialFolderId={data.initialFolderId}
      sections={data.sections}
      initialSection={data.initialSection}
      onConfirm={data.onConfirm}
    />
  );
}

function ShareFolderToTeamDialogWrapper({
  isOpen,
  onClose,
  data,
}: {
  isOpen: boolean;
  onClose: () => void;
  data: ShareFolderToTeamData;
}) {
  return (
    <ShareFolderToTeamDialog
      isOpen={isOpen}
      onClose={onClose}
      folderName={data.folderName}
      sourceRelPath={data.sourceRelPath}
      candidateCount={data.candidateCount}
      skipped={data.skipped}
      subfolderCount={data.subfolderCount}
      truncated={data.truncated}
      onConfirm={data.onConfirm}
    />
  );
}

function FeedbackDestinationDialogWrapper({
  isOpen,
  onClose,
  data,
}: {
  isOpen: boolean;
  onClose: () => void;
  data: FeedbackDestinationData;
}) {
  return (
    <FeedbackDestinationDialog
      isOpen={isOpen}
      onClose={onClose}
      initialFolderId={data.initialFolderId}
      subjectCount={data.subjectCount}
      onConfirm={data.onConfirm}
    />
  );
}

/**
 * The organization creation wizard. Registered here so every window sharing
 * this registry — the project window, Account settings, the org window — opens
 * the same one.
 */
export interface OrgCreationWizardData {
  onOrganizationCreated?: (orgId: string) => void;
  /** Set by the Sharing entry point: the new org adopts this project. */
  workspacePath?: string;
  /** Pre-fills the name field, e.g. with the project's folder name. */
  suggestedName?: string;
  /** Which surface opened it; reported on the wizard's analytics events. */
  entryPoint?: 'organization_manager' | 'project_sharing';
}

function OrgCreationWizardWrapper({
  isOpen,
  onClose,
  data,
}: {
  isOpen: boolean;
  onClose: () => void;
  data?: OrgCreationWizardData;
}) {
  return (
    <OrgCreationWizard
      isOpen={isOpen}
      onClose={onClose}
      workspacePath={data?.workspacePath}
      suggestedName={data?.suggestedName}
      entryPoint={data?.entryPoint}
      onOrganizationCreated={data?.onOrganizationCreated}
    />
  );
}

/**
 * Organization administration. Registered here for the same reason the wizard
 * is: both windows share this registry, so the project window and the
 * organization window open the same dialog rather than one of them starting a
 * new OS window to administer an org (NIM-2322).
 */
export interface OrgManagementDialogData {
  orgId: string;
  /** Which administration panel to land on; defaults to Members. */
  initialTab?: AdminTab;
}

function OrgManagementDialogWrapper({
  isOpen,
  onClose,
  data,
}: {
  isOpen: boolean;
  onClose: () => void;
  data: OrgManagementDialogData;
}) {
  return (
    <OrgManagementDialog
      isOpen={isOpen}
      onClose={onClose}
      orgId={data.orgId}
      initialTab={data.initialTab}
    />
  );
}

/**
 * The post-sign-in project walk. Registered next to the creation wizard because
 * it answers the mirror-image question: the wizard is for someone who has no
 * organization, this is for someone who has one but no folder bound to it.
 */
export interface OrgProjectWalkData {
  org: ProjectWalkOrg;
  onFinished?: (outcome: ProjectWalkOutcome) => void;
}

function OrgProjectWalkDialogWrapper({
  isOpen,
  onClose,
  data,
}: {
  isOpen: boolean;
  onClose: () => void;
  data: OrgProjectWalkData;
}) {
  return (
    <OrgProjectWalkDialog
      isOpen={isOpen}
      onClose={onClose}
      org={data.org}
      onFinished={data.onFinished}
    />
  );
}

export function registerTeamDialogs() {
  registerDialog<OrgProjectWalkData>({
    id: DIALOG_IDS.ORG_PROJECT_WALK,
    group: 'system',
    component: OrgProjectWalkDialogWrapper as DialogConfig<OrgProjectWalkData>['component'],
    priority: 150,
  });

  registerDialog<OrgManagementDialogData>({
    id: DIALOG_IDS.ORG_MANAGEMENT,
    group: 'system',
    component: OrgManagementDialogWrapper as DialogConfig<OrgManagementDialogData>['component'],
    priority: 150,
  });

  registerDialog<OrgCreationWizardData>({
    id: DIALOG_IDS.ORG_CREATION_WIZARD,
    group: 'system',
    component: OrgCreationWizardWrapper as DialogConfig<OrgCreationWizardData>['component'],
    priority: 150,
  });

  registerDialog<ShareToTeamData>({
    id: DIALOG_IDS.SHARE_TO_TEAM,
    group: 'system',
    component: ShareToTeamDialogWrapper as DialogConfig<ShareToTeamData>['component'],
    priority: 200,
  });

  registerDialog<ShareFolderToTeamData>({
    id: DIALOG_IDS.SHARE_FOLDER_TO_TEAM,
    group: 'system',
    component: ShareFolderToTeamDialogWrapper as DialogConfig<ShareFolderToTeamData>['component'],
    priority: 200,
  });

  registerDialog<FeedbackDestinationData>({
    id: DIALOG_IDS.FEEDBACK_DESTINATION,
    group: 'system',
    component: FeedbackDestinationDialogWrapper as DialogConfig<FeedbackDestinationData>['component'],
    priority: 200,
  });
}

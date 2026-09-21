/**
 * Data-Carrying Dialogs Registration
 *
 * These dialogs require data to be passed when opening (like error messages,
 * file names, callbacks, etc.). They belong to various groups.
 */

import React from 'react';
import type { ExternalSessionSelection, ExternalSessionSyncResponse } from '../../shared/externalSessions';
import { registerDialog } from '../contexts/DialogContext';
import type { DialogConfig } from '../contexts/DialogContext.types';
import { ProjectSelectionDialog } from '../components/ProjectSelectionDialog/ProjectSelectionDialog';
import { ErrorDialog } from '../components/ErrorDialog/ErrorDialog';
import { SessionImportDialog } from '../components/AgenticCoding/SessionImportDialog';
import { BlitzDialog } from '../components/BlitzDialog/BlitzDialog';
import { DIALOG_IDS } from './registry';
import { registerConfirmDialog } from './confirmDialogRegistration';
import { store } from '@nimbalyst/runtime/store';
import { refreshSessionListAtom } from '../store/atoms/sessions';

// Type definitions for dialog data

export interface ProjectSelectionData {
  fileName: string;
  filePath: string;
  suggestedWorkspace?: string;
  onSelectProject: (projectPath: string) => void;
  onCancel: () => void;
}

export interface ErrorDialogData {
  title: string;
  message: string;
  details?: any;
}

export interface SessionImportData {
  workspacePath: string;
}

export interface BlitzDialogData {
  workspacePath: string;
  onCreated: (result: any) => void;
}

// Wrapper components that bridge DialogComponentProps to the original component props

function ProjectSelectionWrapper({
  isOpen,
  onClose,
  data,
}: {
  isOpen: boolean;
  onClose: () => void;
  data: ProjectSelectionData;
}) {
  return (
    <ProjectSelectionDialog
      isOpen={isOpen}
      fileName={data.fileName}
      suggestedWorkspace={data.suggestedWorkspace}
      onSelectProject={(projectPath) => {
        data.onSelectProject(projectPath);
        onClose();
      }}
      onCancel={() => {
        data.onCancel();
        onClose();
      }}
    />
  );
}

function ErrorDialogWrapper({
  isOpen,
  onClose,
  data,
}: {
  isOpen: boolean;
  onClose: () => void;
  data: ErrorDialogData;
}) {
  return (
    <ErrorDialog
      isOpen={isOpen}
      onClose={onClose}
      title={data.title}
      message={data.message}
      details={data.details}
    />
  );
}

function SessionImportWrapper({
  isOpen,
  onClose,
  data,
}: {
  isOpen: boolean;
  onClose: () => void;
  data: SessionImportData;
}) {
  const handleImport = async (sessions: ExternalSessionSelection[]) => {
    const result: ExternalSessionSyncResponse = await window.electronAPI?.invoke('external-sessions:sync', {
      sessions,
      workspacePath: data.workspacePath,
    });
    if (!result?.success || result.failureCount > 0) {
      console.error('[SessionImportDialog] Import failed:', result?.error);
      throw new Error(result?.error || 'Import failed');
    }
    // Refresh the session list so imported sessions appear immediately
    store.set(refreshSessionListAtom);
  };

  return (
    <SessionImportDialog
      isOpen={isOpen}
      onClose={onClose}
      onImport={handleImport}
      currentWorkspacePath={data.workspacePath}
      filterByWorkspace={true}
    />
  );
}

function BlitzDialogWrapper({
  isOpen,
  onClose,
  data,
}: {
  isOpen: boolean;
  onClose: () => void;
  data: BlitzDialogData;
}) {
  return (
    <BlitzDialog
      isOpen={isOpen}
      onClose={onClose}
      onCreated={(result) => {
        data.onCreated(result);
        onClose();
      }}
      workspacePath={data.workspacePath}
    />
  );
}

// Register all data-carrying dialogs
export function registerDataDialogs() {
  registerDialog<ProjectSelectionData>({
    id: DIALOG_IDS.PROJECT_SELECTION,
    group: 'system',
    component:
      ProjectSelectionWrapper as DialogConfig<ProjectSelectionData>['component'],
    priority: 300, // System dialogs have high priority
  });

  registerDialog<ErrorDialogData>({
    id: DIALOG_IDS.ERROR,
    group: 'alert',
    component: ErrorDialogWrapper as DialogConfig<ErrorDialogData>['component'],
    priority: 400, // Errors have highest priority
  });

  registerConfirmDialog();

  registerDialog<SessionImportData>({
    id: DIALOG_IDS.SESSION_IMPORT,
    group: 'system',
    component: SessionImportWrapper as DialogConfig<SessionImportData>['component'],
    priority: 200,
  });

  registerDialog<BlitzDialogData>({
    id: DIALOG_IDS.BLITZ_CREATE,
    group: 'system',
    component: BlitzDialogWrapper as DialogConfig<BlitzDialogData>['component'],
    priority: 100,
  });
}

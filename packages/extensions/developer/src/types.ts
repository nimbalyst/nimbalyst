/**
 * Types for Developer Extension
 */

export interface GitStatus {
  branch: string;
  ahead: number;
  behind: number;
  hasUncommitted: boolean;
  baseBranch?: string;
  isMerged?: boolean;
}

export interface GitCommit {
  hash: string;
  message: string;
  author: string;
  date: string;
}

export interface SessionFileEdit {
  path: string;
  gitStatus: string | null;
  operation: string;
}

export type FileStatus = 'added' | 'modified' | 'deleted';

export interface FileToStage {
  path: string;
  status: FileStatus;
}

export interface CommitProposal {
  filesToStage: (string | FileToStage)[];
  commitMessage: string;
  reasoning: string;
}

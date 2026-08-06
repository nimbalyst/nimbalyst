export type TutorialStartResult =
  | {
      success: true;
      workspacePath: string;
      reused: boolean;
    }
  | {
      success: false;
      error: string;
    };

export type TutorialStatusResult =
  | {
      success: true;
      exists: boolean;
      workspacePath?: string;
    }
  | {
      success: false;
      exists: false;
      error: string;
    };

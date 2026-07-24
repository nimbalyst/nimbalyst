export interface ValidationResult {
  /** Whether the bundle passed validation */
  valid: boolean;

  /** Critical errors that will cause runtime failures */
  errors: string[];

  /** Warnings that may cause issues */
  warnings: string[];
}

/** Shape validation at caller boundaries; Git retains command-specific semantics. */
export function validateGitCwd(value: unknown, field: string): asserts value is string {
  if (typeof value !== 'string' || value.length === 0 || value.includes('\0')) {
    throw new Error(`${field} must be a nonempty string without NUL`);
  }
}

export function validateGitOperand(value: unknown, field: string): asserts value is string {
  validateGitCwd(value, field);
  if (value.startsWith('-')) {
    throw new Error(`${field} must not start with a dash`);
  }
}

export function validateGitOptions(
  value: unknown,
  booleanFields: readonly string[] = [],
  operandFields: readonly string[] = [],
): Record<string, unknown> {
  if (value === undefined) return {};
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('options must be an object');
  }
  const options = value as Record<string, unknown>;
  for (const field of booleanFields) {
    if (options[field] !== undefined && typeof options[field] !== 'boolean') {
      throw new Error(`${field} must be a boolean`);
    }
  }
  for (const field of operandFields) {
    if (options[field] !== undefined) validateGitOperand(options[field], field);
  }
  return options;
}

const REBASE_ACTION_ARGS = {
  continue: '--continue',
  abort: '--abort',
  skip: '--skip',
} as const;

export function validatedGitRebaseArgs(value: unknown): string[] {
  const options = validateGitOptions(value, [], ['target']);
  const action = options.action;
  if (action !== undefined) {
    if (action !== 'continue' && action !== 'abort' && action !== 'skip') {
      throw new Error('action must be continue, abort or skip');
    }
    return ['rebase', REBASE_ACTION_ARGS[action]];
  }
  validateGitOperand(options.target, 'target');
  return ['rebase', options.target];
}

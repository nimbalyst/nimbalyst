/**
 * Utility functions for detecting and categorizing AI provider errors.
 */

/**
 * Detects if an error message indicates a Bedrock tool search incompatibility.
 *
 * This error occurs when alternative AI providers (like AWS Bedrock) don't fully support
 * deferred tool loading (tool search). The specific error pattern is:
 * "Tool reference 'X' not found in available tools"
 *
 * @param errorMessage - The error message to check
 * @returns true if the error is a Bedrock tool search incompatibility
 */
export function isBedrockToolSearchError(errorMessage: unknown): boolean {
  if (typeof errorMessage !== 'string') {
    return false;
  }
  return (
    errorMessage.includes('Tool reference') &&
    errorMessage.includes('not found in available tools')
  );
}

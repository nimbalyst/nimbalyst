/**
 * Stytch B2B Configuration
 *
 * These are PUBLIC tokens - safe to commit to git.
 * They are designed to be embedded in client-side code.
 *
 * DO NOT put the secret key here - it should only exist on the server (collabv3).
 */

export const STYTCH_CONFIG = {
  live: {
    projectId: 'project-live-70b810e0-b201-4cf4-b8e8-2b694fd4515f',
    publicToken: 'public-token-live-db5dfb0e-6423-4166-8366-164f4138e0ff',
    apiBase: 'https://api.stytch.com/v1/b2b',
  },
};

/**
 * Get the Stytch config.
 */
export function getStytchConfig() {
  // Allow override via environment variable
  if (process.env.STYTCH_PROJECT_ID && process.env.STYTCH_PUBLIC_TOKEN) {
    return {
      projectId: process.env.STYTCH_PROJECT_ID,
      publicToken: process.env.STYTCH_PUBLIC_TOKEN,
      apiBase: 'https://api.stytch.com/v1/b2b',
    };
  }

  return STYTCH_CONFIG.live;
}

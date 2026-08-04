import type { PendingAuthFlowLedger, AuthIntent } from './PendingAuthFlowLedger';

export interface IntentAwareAuthCallbackParams {
  intent: AuthIntent;
  targetPersonalOrgId?: string;
  sessionToken: string;
  sessionJwt?: string;
  userId?: string;
  email?: string;
  expiresAt?: string;
  orgId: string;
}

export type AuthCallbackRejectionReason =
  | 'not-loopback'
  | 'missing-state'
  | 'unknown-state'
  | 'server-error'
  | 'missing-session-token'
  | 'missing-org-id';

/** What applying a callback did, so callers can react to sign-in but not to a secondary account add. */
export interface AuthCallbackEffect {
  /** True when the callback changed the identity personal sync runs as. */
  affectsSyncIdentity: boolean;
}

export type AuthCallbackRouteResult =
  | { success: true; affectsSyncIdentity: boolean }
  | { success: false; reason: AuthCallbackRejectionReason; details?: Record<string, string | null> };

export async function routeAuthCallbackUrl(
  rawUrl: string,
  ledger: PendingAuthFlowLedger,
  handleCallback: (params: IntentAwareAuthCallbackParams) => Promise<AuthCallbackEffect>,
): Promise<AuthCallbackRouteResult> {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return { success: false, reason: 'not-loopback' };
  }

  if (
    parsed.protocol !== 'http:'
    || parsed.hostname !== '127.0.0.1'
    || parsed.pathname !== '/auth/callback'
    || !parsed.port
  ) {
    return { success: false, reason: 'not-loopback' };
  }

  const state = parsed.searchParams.get('state');
  if (!state) return { success: false, reason: 'missing-state' };

  const flow = ledger.consume(state, Number(parsed.port));
  if (!flow) return { success: false, reason: 'unknown-state' };

  const error = parsed.searchParams.get('error');
  const errorDescription = parsed.searchParams.get('error_description');
  const stytchErrorType = parsed.searchParams.get('stytch_error_type');
  if (error || errorDescription || stytchErrorType) {
    return {
      success: false,
      reason: 'server-error',
      details: { error, errorDescription, stytchErrorType },
    };
  }

  const sessionToken = parsed.searchParams.get('session_token');
  if (!sessionToken) return { success: false, reason: 'missing-session-token' };

  const orgId = parsed.searchParams.get('org_id');
  if (!orgId) return { success: false, reason: 'missing-org-id' };

  const effect = await handleCallback({
    intent: flow.intent,
    targetPersonalOrgId: flow.targetPersonalOrgId,
    sessionToken,
    sessionJwt: parsed.searchParams.get('session_jwt') ?? undefined,
    userId: parsed.searchParams.get('user_id') ?? undefined,
    email: parsed.searchParams.get('email') ?? undefined,
    expiresAt: parsed.searchParams.get('expires_at') ?? undefined,
    orgId,
  });
  return { success: true, affectsSyncIdentity: effect.affectsSyncIdentity };
}

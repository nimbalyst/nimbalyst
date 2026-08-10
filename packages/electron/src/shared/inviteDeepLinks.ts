export interface InviteDeepLinkTarget {
  orgId: string;
  /**
   * Address the invitation was sent to. Advisory: it selects which signed-in
   * account should own the acceptance and prefills the sign-in prompt when no
   * account matches. Membership itself is decided by the server, never by this
   * value.
   */
  email?: string;
}

/**
 * Parse and validate a team-invitation deep link at the main-process routing
 * boundary: `nimbalyst://invite/{orgId}?email={email}`.
 *
 * The link deliberately carries no Stytch token. The desktop app accepts an
 * invitation by exchanging an already-signed-in session for the org
 * (`TeamService.acceptInvite`), so an emailed link never needs to transport
 * credentials — and the auth deep-link nonce gate stays closed.
 */
export function parseInviteDeepLink(rawUrl: string): InviteDeepLinkTarget {
  const parsed = new URL(rawUrl);
  const isInviteRoute = parsed.protocol === 'nimbalyst:'
    && (parsed.host === 'invite' || parsed.pathname.startsWith('/invite/'));
  if (!isInviteRoute) {
    throw new Error('URL is not a Nimbalyst invite deep link');
  }

  const encodedOrgId = parsed.host === 'invite'
    ? parsed.pathname.replace(/^\//, '')
    : parsed.pathname.replace('/invite/', '');

  let orgId: string;
  try {
    orgId = decodeURIComponent(encodedOrgId);
  } catch {
    throw new Error('Invite deep link has a malformed orgId');
  }

  if (!orgId) {
    throw new Error('Invite deep link requires an orgId');
  }

  const email = parsed.searchParams.get('email')?.trim().toLowerCase();

  return {
    orgId,
    ...(email ? { email } : {}),
  };
}

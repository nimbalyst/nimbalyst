import { afterEach, describe, expect, it, vi } from 'vitest';

import { startAuthCallbackLoopback, type AuthCallbackLoopbackController } from '../AuthCallbackLoopback';
import { routeAuthCallbackUrl } from '../AuthCallbackRouting';
import { PendingAuthFlowLedger } from '../PendingAuthFlowLedger';

describe('auth callback loopback listener', () => {
  let controller: AuthCallbackLoopbackController | null = null;

  afterEach(async () => {
    await controller?.close();
    controller = null;
  });

  async function startFlow() {
    const ledger = new PendingAuthFlowLedger();
    const nonce = ledger.createNonce();
    const handleCallback = vi.fn(async () => ({ affectsSyncIdentity: false }));
    const onSuccess = vi.fn();
    controller = await startAuthCallbackLoopback({
      state: nonce,
      onCallback: async (url) => {
        const result = await routeAuthCallbackUrl(url, ledger, handleCallback);
        return {
          success: result.success,
          affectsSyncIdentity: result.success ? result.affectsSyncIdentity : false,
        };
      },
      onSuccess,
    });
    ledger.register(nonce, {
      intent: 'add-account',
      method: 'google',
      port: controller.port,
    });
    return { ledger, nonce, handleCallback, onSuccess };
  }

  it('serves one successful callback, routes its params, and closes', async () => {
    const { handleCallback, onSuccess } = await startFlow();
    const response = await fetch(
      `${controller!.callbackUrl}&session_token=token&session_jwt=a.b.c&user_id=member&email=user%40example.com&org_id=personal-org`,
    );

    expect(response.status).toBe(200);
    await expect(response.text()).resolves.toContain("You're signed in");
    expect(handleCallback).toHaveBeenCalledWith(expect.objectContaining({
      intent: 'add-account',
      sessionToken: 'token',
      sessionJwt: 'a.b.c',
      userId: 'member',
      email: 'user@example.com',
      orgId: 'personal-org',
    }));
    expect(onSuccess).toHaveBeenCalledOnce();
    await expect(fetch(controller!.callbackUrl)).rejects.toThrow();
  });

  /**
   * Any local process — or any web page the user has open — can reach this
   * port. A request without the flow's nonce must not consume the one-shot
   * listener, or the real callback arrives to find it closed.
   */
  it('leaves the listener usable after a request with no nonce', async () => {
    const { handleCallback, onSuccess } = await startFlow();
    const response = await fetch(
      `${controller!.callbackBaseUrl}?session_token=token&org_id=personal-org`,
    );

    expect(response.status).toBe(404);
    expect(handleCallback).not.toHaveBeenCalled();
    expect(onSuccess).not.toHaveBeenCalled();

    const real = await fetch(
      `${controller!.callbackUrl}&session_token=token&org_id=personal-org`,
    );
    expect(real.status).toBe(200);
    expect(handleCallback).toHaveBeenCalledOnce();
  });

  it('feeds server errors and missing org_id through callback validation', async () => {
    const errorFlow = await startFlow();
    const errorResponse = await fetch(`${controller!.callbackUrl}&error=oauth_failed&error_description=Denied`);
    expect(errorResponse.status).toBe(400);
    expect(errorFlow.handleCallback).not.toHaveBeenCalled();
    await controller!.close();
    controller = null;

    const missingOrgFlow = await startFlow();
    const missingOrgResponse = await fetch(`${controller!.callbackUrl}&session_token=token`);
    expect(missingOrgResponse.status).toBe(400);
    expect(missingOrgFlow.handleCallback).not.toHaveBeenCalled();
  });

  it('rejects a wrong nonce and still serves the real callback afterwards', async () => {
    const { ledger, nonce, handleCallback, onSuccess } = await startFlow();
    const probe = await fetch(
      `${controller!.callbackBaseUrl}?state=wrong&session_token=token&org_id=personal-org`,
    );

    expect(probe.status).toBe(404);
    expect(handleCallback).not.toHaveBeenCalled();
    expect(ledger.peek(nonce)).not.toBeNull();

    const real = await fetch(
      `${controller!.callbackUrl}&session_token=token&session_jwt=a.b.c&org_id=personal-org`,
    );
    expect(real.status).toBe(200);
    expect(handleCallback).toHaveBeenCalledWith(expect.objectContaining({
      sessionToken: 'token',
      orgId: 'personal-org',
    }));
    expect(onSuccess).toHaveBeenCalledOnce();
  });

  /**
   * The server delivers auth params as an auto-submitting form POST so tokens
   * never appear in a URL: only the nonce rides in the query string.
   */
  it('accepts a form POST whose nonce is in the query and tokens in the body', async () => {
    const { handleCallback, onSuccess } = await startFlow();
    const response = await fetch(controller!.callbackUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        session_token: 'token',
        session_jwt: 'a.b.c',
        user_id: 'member',
        email: 'user@example.com',
        org_id: 'personal-org',
      }).toString(),
    });

    expect(response.status).toBe(200);
    await expect(response.text()).resolves.toContain("You're signed in");
    expect(handleCallback).toHaveBeenCalledWith(expect.objectContaining({
      intent: 'add-account',
      sessionToken: 'token',
      sessionJwt: 'a.b.c',
      userId: 'member',
      email: 'user@example.com',
      orgId: 'personal-org',
    }));
    expect(onSuccess).toHaveBeenCalledOnce();
  });

  it('rejects a POST whose body exceeds the cap without consuming the flow', async () => {
    const { ledger, nonce, handleCallback } = await startFlow();
    const response = await fetch(controller!.callbackUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: `session_token=${'x'.repeat(70 * 1024)}&org_id=personal-org`,
    });

    expect(response.status).toBe(413);
    expect(handleCallback).not.toHaveBeenCalled();
    expect(ledger.peek(nonce)).not.toBeNull();
  });

  it('rejects legacy nimbalyst callbacks even when they carry a known nonce', async () => {
    const ledger = new PendingAuthFlowLedger();
    const nonce = ledger.createNonce();
    ledger.register(nonce, { intent: 'sign-in', method: 'google', port: 4400 });
    const handleCallback = vi.fn(async () => ({ affectsSyncIdentity: false }));

    await expect(routeAuthCallbackUrl(
      `nimbalyst://auth/callback?state=${nonce}&session_token=token&org_id=personal-org`,
      ledger,
      handleCallback,
    )).resolves.toEqual({ success: false, reason: 'not-loopback' });
    expect(handleCallback).not.toHaveBeenCalled();
    expect(ledger.peek(nonce)).not.toBeNull();
  });

  it('closes the listener when its TTL expires', async () => {
    let closed!: () => void;
    const closedPromise = new Promise<void>((resolve) => {
      closed = resolve;
    });
    controller = await startAuthCallbackLoopback({
      state: 'short-lived',
      ttlMs: 20,
      onCallback: async () => ({ success: true, affectsSyncIdentity: true }),
      onClose: closed,
    });

    await closedPromise;
    await expect(fetch(controller.callbackUrl)).rejects.toThrow();
  });
});

// @vitest-environment node
import { describe, expect, it } from "vitest";

import {
  CREDENTIAL_ENV_VARS,
  IMPLICIT_SELECTION_ENV_VARS,
  sanitizeWranglerEnv,
} from "../wranglerEnv";

describe("sanitizeWranglerEnv", () => {
  it("strips every credential-bearing Cloudflare variable so Wrangler can only use its own profile store", () => {
    const sanitized = sanitizeWranglerEnv({
      PATH: "/usr/bin",
      CLOUDFLARE_API_TOKEN: "tok",
      CLOUDFLARE_API_KEY: "key",
      CLOUDFLARE_EMAIL: "a@b.c",
      CLOUDFLARE_CF_AUTH: "1",
      WRANGLER_CF_AUTHORIZATION_TOKEN: "tok",
      CLOUDFLARE_ACCESS_CLIENT_ID: "id",
      CLOUDFLARE_ACCESS_CLIENT_SECRET: "secret",
      CF_API_TOKEN: "legacy",
    });

    for (const name of CREDENTIAL_ENV_VARS) {
      expect(sanitized[name]).toBeUndefined();
    }
    expect(sanitized.PATH).toBe("/usr/bin");
  });

  it("strips implicit account, environment and auth-endpoint selection so nothing is chosen for the user", () => {
    const sanitized = sanitizeWranglerEnv({
      CLOUDFLARE_ACCOUNT_ID: "implicit-account",
      CLOUDFLARE_ENV: "production",
      CLOUDFLARE_API_BASE_URL: "https://evil.example",
      CF_API_BASE_URL: "https://alias.example.invalid",
      WRANGLER_AUTH_URL: "https://evil.example/auth",
      CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV: "true",
    });

    for (const name of IMPLICIT_SELECTION_ENV_VARS) {
      expect(sanitized[name]).toBeUndefined();
    }
    expect(sanitized.CF_API_BASE_URL).toBeUndefined();
  });

  it("ignores case so a Windows-style CLOUDFLARE_API_TOKEN cannot survive as Cloudflare_Api_Token", () => {
    const sanitized = sanitizeWranglerEnv({
      Cloudflare_Api_Token: "tok",
      cloudflare_account_id: "implicit",
    } as NodeJS.ProcessEnv);

    expect(Object.keys(sanitized)).toEqual([]);
  });

  it("drops undefined values and applies explicit overrides last", () => {
    const sanitized = sanitizeWranglerEnv(
      { PATH: "/usr/bin", EMPTY: undefined },
      { WRANGLER_SEND_METRICS: "false" }
    );

    expect(sanitized).toEqual({
      PATH: "/usr/bin",
      WRANGLER_SEND_METRICS: "false",
    });
  });

  it("refuses an override that would reintroduce a stripped variable", () => {
    expect(() =>
      sanitizeWranglerEnv({}, { CLOUDFLARE_API_TOKEN: "sneaky" })
    ).toThrow(/CLOUDFLARE_API_TOKEN/);
  });
});

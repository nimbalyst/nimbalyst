/**
 * The detector table. Each entry finds one class of shaped secret.
 *
 * Two guards keep this from becoming a false-positive machine, because a
 * redactor that mangles ordinary prose gets turned off:
 *
 * - `group` lets a pattern match a *context* (`aws_secret_access_key = X`,
 *   `postgres://user:pw@host`) while redacting only the credential inside it.
 * - `validate` rejects a syntactically-matching candidate that is obviously not
 *   a live secret — a documented placeholder, a low-entropy kebab identifier.
 *
 * Detectors whose prefix is itself decisive (`AIza`, `ghp_`, `AKIA`, PEM
 * headers) skip the entropy check: nothing but a real key is shaped that way,
 * and demanding entropy on top would only create misses.
 */
import type { SecretKind } from './types.js';

export interface Detector {
  kind: SecretKind;
  label: string;
  /** Must be a global regex. */
  pattern: RegExp;
  /**
   * Capture group holding the credential. 0 (default) redacts the whole match;
   * a positive index redacts only that group, preserving the surrounding
   * context line so the page still reads.
   */
  group?: number;
  /** Rejects a candidate that matched syntactically but is not a live secret. */
  validate?: (secret: string, fullMatch: RegExpExecArray) => boolean;
  /**
   * Higher wins when two detectors claim overlapping spans. A JWT inside an
   * `Authorization: Bearer` header should be reported as a JWT.
   */
  priority: number;
}

/**
 * Text that is plainly a stand-in rather than a credential: docs, templates,
 * and already-redacted material. Redacting `sk-xxxxxxxxxxxxxxxxxxxx` out of a
 * page explaining key formats destroys the page's only content.
 */
export function looksLikePlaceholder(value: string): boolean {
  const v = value.trim().replace(/^["'`]|["'`]$/g, '');
  if (!v) return true;
  if (/^[$]\{?[A-Za-z_]/.test(v)) return true; // $VAR / ${VAR} interpolation
  if (/^<[^>]*>$/.test(v)) return true; // <your-key-here>
  if (/(x{6,}|X{6,}|\*{4,}|\.{3,}|_{4,}|0{8,})/.test(v)) return true;
  if (/(your|my|some|the)[_-]?(api[_-]?)?(key|token|secret|password)/i.test(v)) return true;
  if (/\b(example|placeholder|redacted|dummy|sample|fake|changeme|todo|insert|replace|here)\b/i.test(v))
    return true;
  if (/^(?:[A-Za-z0-9]{1,3}[-_])?(?:abc|xyz|test|foo|bar)[0-9]{0,4}$/i.test(v)) return true;
  return false;
}

/**
 * Entropy floor for the patterns whose prefix is weak. A live key mixes case
 * and digits; a kebab-case identifier that happens to start `sk-` does not.
 * (`sk-spinner-double-bounce1` is a real CSS class and matches the OpenAI shape
 * on length alone.)
 */
export function hasKeyEntropy(value: string): boolean {
  const body = value.replace(/^[a-z]+[-_](?:[a-z0-9]+[-_])?/i, '');
  const hasLower = /[a-z]/.test(body);
  const hasUpper = /[A-Z]/.test(body);
  const hasDigit = /[0-9]/.test(body);
  const classes = Number(hasLower) + Number(hasUpper) + Number(hasDigit);
  if (classes >= 3) return true;
  // All-lowercase-plus-digits is only credible when it is long and unbroken;
  // hyphens mean it is far more likely to be an identifier.
  return classes >= 2 && !/[-_]/.test(body) && body.length >= 24;
}

/** A digit run is a payment card only if it passes Luhn. */
export function luhnValid(digits: string): boolean {
  if (digits.length < 13 || digits.length > 19) return false;
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i -= 1) {
    let d = digits.charCodeAt(i) - 48;
    if (d < 0 || d > 9) return false;
    if (double) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    double = !double;
  }
  return sum % 10 === 0;
}

/**
 * Names that end in a sensitive-looking word but hold nothing secret. Without
 * this, `PUBLIC_KEY=` and `SESSION_KEY_PATH=` are redacted.
 */
const NON_SECRET_ENV_WORD = /(?:^|_)(?:PUBLIC|KEYBOARD|KEYMAP|KEYCODE|CERT|CA)(?:_|$)/i;
const NON_SECRET_ENV_SUFFIX = /_(?:PATH|FILE|DIR|NAME|URL|URI|ID|ALGORITHM|TYPE|ENABLED|LENGTH|EXPIRY)$/i;
const SECRET_ENV_NAME = /(?:^|_)(?:API_?KEY|KEY|TOKEN|SECRET|PASSWORD|PASSWD|PWD|CREDENTIAL|CREDENTIALS|DSN)$/i;

/** True when the variable name promises a credential and nothing benign. */
export function isSecretEnvName(name: string): boolean {
  return SECRET_ENV_NAME.test(name) && !NON_SECRET_ENV_WORD.test(name) && !NON_SECRET_ENV_SUFFIX.test(name);
}

/** Marker prefixes recognised as PEM private-key material. */
export const PRIVATE_KEY_BLOCK =
  /-----BEGIN (?:[A-Z0-9 ]+ )?PRIVATE KEY(?: BLOCK)?-----[\s\S]{0,8192}?-----END (?:[A-Z0-9 ]+ )?PRIVATE KEY(?: BLOCK)?-----/g;

export const DEFAULT_DETECTORS: readonly Detector[] = [
  {
    kind: 'private-key-block',
    label: 'PEM private key block',
    pattern: PRIVATE_KEY_BLOCK,
    priority: 100,
  },
  {
    kind: 'anthropic-api-key',
    label: 'Anthropic API key',
    pattern: /\bsk-ant-[A-Za-z0-9_-]{20,}/g,
    priority: 90,
    validate: (s) => !looksLikePlaceholder(s),
  },
  {
    kind: 'openai-api-key',
    label: 'OpenAI API key',
    pattern: /\bsk-(?!ant-)(?:proj-|svcacct-|admin-|None-)?[A-Za-z0-9_-]{20,}/g,
    priority: 89,
    validate: (s) => !looksLikePlaceholder(s) && hasKeyEntropy(s),
  },
  {
    kind: 'google-api-key',
    label: 'Google API key',
    pattern: /\bAIza[0-9A-Za-z_-]{35}\b/g,
    priority: 88,
    validate: (s) => !looksLikePlaceholder(s),
  },
  {
    kind: 'github-token',
    label: 'GitHub token',
    pattern: /\b(?:gh[pousr]_[A-Za-z0-9]{36,255}|github_pat_[A-Za-z0-9_]{22,255})\b/g,
    priority: 88,
  },
  {
    kind: 'aws-access-key-id',
    label: 'AWS access key id',
    pattern: /\b(?:AKIA|ASIA|AGPA|AIDA|AROA|AIPA|ANPA|ANVA|ABIA)[0-9A-Z]{16}\b/g,
    priority: 88,
  },
  {
    kind: 'aws-secret-access-key',
    label: 'AWS secret access key',
    // Unshaped on its own (40 base64 chars looks like plenty of other things),
    // so this is context-gated on the key name rather than pattern alone.
    pattern:
      /(?:aws_?secret_?access_?key|aws_?secret_?key|secretAccessKey)["']?\s*[:=]\s*["']?([A-Za-z0-9/+=]{40})(?=["']|\s|$)/gi,
    group: 1,
    priority: 87,
    validate: (s) => !looksLikePlaceholder(s),
  },
  {
    kind: 'slack-token',
    label: 'Slack token',
    pattern: /\bxox[baprse]-[A-Za-z0-9-]{10,}/g,
    priority: 86,
    validate: (s) => !looksLikePlaceholder(s),
  },
  {
    kind: 'stripe-key',
    label: 'Stripe secret key',
    pattern: /\b[rs]k_(?:live|test)_[A-Za-z0-9]{16,}\b/g,
    priority: 86,
    validate: (s) => !looksLikePlaceholder(s),
  },
  {
    kind: 'npm-token',
    label: 'npm access token',
    pattern: /\bnpm_[A-Za-z0-9]{36}\b/g,
    priority: 86,
  },
  {
    kind: 'jwt',
    label: 'JSON Web Token',
    // Two base64url segments that both start `eyJ` (i.e. both decode to `{"`)
    // is decisive; nothing else in prose is shaped that way.
    pattern: /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,
    priority: 85,
  },
  {
    kind: 'bearer-token',
    label: 'Bearer token',
    pattern: /\b(?:Bearer|Token)\s+([A-Za-z0-9._~+/-]{20,}={0,2})/g,
    group: 1,
    priority: 60,
    validate: (s) => !looksLikePlaceholder(s) && hasKeyEntropy(s),
  },
  {
    kind: 'basic-auth-credentials',
    label: 'HTTP Basic credentials',
    pattern: /\bBasic\s+([A-Za-z0-9+/]{16,}={0,2})/g,
    group: 1,
    priority: 60,
    validate: (s) => !looksLikePlaceholder(s),
  },
  {
    kind: 'connection-string-password',
    label: 'Password in a connection string',
    // Redacts only the password so the scheme, user and host survive — which
    // is usually the part of the memory that carried the meaning.
    pattern: /\b[a-z][a-z0-9+.-]*:\/\/[^\s:@/]+:([^\s@/]+)@/gi,
    group: 1,
    priority: 80,
    validate: (s) => !looksLikePlaceholder(s),
  },
  {
    kind: 'env-assignment',
    label: 'Credential in an environment assignment',
    pattern: /^[ \t]*(?:export[ \t]+)?([A-Za-z_][A-Za-z0-9_]*)[ \t]*=[ \t]*(\S[^\n]*)$/gm,
    group: 2,
    priority: 50,
    validate: (secret, match) => {
      const name = match[1] ?? '';
      if (!isSecretEnvName(name)) return false;
      const value = secret.trim().replace(/^["'`]|["'`]$/g, '');
      if (value.length < 8) return false;
      return !looksLikePlaceholder(value);
    },
  },
];

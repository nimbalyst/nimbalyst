// @vitest-environment node
/**
 * The write gate is the only thing standing between a pasted credential and
 * `memory/facts.jsonl`, which is permanent in git history. Two failure modes
 * matter equally and both are covered by tables here:
 *
 * - a **miss** puts a live secret in a shared, committed file;
 * - a **false positive** mangles ordinary engineering prose, and a redactor
 *   that eats UUIDs and git SHAs is one the user turns off.
 *
 * Every secret below is fabricated and valid nowhere. They are assembled from
 * fragments rather than written as literals: the runtime values are identical,
 * so the detectors are exercised just as honestly, but no complete credential
 * shape appears in the source. Scanners match on shape alone, and a contributor
 * whose push is blocked by a fake AWS key sitting in a redaction test has no
 * way to tell that it is fake. Keep new fixtures in this style.
 */
import { describe, expect, it } from 'vitest';
import { evaluateBlocklist } from '../blocklist.js';
import { redactSecrets } from '../redact.js';
import { screenMemoryText } from '../screen.js';
import type { SecretKind } from '../types.js';

/** Joins fixture fragments so the assembled credential never appears in source. */
const shaped = (...parts: string[]): string => parts.join('');

const PEM_BLOCK = [
  shaped('-----BEGIN ', 'RSA PRIVATE KEY', '-----'),
  'MIIEowIBAAKCAQEAyT8vQ2mLpXcR5nYw9KdZbA3sFgJ1uEoI7rNtVxQ0hT8vQ2mL',
  'pXcR5nYw9KdZbA3sFgJ1uEoI7rNtVxQ0hT8vQ2mLpXcR5nYw9KdZbA3sFgJ1uEoI',
  shaped('-----END ', 'RSA PRIVATE KEY', '-----'),
].join('\n');

const OPENAI_KEY = shaped('sk-', 'proj-', '9aQ2mZx7Kd1LrTvB4nHs6WpYc3JeUf0GiOaXzR5tMqNw8ZbD');
const ANTHROPIC_KEY = shaped(
  'sk-',
  'ant-',
  'api03-',
  'Xk92LmQvTb7RfWz4Np1YsHc6JdEa0GuIoAxZ5MrVtNw8-BqDfEg'
);
const GOOGLE_KEY = shaped('AIza', 'SyD-9tSrke72PouQMnMX-a7eZSW0jkFMBWY');
const GITHUB_PAT = shaped('ghp', '_16C7e42F292c6912E7710c838347Ae178B4a');
const GITHUB_OAUTH_TOKEN = shaped('gho', '_9Vk2mLpQrXcTnYwZbAsDfGhJkL3nM5pQ7rS9');
const AWS_ACCESS_KEY_ID = shaped('AKIA', '3RJQ7XZL2NPWVK4T');
const AWS_SECRET_ACCESS_KEY = shaped('hT8vQ2mLpXcR5nYw9KdZ', 'bA3sFgJ1uEoI7rNtVxQ0');
const SLACK_BOT_TOKEN = shaped('xoxb', '-2394857203948-2938475029384-9Vk2mLpQrXcTnYwZbAsD');
const STRIPE_LIVE_KEY = shaped('sk', '_live_', '51H8vQ2mLpXcR5nYw9KdZbA3s');
const NPM_TOKEN = shaped('npm', '_9Vk2mLpQrXcTnYwZbAsDfGhJkL3nM5pQ7rS9');
const EXPIRED_JWT = shaped(
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.',
  'eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIn0.',
  'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk'
);
const BEARER_JWT = shaped(
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.',
  'eyJzdWIiOiI0MiIsIm5hbWUiOiJOaW1iIn0.',
  'QrXcTnYwZbAsDfGhJkL3nM5pQ7rS9aB3dEf7hIjK'
);

describe('redactSecrets — shaped secrets', () => {
  const cases: Array<{ name: string; kind: SecretKind; text: string; secret: string }> = [
    {
      name: 'OpenAI project key',
      kind: 'openai-api-key',
      secret: OPENAI_KEY,
      text: `We hit the rate limit with ${OPENAI_KEY} on the batch job.`,
    },
    {
      name: 'Anthropic key',
      kind: 'anthropic-api-key',
      secret: ANTHROPIC_KEY,
      text: `Key in use: ${ANTHROPIC_KEY}`,
    },
    {
      name: 'Google API key',
      kind: 'google-api-key',
      secret: GOOGLE_KEY,
      text: `Maps calls use ${GOOGLE_KEY} from the desktop build.`,
    },
    {
      name: 'GitHub personal token',
      kind: 'github-token',
      secret: GITHUB_PAT,
      text: `CI auth: ${GITHUB_PAT}`,
    },
    {
      name: 'GitHub OAuth token',
      kind: 'github-token',
      secret: GITHUB_OAUTH_TOKEN,
      text: `The device flow returned ${GITHUB_OAUTH_TOKEN} for the app.`,
    },
    {
      name: 'AWS access key id',
      kind: 'aws-access-key-id',
      secret: AWS_ACCESS_KEY_ID,
      text: `The deploy role uses ${AWS_ACCESS_KEY_ID} in us-east-1.`,
    },
    {
      name: 'AWS secret access key, context-gated',
      kind: 'aws-secret-access-key',
      secret: AWS_SECRET_ACCESS_KEY,
      text: `aws_secret_access_key = ${AWS_SECRET_ACCESS_KEY}`,
    },
    {
      name: 'Slack bot token',
      kind: 'slack-token',
      secret: SLACK_BOT_TOKEN,
      text: `Bot posts with ${SLACK_BOT_TOKEN}`,
    },
    {
      name: 'Stripe live key',
      kind: 'stripe-key',
      secret: STRIPE_LIVE_KEY,
      text: `Billing runs on ${STRIPE_LIVE_KEY} in production.`,
    },
    {
      name: 'npm token',
      kind: 'npm-token',
      secret: NPM_TOKEN,
      text: `.npmrc holds ${NPM_TOKEN} for the private scope.`,
    },
    {
      name: 'JWT',
      kind: 'jwt',
      secret: EXPIRED_JWT,
      text: `The session JWT was ${EXPIRED_JWT} and it had expired.`,
    },
    {
      name: 'bearer token',
      kind: 'bearer-token',
      secret: 'aB3dEf7hIjKlMn9pQrStUvWxYz0123456789',
      text: 'Authorization: Bearer aB3dEf7hIjKlMn9pQrStUvWxYz0123456789',
    },
    {
      name: 'HTTP basic credentials',
      kind: 'basic-auth-credentials',
      secret: 'YWRtaW46c3VwZXJzZWNyZXRwYXNz',
      text: 'Authorization: Basic YWRtaW46c3VwZXJzZWNyZXRwYXNz',
    },
    {
      name: 'PEM private key block',
      kind: 'private-key-block',
      secret: PEM_BLOCK,
      text: `The signing key we rotated:\n${PEM_BLOCK}\nand it is now in 1Password.`,
    },
    {
      name: 'password inside a connection string',
      kind: 'connection-string-password',
      secret: 'Hunter2Tr0ub4dorZ',
      text: 'Staging points at postgres://nimbalyst:Hunter2Tr0ub4dorZ@db.internal:5432/app',
    },
    {
      name: 'env-style credential assignment',
      kind: 'env-assignment',
      secret: 'Zq7Vn3RpKdW2sYtLbXc',
      text: 'Set it in the shell:\nDEPLOY_TOKEN=Zq7Vn3RpKdW2sYtLbXc\nthen rerun.',
    },
  ];

  it.each(cases)('redacts $name', ({ kind, text, secret }) => {
    const result = redactSecrets(text);

    expect(result.redacted).toBe(true);
    expect(result.text).not.toContain(secret);
    expect(result.text).toContain(`[redacted:${kind}]`);

    const finding = result.findings.find((f) => f.kind === kind);
    expect(finding).toBeDefined();
    // Offsets address the ORIGINAL text, so a review UI can highlight the source.
    expect(text.slice(finding!.start, finding!.end)).toBe(secret);
    // The preview identifies the secret without reproducing anything usable.
    expect(secret).not.toContain(finding!.preview);
  });

  it('keeps the surrounding page rather than rejecting it', () => {
    const text = `We moved the nightly export to 03:00 UTC because the 02:00 run collided with the backup window. The job authenticates with ${OPENAI_KEY} and writes to the reports bucket.`;
    const result = redactSecrets(text);

    expect(result.text).toContain('collided with the backup window');
    expect(result.text).toContain('writes to the reports bucket');
    expect(result.findings).toHaveLength(1);
  });

  it('reports the higher-priority class when two detectors claim the same span', () => {
    const result = redactSecrets(`Authorization: Bearer ${BEARER_JWT}`);

    expect(result.findings.map((f) => f.kind)).toEqual(['jwt']);
    expect(result.text).toBe('Authorization: Bearer [redacted:jwt]');
  });

  it('reports line numbers so a long page can be reviewed', () => {
    const text = ['first line', 'second line', 'DEPLOY_TOKEN=Zq7Vn3RpKdW2sYtLbXc'].join('\n');
    expect(redactSecrets(text).findings[0]?.line).toBe(3);
  });
});

describe('redactSecrets — must NOT fire', () => {
  const negatives: Array<{ name: string; text: string }> = [
    { name: 'a UUID', text: 'The session id is 550e8400-e29b-41d4-a716-446655440000 in the transcript table.' },
    { name: 'a git SHA', text: 'Fixed in 5c8991497e2a1b3c4d5e6f708192a3b4c5d6e7f8 on main.' },
    {
      name: 'a base64 image fragment',
      text: 'The icon inlines as data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg== which bloats the bundle.',
    },
    {
      name: 'a documented placeholder key',
      text: 'Docs say to run `export ANTHROPIC_API_KEY=<your-api-key>` before starting.',
    },
    {
      name: 'an x-masked example key',
      text: 'Anthropic keys look like sk-ant-api03-xxxxxxxxxxxxxxxxxxxxxxxxxxxx in the docs.',
    },
    {
      name: 'an env var named in prose with no value',
      text: 'A user had ANTHROPIC_API_KEY in a .env file for unrelated work and Nimbalyst picked it up.',
    },
    { name: 'a public key assignment', text: 'PUBLIC_KEY=MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAyT8v' },
    { name: 'a key path assignment', text: 'SIGNING_KEY_PATH=/etc/ssl/private/server.key' },
    { name: 'a non-credential assignment', text: 'NODE_ENV=production' },
    { name: 'a kebab-case identifier starting sk-', text: 'The spinner uses the sk-spinner-double-bounce1 class from the vendor CSS.' },
    { name: 'a PEM public key block', text: '-----BEGIN PUBLIC KEY-----\nMIIBIjANBgkqhkiG9w0BAQEFAAO\n-----END PUBLIC KEY-----' },
    { name: 'a URL with a port', text: 'The dev server listens on https://localhost:5273/index.html' },
    { name: 'an ssh remote', text: 'The remote is git@github.com:nimbalyst/nimbalyst.git' },
    { name: 'a semver and a hash-like build id', text: 'Release v0.76.3 built from 3f9a2c1 with electron 38.2.1.' },
  ];

  it.each(negatives)('leaves $name alone', ({ text }) => {
    const result = redactSecrets(text);
    expect(result.findings).toEqual([]);
    expect(result.text).toBe(text);
  });
});

describe('screenMemoryText', () => {
  it('stores a redacted page when the prose survives', () => {
    const result = screenMemoryText(
      `The nightly indexer authenticates with ${OPENAI_KEY} and runs after the backup window closes at 03:00 UTC.`
    );

    expect(result.ok).toBe(true);
    expect(result.redactions).toHaveLength(1);
    expect(result.blocks).toEqual([]);
    expect(result.text).toContain('after the backup window closes');
  });

  it('refuses a page that is nothing but a key', () => {
    const result = screenMemoryText(OPENAI_KEY);

    expect(result.ok).toBe(false);
    expect(result.blocks.map((b) => b.rule)).toContain('redaction-left-nothing');
  });

  it('refuses a page the blocklist caught even when redaction found nothing', () => {
    const result = screenMemoryText('Reminder: the staging deploy password is correct-horse-battery.');

    expect(result.ok).toBe(false);
    expect(result.redactions).toEqual([]);
    expect(result.blocks.map((b) => b.rule)).toEqual(['unlocatable-secret']);
  });

  it('can run redaction without the blocklist layer', () => {
    const text = `notes\n${PEM_BLOCK}\nmore notes about the rotation procedure and why we did it`;

    expect(screenMemoryText(text).ok).toBe(false);
    expect(evaluateBlocklist(text).blocked).toBe(true);
    expect(screenMemoryText(text, { skipBlocklist: true }).ok).toBe(true);
  });
});

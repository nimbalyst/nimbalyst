#!/usr/bin/env node
/**
 * mock-gh — a stub for the GitHub CLI used by the PR review E2E spec
 * (issue #307, Phase I).
 *
 * Pointed at via NIMBALYST_GH_PATH. Pattern-matches argv and writes canned
 * JSON to stdout so the PR review panel can be exercised without a real
 * GitHub account or network. Ignores `-H`, `--cache`, `--paginate`, etc.
 *
 * Covered surface: `--version`, `auth status`, and the `api` endpoints the
 * golden-path spec touches (pulls list, single pull, files, commits,
 * check-runs, status, issue comments, reviews, contents).
 */

const argv = process.argv.slice(2);

function out(obj) {
  process.stdout.write(typeof obj === 'string' ? obj : JSON.stringify(obj));
  process.exit(0);
}

// `gh --version`
if (argv.includes('--version')) {
  out('gh version 2.50.0 (2024-01-01)\nhttps://github.com/cli/cli/releases/tag/v2.50.0\n');
}

// `gh auth status`
if (argv[0] === 'auth' && argv[1] === 'status') {
  process.stderr.write('github.com\n  ✓ Logged in to github.com account testuser (keyring)\n');
  process.exit(0);
}

// `gh api <endpoint> ...` — find the endpoint token (first arg after `api`
// that isn't a flag or a flag value).
if (argv[0] === 'api') {
  let endpoint = '';
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-H' || a === '--cache' || a === '--method' || a === '-X') {
      i += 1; // skip this flag's value
      continue;
    }
    if (a.startsWith('-')) continue;
    endpoint = a;
    break;
  }

  const PR_42 = {
    id: 4200,
    number: 42,
    state: 'open',
    title: 'Add the answer to everything',
    body: 'This PR adds the answer.',
    draft: false,
    user: { login: 'octocat', avatar_url: 'https://example.com/a.png' },
    head: { ref: 'feature/answer', sha: 'headsha42' },
    base: { ref: 'main' },
    mergeable: true,
    mergeable_state: 'clean',
    comments: 1,
    review_comments: 0,
    additions: 10,
    deletions: 2,
    changed_files: 1,
    requested_reviewers: [{ login: 'reviewer1' }],
    labels: [{ name: 'enhancement' }],
    created_at: '2026-06-01T10:00:00Z',
    updated_at: '2026-06-02T10:00:00Z',
    html_url: 'https://github.com/nimbalyst/test/pull/42',
  };

  // repos/.../pulls/42/files
  if (/\/pulls\/42\/files/.test(endpoint)) {
    out([
      {
        filename: 'src/answer.ts',
        status: 'modified',
        additions: 10,
        deletions: 2,
        patch: '@@ -1 +1 @@\n-const answer: number = 41;\n+const answer: number = 42;',
      },
    ]);
  }

  // repos/.../pulls/42/commits
  if (/\/pulls\/42\/commits/.test(endpoint)) {
    out([
      {
        sha: 'commitsha42aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        commit: { message: 'Add the answer', author: { name: 'octocat', date: '2026-06-01T10:00:00Z' } },
        author: { login: 'octocat' },
      },
    ]);
  }

  // repos/.../pulls/42  (single PR — must come after the /files and /commits checks)
  if (/\/pulls\/42(\?|$)/.test(endpoint)) {
    out(PR_42);
  }

  // repos/.../pulls?... (list)
  if (/\/pulls(\?|$)/.test(endpoint)) {
    out([PR_42]);
  }

  // check-runs
  if (/\/check-runs/.test(endpoint)) {
    out({
      check_runs: [
        {
          name: 'build',
          status: 'completed',
          conclusion: 'success',
          details_url: 'https://example.com/build',
          started_at: '2026-06-02T09:00:00Z',
          completed_at: '2026-06-02T09:05:00Z',
        },
      ],
    });
  }

  // commit combined status
  if (/\/commits\/.+\/status/.test(endpoint)) {
    out({ state: 'success', statuses: [] });
  }

  // issue comments
  if (/\/issues\/42\/comments/.test(endpoint)) {
    out([
      {
        id: 1,
        body: 'Looks good to me.',
        user: { login: 'reviewer1', avatar_url: 'https://example.com/r.png' },
        created_at: '2026-06-02T08:00:00Z',
        html_url: 'https://github.com/nimbalyst/test/pull/42#issuecomment-1',
      },
    ]);
  }

  // reviews
  if (/\/pulls\/42\/reviews/.test(endpoint)) {
    out([]);
  }

  // contents
  if (/\/contents\//.test(endpoint)) {
    out({
      type: 'file',
      encoding: 'base64',
      content: Buffer.from('file contents\n', 'utf8').toString('base64'),
    });
  }

  // Unknown endpoint — empty array is the safe default for list-shaped calls.
  out([]);
}

// Anything else — succeed quietly.
process.exit(0);

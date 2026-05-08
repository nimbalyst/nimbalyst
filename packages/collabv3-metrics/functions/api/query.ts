interface Env {
  CF_API_TOKEN: string;
  CF_ACCOUNT_ID: string;
}

interface QueryBody {
  sql: string;
}

const SELECT_PATTERN = /^\s*SELECT\b/i;
const DATASET_PATTERN = /\bnimbalyst_sync\b/i;

export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  if (!env.CF_API_TOKEN || !env.CF_ACCOUNT_ID || env.CF_ACCOUNT_ID === '...') {
    return new Response(
      JSON.stringify({ error: 'Pages Function is missing CF_API_TOKEN or CF_ACCOUNT_ID' }),
      { status: 500, headers: { 'content-type': 'application/json' } },
    );
  }

  let body: QueryBody;
  try {
    body = await request.json<QueryBody>();
  } catch {
    return new Response(JSON.stringify({ error: 'invalid JSON body' }), {
      status: 400,
      headers: { 'content-type': 'application/json' },
    });
  }

  const sql = typeof body?.sql === 'string' ? body.sql : '';
  if (!sql) {
    return new Response(JSON.stringify({ error: 'missing sql' }), {
      status: 400,
      headers: { 'content-type': 'application/json' },
    });
  }

  if (!SELECT_PATTERN.test(sql) || !DATASET_PATTERN.test(sql)) {
    return new Response(
      JSON.stringify({ error: 'only SELECT queries against nimbalyst_sync are allowed' }),
      { status: 403, headers: { 'content-type': 'application/json' } },
    );
  }

  const upstream = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${env.CF_ACCOUNT_ID}/analytics_engine/sql`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.CF_API_TOKEN}`,
        'content-type': 'text/plain',
      },
      body: sql,
    },
  );

  return new Response(await upstream.text(), {
    status: upstream.status,
    headers: { 'content-type': 'application/json' },
  });
};

export const onRequest: PagesFunction<Env> = async ({ request }) => {
  return new Response(`method ${request.method} not allowed`, {
    status: 405,
    headers: { allow: 'POST' },
  });
};

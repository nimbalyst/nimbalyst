interface Env {
  CF_API_TOKEN: string;
  CF_ACCOUNT_ID: string;
}

interface GraphQLBody {
  query: string;
  variables?: Record<string, unknown>;
  operationName?: string;
}

const DO_DATASET_PATTERN = /\bdurableObjects[A-Za-z]+\b/;

export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  if (!env.CF_API_TOKEN || !env.CF_ACCOUNT_ID || env.CF_ACCOUNT_ID === '...') {
    return new Response(
      JSON.stringify({ error: 'Pages Function is missing CF_API_TOKEN or CF_ACCOUNT_ID' }),
      { status: 500, headers: { 'content-type': 'application/json' } },
    );
  }

  let body: GraphQLBody;
  try {
    body = await request.json<GraphQLBody>();
  } catch {
    return new Response(JSON.stringify({ error: 'invalid JSON body' }), {
      status: 400,
      headers: { 'content-type': 'application/json' },
    });
  }

  const query = typeof body?.query === 'string' ? body.query : '';
  if (!query) {
    return new Response(JSON.stringify({ error: 'missing query' }), {
      status: 400,
      headers: { 'content-type': 'application/json' },
    });
  }

  if (!DO_DATASET_PATTERN.test(query)) {
    return new Response(
      JSON.stringify({ error: 'only Durable Object analytics queries are allowed' }),
      { status: 403, headers: { 'content-type': 'application/json' } },
    );
  }

  const variables = {
    ...(body.variables ?? {}),
    accountTag: env.CF_ACCOUNT_ID,
  };

  const upstream = await fetch('https://api.cloudflare.com/client/v4/graphql', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.CF_API_TOKEN}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ query, variables, operationName: body.operationName }),
  });

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

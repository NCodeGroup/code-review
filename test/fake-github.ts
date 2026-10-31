// Loaded with --import into src/main.ts, src/publish.ts or src/finish.ts run as a child process, so a test runs a step as the action
// does while every fetch reaches only this fake GitHub, never the network. FAKE_GITHUB_ROUTES names a JSON file of
// answers: `rest` by "METHOD URL", and `graphql` as [text in the query, answer] pairs, the first match winning. Each
// request is appended to the file FAKE_GITHUB_LOG as a JSON line. Anything else gets a 404, or a GraphQL error.

import { appendFileSync, readFileSync } from 'node:fs';

export interface FakeRoutes {
  rest: Record<string, unknown>;
  graphql: [string, unknown][];
}

export interface LoggedRequest {
  method: string;
  url: string;
  authorization: string | null;
  body?: any;
}

const routesFile = process.env['FAKE_GITHUB_ROUTES'];
const logFile = process.env['FAKE_GITHUB_LOG'];
if (routesFile && logFile) {
  const routes = JSON.parse(readFileSync(routesFile, 'utf8')) as FakeRoutes;
  globalThis.fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    const logged: LoggedRequest = { method, url, authorization: new Headers(init?.headers).get('authorization'), ...(body ? { body } : {}) };
    appendFileSync(logFile, `${JSON.stringify(logged)}\n`);
    if (url === 'https://api.github.com/graphql') {
      const match = routes.graphql.find(([text]) => String(body?.query ?? '').includes(text));
      return Response.json(match ? match[1] : { errors: [{ message: 'no fake answer' }] });
    }
    const key = `${method} ${url}`;
    return key in routes.rest ? Response.json(routes.rest[key], { status: method === 'POST' ? 201 : 200 }) : new Response('Not Found', { status: 404 });
  };
}

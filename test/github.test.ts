import assert from 'node:assert/strict';
import { test } from 'node:test';
import { GitHubError, githubApi, githubFetch, githubUrls } from '../src/github.ts';

// A fetch that records each request and answers every one with `answer`.
function recording(answer: () => Response = () => new Response('{}')) {
  const requests: { url: string; init: RequestInit | undefined }[] = [];
  const fn = (async (url: string | URL | Request, init?: RequestInit) => {
    requests.push({ url: String(url), init });
    return answer();
  }) as typeof fetch;
  return { requests, fn };
}

test("githubUrls defaults to github.com and reads a GitHub Enterprise Server's addresses from the environment", () => {
  assert.deepEqual(githubUrls({}), { api: 'https://api.github.com', graphql: 'https://api.github.com/graphql' });
  assert.deepEqual(githubUrls({ GITHUB_API_URL: 'https://ghe.example/api/v3/' }), { api: 'https://ghe.example/api/v3', graphql: 'https://ghe.example/api/v3/graphql' });
  assert.deepEqual(githubUrls({ GITHUB_API_URL: 'https://ghe.example/api/v3/', GITHUB_GRAPHQL_URL: 'https://ghe.example/api/graphql' }), {
    api: 'https://ghe.example/api/v3',
    graphql: 'https://ghe.example/api/graphql',
  });
});

test('githubFetch sends a path to the configured host and /graphql to the GraphQL address', async () => {
  const { requests, fn } = recording();
  const client = { fetch: fn, urls: { api: 'https://ghe.example/api/v3', graphql: 'https://ghe.example/api/graphql' } };
  await githubFetch(client, 'GET', '/repos/o/r');
  await githubFetch(client, 'POST', '/graphql', { query: 'q' });
  assert.deepEqual(requests.map((r) => `${r.init?.method} ${r.url}`), ['GET https://ghe.example/api/v3/repos/o/r', 'POST https://ghe.example/api/graphql']);
  assert.equal(requests[1]?.init?.body, '{"query":"q"}');
});

test('githubFetch sends no authorization header without a token, and Bearer with one', async () => {
  const { requests, fn } = recording();
  await githubFetch({ fetch: fn }, 'GET', '/x');
  await githubFetch({ fetch: fn, token: 't0ken' }, 'GET', '/x');
  const headers = requests.map((r) => r.init?.headers as Record<string, string>);
  assert.equal('authorization' in headers[0]!, false);
  assert.equal(headers[1]!['authorization'], 'Bearer t0ken');
});

test("githubFetch gives up when GitHub doesn't answer in time", async () => {
  const silent = ((_url: string | URL | Request, init?: RequestInit) =>
    new Promise<Response>((_, reject) => init?.signal?.addEventListener('abort', () => reject(init.signal!.reason)))) as typeof fetch;
  await assert.rejects(githubFetch({ fetch: silent, timeoutMs: 20 }, 'GET', '/x'), { name: 'TimeoutError' });
});

test('githubApi reads an empty answer as none', async () => {
  assert.equal(await githubApi('t', recording(() => new Response('', { status: 200 })).fn)('GET', '/x'), undefined);
  assert.equal(await githubApi('t', recording(() => new Response(null, { status: 204 })).fn)('DELETE', '/x'), undefined);
});

test("githubApi keeps GitHub's answer in a refusal unless asked to be terse", async () => {
  const refused = () => new Response('nope', { status: 403 });
  await assert.rejects(githubApi('t', recording(refused).fn)('GET', '/x'), /HTTP 403 nope$/);
  await assert.rejects(githubApi('t', recording(refused).fn, { terseErrors: true })('GET', '/x'), (error: unknown) => {
    assert.ok(error instanceof GitHubError);
    assert.equal(error.message, 'GitHub refused GET /x: HTTP 403');
    assert.equal(error.status, 403);
    return true;
  });
});

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { GitHubError, githubApi, githubFetch, githubGraphql, githubUrls } from '../src/github.ts';

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

test('githubFetch sends an absolute url on the configured origin, with the token', async () => {
  const { requests, fn } = recording();
  const client = { fetch: fn, token: 't0ken', urls: { api: 'https://ghe.example/api/v3', graphql: 'https://ghe.example/api/graphql' } };
  await githubFetch(client, 'GET', 'https://ghe.example/api/v3/repos/o/r/issues/1/comments?page=2');
  assert.equal(requests[0]?.url, 'https://ghe.example/api/v3/repos/o/r/issues/1/comments?page=2');
  assert.equal((requests[0]?.init?.headers as Record<string, string>)['authorization'], 'Bearer t0ken');
});

test('githubFetch refuses a url that resolves to another origin and sends nothing', async () => {
  const { requests, fn } = recording();
  const client = { fetch: fn, token: 't0ken', urls: { api: 'https://api.github.com', graphql: 'https://api.github.com/graphql' } };
  await assert.rejects(githubFetch(client, 'GET', 'https://attacker.example/repos/o/r'), /Refusing to send a GitHub request to https:\/\/attacker\.example/);
  await assert.rejects(githubFetch(client, 'GET', 'http://api.github.com/repos/o/r'), /Refusing/);
  await assert.rejects(githubFetch(client, 'GET', '@attacker.example/x'), /Refusing to send a GitHub request to https:\/\/attacker\.example/);
  assert.equal(requests.length, 0);
});

test('githubFetch still sends a path under the REST address, with the token', async () => {
  const { requests, fn } = recording();
  await githubFetch({ fetch: fn, token: 't0ken', urls: { api: 'https://api.github.com', graphql: 'https://api.github.com/graphql' } }, 'GET', '/repos/o/r');
  assert.equal(requests[0]?.url, 'https://api.github.com/repos/o/r');
  assert.equal((requests[0]?.init?.headers as Record<string, string>)['authorization'], 'Bearer t0ken');
});

const dotCom = { api: 'https://api.github.com', graphql: 'https://api.github.com/graphql' };

// A fetch that answers its requests with `answers` in turn, the last one again once they run out.
function answering(...answers: (() => Response)[]) {
  return recording(() => (answers.length > 1 ? answers.shift()! : answers[0]!)());
}

const redirect = (location: string, status = 301) => () => new Response(null, { status, headers: { location } });

test('githubFetch follows a redirect on the configured origin, with the token', async () => {
  const { requests, fn } = answering(redirect('/repositories/1/pulls/2'), () => new Response('{"ok":true}'));
  const response = await githubFetch({ fetch: fn, token: 't0ken', urls: dotCom }, 'GET', '/repos/o/r/pulls/2');
  assert.deepEqual(await response.json(), { ok: true });
  assert.deepEqual(requests.map((r) => r.url), ['https://api.github.com/repos/o/r/pulls/2', 'https://api.github.com/repositories/1/pulls/2']);
  assert.equal(requests[0]?.init?.redirect, 'manual');
  assert.ok((requests[1]?.init?.headers as Record<string, string>)['authorization']?.endsWith(' t0ken'));
});

test('githubFetch refuses a redirect to another origin and sends nothing there', async () => {
  const { requests, fn } = answering(redirect('https://attacker.example/x', 302));
  await assert.rejects(githubFetch({ fetch: fn, token: 't0ken', urls: dotCom }, 'GET', '/repos/o/r'), /Refusing to send a GitHub request to https:\/\/attacker\.example/);
  assert.deepEqual(requests.map((r) => r.url), ['https://api.github.com/repos/o/r']);
});

test('githubFetch refuses a fourth redirect', async () => {
  const { requests, fn } = answering(redirect('/loop'));
  await assert.rejects(githubFetch({ fetch: fn, token: 't0ken', urls: dotCom }, 'GET', '/repos/o/r'), /Refusing to follow more than 3 redirects/);
  assert.equal(requests.length, 4);
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

test('githubGraphql returns the data and throws on GraphQL errors, naming what was asked', async () => {
  assert.deepEqual(await githubGraphql(async () => ({ data: { a: 1 } }), 'q', {}), { a: 1 });
  await assert.rejects(githubGraphql(async () => ({ errors: [{ message: 'boom' }] }), 'q', {}, 'the review threads'), /^Error: GitHub refused the review threads: boom$/);
});

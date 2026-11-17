import assert from 'node:assert/strict';
import { afterEach, mock, test } from 'node:test';
import { AnthropicTokenSource, secretValues } from '../src/credentials.ts';

const requestUrl = 'https://token.example/oidc?x=1';
const tokenUrl = 'https://api.anthropic.com/v1/oauth/token';
const settings = { ruleId: 'r', organizationId: 'o', serviceAccountId: 's', workspaceId: 'w' };

interface Call {
  url: string;
  init: RequestInit | undefined;
}

afterEach(() => {
  mock.restoreAll();
  mock.timers.reset();
});

// Answers the OIDC request and the token exchange, numbering the answers, and records every call.
function mockFetch(answers: { oidc?: Response; exchange?: Response } = {}): Call[] {
  const calls: Call[] = [];
  let oidcCount = 0;
  let exchangeCount = 0;
  mock.method(globalThis, 'fetch', async (url: string | URL | Request, init?: RequestInit) => {
    const target = String(url);
    calls.push({ url: target, init });
    if (target.startsWith(requestUrl)) {
      oidcCount += 1;
      return answers.oidc ?? Response.json({ value: `jwt-${oidcCount}` });
    }
    if (target === tokenUrl) {
      exchangeCount += 1;
      return answers.exchange ?? Response.json({ access_token: `access-${exchangeCount}`, expires_in: 600 });
    }
    throw new Error(`unexpected fetch ${target}`);
  });
  return calls;
}

function newSource(): AnthropicTokenSource {
  return new AnthropicTokenSource(settings, requestUrl, 'request-token');
}

test('token asks GitHub for an OIDC token and exchanges it with Anthropic', async () => {
  const calls = mockFetch();

  const token = await newSource().token();

  assert.equal(token, 'access-1');
  assert.equal(calls.length, 2);
  assert.equal(calls[0]?.url, `${requestUrl}&audience=https%3A%2F%2Fapi.anthropic.com`);
  assert.deepEqual(calls[0]?.init?.headers, { authorization: 'Bearer request-token' });
  assert.equal(calls[1]?.url, tokenUrl);
  assert.equal(calls[1]?.init?.method, 'POST');
  assert.deepEqual(JSON.parse(String(calls[1]?.init?.body)), {
    grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
    assertion: 'jwt-1',
    federation_rule_id: 'r',
    organization_id: 'o',
    service_account_id: 's',
    workspace_id: 'w',
  });
});

test('a second token within the lifetime reuses the first', async () => {
  const calls = mockFetch();
  const source = newSource();

  const first = await source.token();
  const second = await source.token();

  assert.equal(calls.length, 2);
  assert.equal(second, first);
});

test('token calls started together share one exchange', async () => {
  const calls = mockFetch();
  const source = newSource();

  const tokens = await Promise.all([source.token(), source.token()]);

  assert.equal(calls.length, 2);
  assert.deepEqual(tokens, ['access-1', 'access-1']);
});

test('token reuses the first until the two-minute renewal window', async () => {
  mock.timers.enable({ apis: ['Date'], now: 0 });
  const calls = mockFetch();
  const source = newSource();

  assert.equal(await source.token(), 'access-1');
  mock.timers.tick(479_999);
  const reused = await source.token();

  assert.equal(reused, 'access-1');
  assert.equal(calls.length, 2);
});

test('token exchanges again inside the two-minute renewal window', async () => {
  mock.timers.enable({ apis: ['Date'], now: 0 });
  const calls = mockFetch();
  const source = newSource();

  assert.equal(await source.token(), 'access-1');
  mock.timers.tick(480_001);
  const renewed = await source.token();

  assert.equal(renewed, 'access-2');
  assert.equal(calls.length, 4);
});

test('token rejects when GitHub refuses the OIDC token', async () => {
  mockFetch({ oidc: new Response('no', { status: 500 }) });

  await assert.rejects(newSource().token(), /GitHub refused an OIDC token: HTTP 500/);
});

test('token rejects when Anthropic refuses the federated login', async () => {
  mockFetch({ exchange: Response.json({}, { status: 401 }) });

  await assert.rejects(newSource().token(), /Anthropic refused the federated login: HTTP 401/);
});

test('secretValues holds every secret the run has seen', async () => {
  mockFetch();
  const source = newSource();
  await source.token();

  const values = secretValues({ anthropic: source, bedrockKey: 'b' });

  assert.deepEqual([...values].sort(), ['access-1', 'b', 'jwt-1']);
  assert.deepEqual(secretValues({}), []);
});

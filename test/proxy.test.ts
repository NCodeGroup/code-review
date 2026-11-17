// These tests listen on 127.0.0.1 because the proxy is an HTTP server, while https.request is mocked so nothing leaves the machine.
import assert from 'node:assert/strict';
import type { IncomingMessage } from 'node:http';
import https from 'node:https';
import { afterEach, mock, test } from 'node:test';
import { PassThrough, Readable } from 'node:stream';
import type { AnthropicTokenSource, Credentials } from '../src/credentials.ts';
import { placeholderKey, startProxy } from '../src/proxy.ts';

interface Call {
  options: https.RequestOptions;
}

const calls: Call[] = [];

// Answers like an upstream, or fails the request when `failure` is set.
function mockUpstream(failure?: Error): void {
  calls.length = 0;
  const fake = (options: https.RequestOptions, callback: (response: IncomingMessage) => void): PassThrough => {
    calls.push({ options });
    const outbound = new PassThrough();
    if (failure) {
      process.nextTick(() => outbound.emit('error', failure));
      return outbound;
    }
    outbound.on('finish', () => {
      const inbound = Readable.from([Buffer.from('upstream body')]) as unknown as IncomingMessage;
      inbound.statusCode = 201;
      inbound.headers = { 'content-type': 'text/plain', 'proxy-authenticate': 'Basic', 'x-upstream': 'yes' };
      callback(inbound);
    });
    return outbound;
  };
  mock.method(https, 'request', fake as never);
}

afterEach(() => {
  mock.restoreAll();
});

const credentials: Credentials = {
  anthropic: { token: async () => 'anthropic-token' } as unknown as AnthropicTokenSource,
  bedrockKey: 'bedrock-key',
};

test('a path that is neither anthropic nor bedrock gets 404 and no upstream call', async () => {
  mockUpstream();
  const proxy = await startProxy(credentials);
  try {
    const response = await fetch(`${proxy.url}/other/v1/messages`);
    assert.equal(response.status, 404);
    await response.arrayBuffer();
    assert.equal(calls.length, 0);
  } finally {
    await proxy.close();
  }
});

test('an anthropic request goes to the Anthropic API with the token and without the caller credentials', async () => {
  mockUpstream();
  const proxy = await startProxy(credentials);
  try {
    const response = await fetch(`${proxy.url}/anthropic/v1/messages`, {
      method: 'POST',
      headers: { 'x-api-key': placeholderKey, 'anthropic-version': '2023-06-01', connection: 'keep-alive' },
      body: '{"prompt":"hi"}',
    });
    await response.arrayBuffer();
    const options = calls[0]?.options;
    assert.ok(options);
    assert.equal(options.host, 'api.anthropic.com');
    assert.equal(options.path, '/v1/messages');
    assert.equal(options.method, 'POST');
    const headers = options.headers as Record<string, string>;
    assert.equal(headers['authorization'], 'Bearer anthropic-token');
    assert.equal(headers['anthropic-version'], '2023-06-01');
    assert.equal(headers['x-api-key'], undefined);
    assert.equal(headers['connection'], undefined);
  } finally {
    await proxy.close();
  }
});

test('the response comes back with the upstream status, body and ordinary headers but not hop-by-hop ones', async () => {
  mockUpstream();
  const proxy = await startProxy(credentials);
  try {
    const response = await fetch(`${proxy.url}/anthropic/v1/messages`, { method: 'POST', body: '{}' });
    assert.equal(response.status, 201);
    assert.equal(await response.text(), 'upstream body');
    assert.equal(response.headers.get('x-upstream'), 'yes');
    assert.equal(response.headers.get('proxy-authenticate'), null);
  } finally {
    await proxy.close();
  }
});

test('a bedrock request goes to the Bedrock runtime with the key', async () => {
  mockUpstream();
  const proxy = await startProxy(credentials);
  try {
    const response = await fetch(`${proxy.url}/bedrock/model/m/invoke`, { method: 'POST', body: '{}' });
    await response.arrayBuffer();
    const options = calls[0]?.options;
    assert.ok(options);
    assert.equal(options.host, 'bedrock-runtime.us-west-2.amazonaws.com');
    assert.equal(options.path, '/model/m/invoke');
    const headers = options.headers as Record<string, string>;
    assert.equal(headers['authorization'], 'Bearer bedrock-key');
  } finally {
    await proxy.close();
  }
});

test('without a credential the path gets 404 and no upstream call', async () => {
  mockUpstream();
  const proxy = await startProxy({});
  try {
    const response = await fetch(`${proxy.url}/anthropic/v1/messages`, { method: 'POST', body: '{}' });
    assert.equal(response.status, 404);
    await response.arrayBuffer();
    assert.equal(calls.length, 0);
  } finally {
    await proxy.close();
  }
});

test('an upstream error gets 502 with the error message', async () => {
  mockUpstream(new Error('refused'));
  const proxy = await startProxy(credentials);
  try {
    const response = await fetch(`${proxy.url}/anthropic/v1/messages`, { method: 'POST', body: '{}' });
    assert.equal(response.status, 502);
    assert.match(await response.text(), /Upstream error: refused/);
  } finally {
    await proxy.close();
  }
});

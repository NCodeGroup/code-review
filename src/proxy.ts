// A localhost proxy that adds the run's credentials to the agents' model requests. The agents get its address and a
// placeholder key, so a prompt-injected agent has no secret to leak. Responses stream back unchanged, including
// Bedrock's binary event stream.

import http from 'node:http';
import https from 'node:https';
import type { AddressInfo } from 'node:net';
import { bedrockRegion } from './config.ts';
import type { Credentials } from './credentials.ts';

export const placeholderKey = 'placeholder-the-proxy-adds-the-real-credential';

const hopByHop = new Set([
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade',
  'host', 'content-length',
]);

interface Upstream {
  host: string;
  path: string;
  headers: Record<string, string>;
}

async function upstreamFor(url: string, credentials: Credentials): Promise<Upstream | undefined> {
  if (url.startsWith('/anthropic/') && credentials.anthropic) {
    return {
      host: 'api.anthropic.com',
      path: url.slice('/anthropic'.length),
      headers: { authorization: `Bearer ${await credentials.anthropic.token()}` },
    };
  }
  if (url.startsWith('/bedrock/') && credentials.bedrockKey) {
    return {
      host: `bedrock-runtime.${bedrockRegion}.amazonaws.com`,
      path: url.slice('/bedrock'.length),
      headers: { authorization: `Bearer ${credentials.bedrockKey}` },
    };
  }
  return undefined;
}

export interface Proxy {
  url: string;
  close(): Promise<void>;
}

export async function startProxy(credentials: Credentials): Promise<Proxy> {
  const server = http.createServer(async (request, response) => {
    try {
      const upstream = await upstreamFor(request.url ?? '', credentials);
      if (!upstream) {
        response.writeHead(404, { 'content-type': 'text/plain' }).end('No upstream for this path.');
        return;
      }
      const headers: Record<string, string | string[]> = {};
      for (const [name, value] of Object.entries(request.headers)) {
        if (value === undefined || hopByHop.has(name) || name === 'x-api-key' || name === 'authorization') continue;
        headers[name] = value;
      }
      Object.assign(headers, upstream.headers);
      const outbound = https.request(
        { host: upstream.host, path: upstream.path, method: request.method, headers },
        (inbound) => {
          const back: Record<string, string | string[]> = {};
          for (const [name, value] of Object.entries(inbound.headers)) {
            if (value !== undefined && !hopByHop.has(name)) back[name] = value;
          }
          response.writeHead(inbound.statusCode ?? 502, back);
          inbound.pipe(response);
        },
      );
      outbound.on('error', (error) => {
        if (!response.headersSent) response.writeHead(502, { 'content-type': 'text/plain' });
        response.end(`Upstream error: ${error.message}`);
      });
      request.pipe(outbound);
    } catch (error) {
      if (!response.headersSent) response.writeHead(502, { 'content-type': 'text/plain' });
      response.end(`Proxy error: ${(error as Error).message}`);
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

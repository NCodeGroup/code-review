// The one GitHub client every step of the action shares: REST and GraphQL requests, each with a time limit, to the
// GitHub the runner names. Nothing here imports an npm package: the acknowledgement runs it with the runner's own node,
// before setup-node and npm ci.

export type Api = (method: string, url: string, body?: unknown) => Promise<any>;

// A refusal from GitHub's API, with its status, so the publish step can tell a missing permission from an outage.
export class GitHubError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

// How long one request may take before it fails, so a hung connection doesn't hold the run until the job's time limit.
export const githubTimeoutMs = 30_000;

export interface GitHubUrls {
  api: string;
  graphql: string;
}

// GitHub's REST and GraphQL addresses, as the runner names them: a GitHub Enterprise Server's own, or github.com's.
export function githubUrls(env: NodeJS.ProcessEnv = process.env): GitHubUrls {
  const api = (env['GITHUB_API_URL'] || 'https://api.github.com').replace(/\/+$/, '');
  return { api, graphql: env['GITHUB_GRAPHQL_URL'] || `${api}/graphql` };
}

export interface GitHubClient {
  token?: string | undefined;
  fetch?: typeof fetch;
  urls?: GitHubUrls;
  timeoutMs?: number;
  // Leaves GitHub's answer out of a refusal's message, for messages that are published, such as the report's notes.
  terseErrors?: boolean;
}

// Sends one request to GitHub, with the token when there is one. A url starting with / is under the REST address,
// except /graphql, which is the GraphQL one. The address must be on the REST or GraphQL address's origin, so the
// token never leaves for another host.
export async function githubFetch(client: GitHubClient, method: string, url: string, body?: unknown): Promise<Response> {
  const urls = client.urls ?? githubUrls();
  const target = /^[a-z][a-z\d+.-]*:/i.test(url) ? url : url === '/graphql' ? urls.graphql : `${urls.api}${url}`;
  const origin = new URL(target).origin;
  if (origin !== new URL(urls.api).origin && origin !== new URL(urls.graphql).origin) {
    throw new Error(`Refusing to send a GitHub request to ${origin}: it isn't the GitHub API's address`);
  }
  return (client.fetch ?? fetch)(target, {
    method,
    headers: {
      accept: 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28',
      ...(client.token ? { authorization: `Bearer ${client.token}` } : {}),
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(client.timeoutMs ?? githubTimeoutMs),
  });
}

// Calls GitHub with a token, and throws a GitHubError on any answer but a success.
export function githubApi(token: string, fetchFn: typeof fetch = fetch, options: Omit<GitHubClient, 'token' | 'fetch'> = {}): Api {
  const client = { ...options, token, fetch: fetchFn };
  return async (method, url, body) => {
    const response = await githubFetch(client, method, url, body);
    if (!response.ok) {
      const detail = options.terseErrors ? '' : ` ${await response.text()}`;
      throw new GitHubError(`GitHub refused ${method} ${url}: HTTP ${response.status}${detail}`, response.status);
    }
    // An empty body, as a 204 has, is no answer rather than malformed JSON.
    const text = await response.text();
    return text ? JSON.parse(text) : undefined;
  };
}

// A GraphQL request through `api`. GitHub answers a refused one with 200 and `errors`, so that throws too.
export async function githubGraphql(api: Api, query: string, variables: Record<string, unknown>, what = 'a GraphQL request'): Promise<unknown> {
  const json = (await api('POST', '/graphql', { query, variables })) as { data?: unknown; errors?: { message?: string }[] } | undefined;
  if (json?.errors?.length) throw new Error(`GitHub refused ${what}: ${json.errors.map((e) => e.message ?? '').join('; ')}`);
  return json?.data;
}

// Reads an API path with the read-only token: the parsed body, or undefined when GitHub has no such thing.
export type ReadApi = (path: string) => Promise<unknown>;

// The ReadApi of a run, with the read-only token when there is one. A 404 reads as undefined, as a deleted comment
// would; any other refusal throws, so a rate limit or an outage isn't taken for a comment that isn't a finding.
export function githubReader(token: string | undefined, fetchFn: typeof fetch = fetch): ReadApi {
  return async (apiPath) => {
    const response = await githubFetch({ token, fetch: fetchFn }, 'GET', apiPath);
    if (response.status === 404) return undefined;
    if (!response.ok) throw new Error(`GitHub refused GET ${apiPath}: HTTP ${response.status}`);
    return response.json();
  };
}

export interface PullRequestRef {
  number?: number;
  head?: { sha?: string; repo?: { full_name?: string } | null };
}

// Reads the pull request a /review comment is on; the comment's event carries only the issue.
export async function fetchPullRequest<P extends PullRequestRef = PullRequestRef>(
  repository: string,
  number: number,
  token: string | undefined,
  fetchFn: typeof fetch = fetch,
): Promise<P> {
  const response = await githubFetch({ token, fetch: fetchFn }, 'GET', `/repos/${repository}/pulls/${number}`);
  if (!response.ok) throw new Error(`Couldn't read pull request #${number}: HTTP ${response.status}`);
  return (await response.json()) as P;
}

// The URL of this workflow run, for a check run's details link and for "the run's log says why".
export function runUrl(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const server = env['GITHUB_SERVER_URL'];
  const repository = env['GITHUB_REPOSITORY'];
  const id = env['GITHUB_RUN_ID'];
  return server && repository && id ? `${server}/${repository}/actions/runs/${id}` : undefined;
}

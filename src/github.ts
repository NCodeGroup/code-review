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
// except /graphql, which is the GraphQL one.
export function githubFetch(client: GitHubClient, method: string, url: string, body?: unknown): Promise<Response> {
  const urls = client.urls ?? githubUrls();
  const target = url.startsWith('https://') ? url : url === '/graphql' ? urls.graphql : `${urls.api}${url}`;
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

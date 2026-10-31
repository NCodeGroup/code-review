// The GitHub REST calls the action's steps share. Nothing here imports an npm package: the acknowledgement runs it with
// the runner's own node, before setup-node and npm ci.

export type Api = (method: string, url: string, body?: unknown) => Promise<any>;

// A refusal from GitHub's API, with its status, so the publish step can tell a missing permission from an outage.
export class GitHubError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

// Calls GitHub with a token, and throws a GitHubError on any answer but a success. A path starting with / is under
// api.github.com.
export function githubApi(token: string, fetchFn: typeof fetch = fetch): Api {
  return async (method, url, body) => {
    const response = await fetchFn(url.startsWith('https://') ? url : `https://api.github.com${url}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        accept: 'application/vnd.github+json',
        'x-github-api-version': '2022-11-28',
        ...(body ? { 'content-type': 'application/json' } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    if (!response.ok) throw new GitHubError(`GitHub refused ${method} ${url}: HTTP ${response.status} ${await response.text()}`, response.status);
    return response.status === 204 ? undefined : response.json();
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
  const response = await fetchFn(`https://api.github.com/repos/${repository}/pulls/${number}`, {
    headers: { accept: 'application/vnd.github+json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
  });
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

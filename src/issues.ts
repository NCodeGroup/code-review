// The repository's open issues, for synthesis to mark a finding one of them already tracks. Only issues opened by
// someone with write access are read, so a stranger can't file an issue whose title waves a finding away.

import { writers } from './command.ts';

// Pages of 100 open issues read at most, the most recently updated first.
export const maxOpenIssuePages = 2;
const pageSize = 100;

// The open issues, leaving out pull requests and the issues `exclude` names, such as the ones this pull request closes:
// those are its own work, not somewhere else to track a finding. It keeps the pages it could read, and none when it
// couldn't read the first.
export async function readOpenIssues(repository: string, token: string | undefined, exclude: number[] = [], fetchPage: typeof fetch = fetch): Promise<{ number: number; title: string }[]> {
  type Listed = { number?: number; title?: string; author_association?: string; pull_request?: unknown };
  const read: Listed[] = [];
  for (let page = 1; page <= maxOpenIssuePages; page++) {
    let issues: Listed[];
    try {
      const response = await fetchPage(`https://api.github.com/repos/${repository}/issues?state=open&sort=updated&direction=desc&per_page=${pageSize}&page=${page}`, {
        headers: { accept: 'application/vnd.github+json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
      });
      if (!response.ok) break;
      issues = (await response.json()) as Listed[];
    } catch {
      break;
    }
    read.push(...issues);
    if (issues.length < pageSize) break;
  }
  const skip = new Set(exclude);
  return read
    .filter((i) => typeof i.number === 'number' && !i.pull_request && writers.has(i.author_association ?? '') && !skip.has(i.number))
    .map((i) => ({ number: i.number!, title: i.title ?? '' }));
}

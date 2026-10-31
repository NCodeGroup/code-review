// The repository's open issues, for synthesis to mark a finding one of them already tracks. Only issues opened by
// someone with write access are read, so a stranger can't file an issue whose title waves a finding away. Write access
// is the engine's writer check (writers.ts), so a private organization member's issues count.

import { writerAssociations } from './command.ts';
import type { WriterCheck } from './writers.ts';

// Pages of 100 open issues read at most, the most recently updated first.
export const maxOpenIssuePages = 2;
const pageSize = 100;
// Authors looked up at most per review, beyond the ones whose association says they can write: a public repository's
// open issues could otherwise cost an API call each.
export const maxIssueAuthorLookups = 20;

// The open issues, leaving out pull requests and the issues `exclude` names, such as the ones this pull request closes:
// those are its own work, not somewhere else to track a finding. It keeps the pages it could read, and none when it
// couldn't read the first.
export async function readOpenIssues(
  repository: string,
  token: string | undefined,
  isWriter: WriterCheck,
  exclude: number[] = [],
  fetchPage: typeof fetch = fetch,
): Promise<{ number: number; title: string }[]> {
  type Listed = { number?: number; title?: string; author_association?: string; user?: { login?: string; type?: string }; pull_request?: unknown };
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
  const looked = new Set<string>();
  const openedByWriter = async (issue: Listed): Promise<boolean> => {
    if (writerAssociations.has(issue.author_association ?? '')) return true;
    const login = issue.user?.login;
    if (!login || issue.user?.type === 'Bot') return false;
    if (!looked.has(login)) {
      if (looked.size >= maxIssueAuthorLookups) return false;
      looked.add(login);
    }
    return isWriter(login, issue.author_association);
  };
  const kept: { number: number; title: string }[] = [];
  for (const issue of read) {
    if (typeof issue.number !== 'number' || issue.pull_request || skip.has(issue.number)) continue;
    if (await openedByWriter(issue)) kept.push({ number: issue.number, title: issue.title ?? '' });
  }
  return kept;
}

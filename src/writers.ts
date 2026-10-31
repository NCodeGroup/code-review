// Who counts as a writer. Only a writer's text (a pull request's description and commit subjects, and the issues it
// closes) reaches the prompts: anyone else's could steer the review.
//
// author_association alone misses writers: GitHub reports an organization member whose membership is private as
// CONTRIBUTOR, in event payloads and to the workflow's token. So an author it doesn't name a writer is looked up in the
// repository's permissions, which the workflow's token can read (metadata: read).

import { writerAssociations } from './command.ts';
import { maxIssueChars } from './config.ts';

export type WriterCheck = (login: string | undefined, association: string | undefined) => Promise<boolean>;

function headers(token: string | undefined): Record<string, string> {
  return { accept: 'application/vnd.github+json', ...(token ? { authorization: `Bearer ${token}` } : {}) };
}

// A check for one repository that asks the API about each login once. A failed or unreadable lookup counts as no.
export function writerCheck(repository: string, token: string | undefined, fetchJson: typeof fetch = fetch): WriterCheck {
  const known = new Map<string, Promise<boolean>>();
  const lookUp = async (login: string): Promise<boolean> => {
    try {
      const response = await fetchJson(`https://api.github.com/repos/${repository}/collaborators/${encodeURIComponent(login)}/permission`, { headers: headers(token) });
      if (!response.ok) return false;
      const { permission } = (await response.json()) as { permission?: string };
      // The legacy base role: maintain reads as write, triage as read.
      return permission === 'admin' || permission === 'write';
    } catch {
      return false;
    }
  };
  return async (login, association) => {
    if (writerAssociations.has(association ?? '')) return true;
    if (!login) return false;
    if (!known.has(login)) known.set(login, lookUp(login));
    return known.get(login)!;
  };
}

// The issues a pull request closes, as context for intent. An issue whose author isn't a writer is left out.
export async function readClosedIssues(
  repository: string,
  numbers: number[],
  token: string | undefined,
  isWriter: WriterCheck,
  fetchJson: typeof fetch = fetch,
): Promise<{ number: number; title: string; body: string }[]> {
  const issues: { number: number; title: string; body: string }[] = [];
  for (const number of numbers) {
    const response = await fetchJson(`https://api.github.com/repos/${repository}/issues/${number}`, { headers: headers(token) });
    if (!response.ok) continue;
    const issue = (await response.json()) as { title?: string; body?: string; author_association?: string; user?: { login?: string }; pull_request?: unknown };
    if (issue.pull_request || !(await isWriter(issue.user?.login, issue.author_association))) continue;
    issues.push({ number, title: issue.title ?? '', body: (issue.body ?? '').slice(0, maxIssueChars) });
  }
  return issues;
}

// Who counts as a writer. Only a writer's text (a pull request's description and commit subjects, and the issues it
// closes) reaches the prompts: anyone else's could steer the review.
//
// author_association alone misses writers: GitHub reports an organization member whose membership is private as
// CONTRIBUTOR, in event payloads and to the workflow's token. So an author it doesn't name a writer is looked up in the
// repository's permissions, which the workflow's token can read (metadata: read).

import { writerAssociations } from './command.ts';
import { errorText } from './comments.ts';
import { maxIssueChars } from './config.ts';

export type WriterCheck = (login: string | undefined, association: string | undefined) => Promise<boolean>;

function headers(token: string | undefined): Record<string, string> {
  return { accept: 'application/vnd.github+json', ...(token ? { authorization: `Bearer ${token}` } : {}) };
}

// A check for one repository that asks the API about each login once. A failed or unreadable lookup counts as no, and
// warns through `log` with the reason.
export function writerCheck(repository: string, token: string | undefined, fetchJson: typeof fetch = fetch, log: (line: string) => void = () => {}): WriterCheck {
  const known = new Map<string, Promise<boolean>>();
  const lookUp = async (login: string): Promise<boolean> => {
    let reason: string;
    try {
      const response = await fetchJson(`https://api.github.com/repos/${repository}/collaborators/${encodeURIComponent(login)}/permission`, { headers: headers(token) });
      // A 404 is an answer: the login isn't a collaborator, or doesn't exist.
      if (response.status === 404) return false;
      if (response.ok) {
        const { permission } = (await response.json()) as { permission?: string };
        // The legacy base role: maintain reads as write, triage as read.
        return permission === 'admin' || permission === 'write';
      }
      reason = `HTTP ${response.status}`;
    } catch (error) {
      reason = errorText(error);
    }
    log(`::warning::Couldn't read ${login}'s permission (${reason}); their text counts as a non-writer's and stays out of the prompts.`);
    return false;
  };
  return async (login, association) => {
    if (writerAssociations.has(association ?? '')) return true;
    if (!login) return false;
    if (!known.has(login)) known.set(login, lookUp(login));
    return known.get(login)!;
  };
}

// The issues a pull request closes, as context for intent. An issue whose author isn't a writer is left out, and so is
// one that can't be read, with a warning through `log`.
export async function readClosedIssues(
  repository: string,
  numbers: number[],
  token: string | undefined,
  isWriter: WriterCheck,
  fetchJson: typeof fetch = fetch,
  log: (line: string) => void = () => {},
): Promise<{ number: number; title: string; body: string }[]> {
  type Issue = { title?: string; body?: string; author_association?: string; user?: { login?: string }; pull_request?: unknown };
  const issues: { number: number; title: string; body: string }[] = [];
  for (const number of numbers) {
    let issue: Issue;
    try {
      const response = await fetchJson(`https://api.github.com/repos/${repository}/issues/${number}`, { headers: headers(token) });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      issue = (await response.json()) as Issue;
    } catch (error) {
      log(`::warning::Couldn't read issue #${number}, which the description closes (${errorText(error)}); the reviewers go without it.`);
      continue;
    }
    if (issue.pull_request || !(await isWriter(issue.user?.login, issue.author_association))) continue;
    issues.push({ number, title: issue.title ?? '', body: (issue.body ?? '').slice(0, maxIssueChars) });
  }
  return issues;
}

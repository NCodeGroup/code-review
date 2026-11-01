// Who counts as a writer. Only a writer's text (a pull request's description and commit subjects, and the issues it
// closes) reaches the prompts: anyone else's could steer the review.
//
// author_association alone misses writers: GitHub reports an organization member whose membership is private as
// CONTRIBUTOR, in event payloads and to the workflow's token. So an author it doesn't name a writer is looked up in the
// repository's permissions, which the workflow's token can read (metadata: read). The loop limit (pause.ts), the open
// issues synthesis reads (issues.ts), the replies to the autopilot (follow-up.ts), the replies a re-review reads
// (rereview.ts) and the replies a finding's outcome counts (outcomes.ts) use the same check.

import { writerAssociations } from './command.ts';
import { errorText } from './comments.ts';
import { maxIssueChars } from './config.ts';
import { GitHubError, type Api } from './github.ts';

export type WriterCheck = (login: string | undefined, association: string | undefined) => Promise<boolean>;

// Why a read failed, for a warning: GitHub's status for a refusal, or the error's text.
export function failureText(error: unknown): string {
  return error instanceof GitHubError ? `HTTP ${error.status}` : errorText(error);
}

// Who can write: the legacy `permission` reads maintain as write and triage as read, while `role_name` names the role
// itself, such as maintain.
const writerRoles = new Set(['admin', 'maintain', 'write']);

// A check for one repository that asks the API about each login once. A failed or unreadable lookup counts as no, and
// warns through `log` with the reason.
export function writerCheck(repository: string, api: Api, log: (line: string) => void = () => {}): WriterCheck {
  const known = new Map<string, Promise<boolean>>();
  const lookUp = async (login: string): Promise<boolean> => {
    try {
      const answer = (await api('GET', `/repos/${repository}/collaborators/${encodeURIComponent(login)}/permission`)) as { permission?: string; role_name?: string } | undefined;
      return writerRoles.has(answer?.permission ?? '') || writerRoles.has(answer?.role_name ?? '');
    } catch (error) {
      // A 404 is an answer: the login isn't a collaborator, or doesn't exist.
      if (error instanceof GitHubError && error.status === 404) return false;
      log(`::warning::Couldn't read ${login}'s permission (${failureText(error)}); their text counts as a non-writer's.`);
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

// Repliers looked up at most per review, beyond the ones whose association says they can write: a busy pull request's
// threads could otherwise cost an API call per replier.
export const maxReplyAuthorLookups = 20;

// isWriter, looking up at most limit logins their association doesn't settle; any later login counts as a non-writer.
export function withLookupLimit(isWriter: WriterCheck, limit: number): WriterCheck {
  const looked = new Set<string>();
  return async (login, association) => {
    if (writerAssociations.has(association ?? '')) return true;
    if (!login) return false;
    if (!looked.has(login)) {
      if (looked.size >= limit) return false;
      looked.add(login);
    }
    return isWriter(login, association);
  };
}

export type ClosedIssue = { number: number; title: string; body: string };

// The issues a pull request closes, as context for intent, in order: a pull request is left out, and so is an issue
// whose author isn't a writer; one that can't be read is left out after `unreadable` gets the reason. The engine reads
// them from the API (readClosedIssues), the evals with gh (caseIssues in evals/run.ts).
export async function readWritersIssues(
  numbers: number[],
  readIssue: (number: number) => Promise<unknown>,
  isWriter: WriterCheck,
  unreadable: (number: number, reason: string) => void,
): Promise<ClosedIssue[]> {
  type Issue = { title?: unknown; body?: unknown; author_association?: string; user?: { login?: string }; pull_request?: unknown };
  const issues: ClosedIssue[] = [];
  for (const number of numbers) {
    let issue: Issue;
    try {
      issue = (await readIssue(number)) as Issue;
    } catch (error) {
      unreadable(number, failureText(error));
      continue;
    }
    if (issue.pull_request || !(await isWriter(issue.user?.login, issue.author_association))) continue;
    issues.push({ number, title: String(issue.title ?? ''), body: String(issue.body ?? '').slice(0, maxIssueChars) });
  }
  return issues;
}

// The issues a pull request closes, read from the API. An issue whose author isn't a writer is left out, and so is one
// that can't be read, with a warning through `log`.
export function readClosedIssues(
  repository: string,
  numbers: number[],
  api: Api,
  isWriter: WriterCheck,
  log: (line: string) => void = () => {},
): Promise<ClosedIssue[]> {
  const readIssue = (number: number): Promise<unknown> => api('GET', `/repos/${repository}/issues/${number}`);
  return readWritersIssues(numbers, readIssue, isWriter, (number, reason) =>
    log(`::warning::Couldn't read issue #${number}, which the description closes (${reason}); the reviewers go without it.`),
  );
}

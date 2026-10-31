// The GitHub calls behind the summary comment: reading a pull request's comments page by page, posting a new summary
// and collapsing the earlier ones.

import { newestReviewedHead, summaryComments, supersededComment, type Results } from './results.ts';

// GitHub's largest page of issue comments, and how many pages a run reads at most (10,000 comments), to bound calls.
export const commentPageSize = 100;
export const maxCommentPages = 100;

// Error text for a warning line: on one line, so a newline followed by "::" can't start a workflow command, and short.
const maxErrorChars = 200;
export function errorText(error: unknown): string {
  return (error as Error).message.replace(/\s+/g, ' ').slice(0, maxErrorChars);
}

// Reads a pull request's comments, oldest first, until a short page; undefined when a page can't be read, or when
// every page up to maxCommentPages is full, since the newest comments, which hold the newest summary, would be missing.
export async function readCommentPages<T>(readPage: (page: number) => Promise<T[] | undefined>): Promise<T[] | undefined> {
  const all: T[] = [];
  for (let page = 1; page <= maxCommentPages; page++) {
    const comments = await readPage(page);
    if (!comments) return undefined;
    all.push(...comments);
    if (comments.length < commentPageSize) return all;
  }
  return undefined;
}

// Posts a new summary comment, then collapses the bot's earlier ones to a line that links to it. They are listed before
// posting, so the new one is never collapsed, and collapsed after it, so a failed post leaves the old one intact.
// A failed collapse only warns, and so does a failed listing, which still posts the new summary.
export async function postSummary(
  api: (method: string, url: string, body?: unknown) => Promise<any>,
  results: Pick<Results, 'repository' | 'pullRequest' | 'headSha'>,
  body: string,
  log: (line: string) => void = console.log,
): Promise<string> {
  const comments = `/repos/${results.repository}/issues/${results.pullRequest}/comments`;
  let listError = `more than ${commentPageSize * maxCommentPages} comments`;
  const listed = await readCommentPages(async (page) => {
    try {
      return (await api('GET', `${comments}?per_page=${commentPageSize}&page=${page}`)) as { id: number; body?: string; user?: { login?: string } }[];
    } catch (error) {
      listError = errorText(error);
      return undefined;
    }
  });
  if (!listed) log(`::warning::Couldn't list the earlier summary comments (${listError}), so they stay expanded.`);
  const older = summaryComments(listed ?? []);
  const comment = (await api('POST', comments, { body })) as { html_url: string };
  log(`Posted ${comment.html_url}`);
  const superseded = supersededComment(results.headSha, comment.html_url);
  for (const { id } of older) {
    try {
      await api('PATCH', `/repos/${results.repository}/issues/comments/${id}`, { body: superseded });
      log(`Collapsed the earlier summary comment ${id}`);
    } catch (error) {
      log(`::warning::Couldn't collapse the earlier summary comment ${id} (${errorText(error)}).`);
    }
  }
  return comment.html_url;
}

// The commit the bot's newest summary comment says it last reviewed, or undefined when there's none or it's unreadable.
export async function lastReviewedHead(repository: string, number: number, token: string | undefined, fetchPage: typeof fetch = fetch): Promise<string | undefined> {
  const all = await readCommentPages(async (page) => {
    const response = await fetchPage(`https://api.github.com/repos/${repository}/issues/${number}/comments?per_page=${commentPageSize}&page=${page}`, {
      headers: { accept: 'application/vnd.github+json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    });
    return response.ok ? ((await response.json()) as { body?: string; user?: { login?: string } }[]) : undefined;
  });
  return newestReviewedHead(all);
}

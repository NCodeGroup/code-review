// The GitHub calls behind the summary comment and the review threads: reading a pull request's comments page by page,
// posting the new threads and a new summary, and collapsing the earlier summaries.

import { assertNoSecrets } from './outputs.ts';
import { botLogin, newestReviewedHead, summaryComments, supersededComment, type Results } from './results.ts';
import { parsePosted, placeFindings, reviewBody, threadBody, type PostedThread } from './threads.ts';

// GitHub's largest page of comments, and how many pages a run reads at most (10,000 comments), to bound calls. Issue
// comments and review comments share both.
export const commentPageSize = 100;
export const maxCommentPages = 100;

// Error text for a warning line: on one line, so a newline followed by "::" can't start a workflow command, and short.
const maxErrorChars = 200;
export function errorText(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).replace(/\s+/g, ' ').slice(0, maxErrorChars);
}

// Reads a comment endpoint, such as a pull request's issue comments or review comments, oldest first, until a short
// page; undefined when a page can't be read, or when every page up to maxCommentPages is full, since the newest
// comments, which hold the newest summary and the newest threads, would be missing. readPage gets each page's URL.
export async function readCommentPages<T>(endpoint: string, readPage: (url: string) => Promise<T[] | undefined>): Promise<T[] | undefined> {
  const all: T[] = [];
  for (let page = 1; page <= maxCommentPages; page++) {
    const comments = await readPage(`${endpoint}?per_page=${commentPageSize}&page=${page}`);
    if (!comments) return undefined;
    all.push(...comments);
    if (comments.length < commentPageSize) return all;
  }
  return undefined;
}

// A comment as GitHub lists it, and the API path of a pull request's issue comments. The publish and review steps read
// them through different transports: the app's token, which throws, and an optional token, which gives up.
type ListedComment = { id: number; body?: string; user?: { login?: string } };
function issueComments(repository: string, number: number): string {
  return `/repos/${repository}/issues/${number}/comments`;
}

// The bot's earlier inline threads on a pull request, from its review comments, or undefined when the pull request
// has more review comments than readCommentPages reads. A page that can't be read throws, as api does.
export async function readPostedThreads(
  api: (method: string, url: string) => Promise<any>,
  repository: string,
  number: number,
): Promise<PostedThread[] | undefined> {
  type ReviewComment = Parameters<typeof parsePosted>[0][number] & { user?: { login?: string } };
  const listed = await readCommentPages(`/repos/${repository}/pulls/${number}/comments`, async (url) => (await api('GET', url)) as ReviewComment[]);
  return listed && parsePosted(listed.filter((comment) => comment.user?.login === botLogin));
}

// Posts the findings as one review of inline threads, leaving out ones the bot already posted on this pull request.
// GitHub rejects the whole review when any comment's line isn't in the diff, so on a rejection it posts them all in
// the review's body instead. When the pull request has more review comments than it reads, it posts none, since it
// can't tell which findings are already posted; the check run still has them all. A page that can't be read throws.
export async function postThreads(
  api: (method: string, url: string, body?: unknown) => Promise<any>,
  results: Pick<Results, 'repository' | 'pullRequest' | 'headSha' | 'findings' | 'changedLines'>,
  secrets: Iterable<string>,
  log: (line: string) => void = console.log,
): Promise<void> {
  const posted = await readPostedThreads(api, results.repository, results.pullRequest);
  if (!posted) {
    log(`::warning::Couldn't list the earlier review comments (more than ${commentPageSize * maxCommentPages}), so no threads are posted; the check run has the findings.`);
    return;
  }
  const placement = placeFindings(results.findings, results.changedLines, posted);
  if (!placement.inline.length && !placement.inBody.length) {
    log(`No new findings to post${placement.alreadyPosted.length ? ` (${placement.alreadyPosted.length} already posted)` : ''}.`);
    return;
  }
  const reviews = `/repos/${results.repository}/pulls/${results.pullRequest}/reviews`;
  const review = {
    commit_id: results.headSha,
    event: 'COMMENT',
    body: reviewBody(placement, results.headSha),
    comments: placement.inline.map(({ finding, line }) => ({ path: finding.file, line, side: 'RIGHT', body: threadBody(finding) })),
  };
  assertNoSecrets(JSON.stringify(review), secrets, 'The review');
  try {
    await api('POST', reviews, review);
    log(`Posted a review with ${placement.inline.length} threads and ${placement.inBody.length} findings in its body.`);
  } catch (error) {
    log(`::warning::GitHub refused the inline threads (${errorText(error)}); posting them in the review's body.`);
    const fallback = { inline: [], inBody: [...placement.inline.map((p) => p.finding), ...placement.inBody], alreadyPosted: placement.alreadyPosted };
    await api('POST', reviews, { commit_id: results.headSha, event: 'COMMENT', body: reviewBody(fallback, results.headSha) });
  }
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
  const comments = issueComments(results.repository, results.pullRequest);
  let listError = `more than ${commentPageSize * maxCommentPages} comments`;
  const listed = await readCommentPages(comments, async (url) => {
    try {
      return (await api('GET', url)) as ListedComment[];
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

// The commit the bot's newest summary comment says it last reviewed, or undefined when there's none or it's unreadable:
// a refused request, a fetch that rejects, such as on a DNS failure or a reset connection, or a body that isn't JSON.
export async function lastReviewedHead(repository: string, number: number, token: string | undefined, fetchPage: typeof fetch = fetch): Promise<string | undefined> {
  const all = await readCommentPages(issueComments(repository, number), async (url) => {
    try {
      const response = await fetchPage(`https://api.github.com${url}`, {
        headers: { accept: 'application/vnd.github+json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
      });
      return response.ok ? ((await response.json()) as ListedComment[]) : undefined;
    } catch {
      return undefined;
    }
  });
  return newestReviewedHead(all);
}

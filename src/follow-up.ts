// Closing the loop on the bot's own review threads, in the publish step with the app's token. A re-review that finds an
// earlier finding fixed, where the thread is outdated or its lines changed, resolves the thread. One that finds it still
// open after the autopilot replied posts one reply saying why and asking the maintainer, and never a second. It never
// resolves or answers anyone else's thread. A thread someone with write access dismissed, by resolving it without a code
// change or with a 👎, counts as already posted, so its finding isn't posted again.

import { writerAssociations } from './command.ts';
import { errorText } from './comments.ts';
import { writeLog } from './log.ts';
import { assertNoSecrets } from './outputs.ts';
import { autopilotPrefix } from './pause.ts';
import { botAuthor, type ThreadNode } from './rereview.ts';
import type { Results } from './results.ts';
import { parsePosted, snapDistance, type PostedThread } from './threads.ts';

export const stillOpenMarker = '<!-- ncode-review:still-open -->';

function postedFinding(thread: ThreadNode): PostedThread | undefined {
  const first = thread.first.nodes[0];
  if (!first || first.author?.login !== botAuthor) return undefined;
  return parsePosted([{ body: first.body, path: thread.path, line: thread.line, original_line: thread.originalLine }])[0];
}

// The bot's threads the maintainer dismissed: resolved by someone with write access while still on the code they were
// posted on, or with a 👎 from someone with write access on the finding. A pull request's author can resolve threads
// too, so a resolution by anyone else doesn't count. A thread an app resolved, the bot included, has no resolver, since
// GraphQL's `resolvedBy` is a user; the bot's own login is ruled out too, so it is never looked up as a person.
// `isWriter` looks up a login's access; one it can't look up doesn't count.
export async function dismissedThreads(threads: ThreadNode[], isWriter: (login: string) => Promise<boolean>): Promise<{ thread: ThreadNode; posted: PostedThread }[]> {
  const dismissed: { thread: ThreadNode; posted: PostedThread }[] = [];
  const access = new Map<string, Promise<boolean>>();
  const writer = (login: string) => {
    if (!access.has(login)) access.set(login, isWriter(login).catch(() => false));
    return access.get(login)!;
  };
  for (const thread of threads) {
    const posted = postedFinding(thread);
    if (!posted) continue;
    const resolver = thread.resolvedBy?.login;
    const resolvedAsIs = thread.isResolved && !thread.isOutdated && !!resolver && resolver !== botAuthor && resolver !== `${botAuthor}[bot]` && (await writer(resolver));
    let thumbsDown = false;
    if (!resolvedAsIs) {
      for (const reaction of thread.first.nodes[0]!.reactions.nodes) {
        const login = reaction.user?.login;
        if (login && login !== botAuthor && (await writer(login))) {
          thumbsDown = true;
          break;
        }
      }
    }
    if (resolvedAsIs || thumbsDown) dismissed.push({ thread, posted });
  }
  return dismissed;
}

export type FollowUp = { kind: 'resolve'; thread: ThreadNode; id: string } | { kind: 'reply'; thread: ThreadNode; id: string; body: string };

// A thread's line, while it isn't outdated, is on or next to a line changed since the last review.
function linesChanged(thread: ThreadNode, changed: Record<string, number[]>): boolean {
  const line = thread.line;
  return line !== null && (changed[thread.path] ?? []).some((l) => Math.abs(l - line) <= snapDistance);
}

// Whether the bot has said in this thread why the finding stays open. When the thread has more comments than were read
// and none of them is that reply, it can't tell, and counts it as said, so it never says it twice.
function alreadyAnswered(thread: ThreadNode): boolean {
  if ([...thread.first.nodes, ...thread.comments.nodes].some((c) => c.author?.login === botAuthor && c.body.includes(stillOpenMarker))) return true;
  const firstInLast = thread.comments.nodes.some((c) => c.url === thread.first.nodes[0]?.url);
  return thread.comments.totalCount > thread.comments.nodes.length + (firstInLast ? 0 : 1);
}

const maxNoteChars = 1_000;

export function stillOpenReply(headSha: string, note: string, maintainer: string): string {
  const reason = note.replace(/\s+/g, ' ').trim().slice(0, maxNoteChars).replace(/</g, '&lt;').replace(/@/g, '@\u200b') || 'The re-review still finds the problem in the code now.';
  const who = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/.test(maintainer) ? `@${maintainer}` : 'Maintainer';
  return [stillOpenMarker, `This stays open: the re-review at ${headSha.slice(0, 7)} still finds it. ${reason}`, '', `${who}: needs you.`].join('\n');
}

// What to do with each of the bot's unresolved threads after a re-review, from the status it gave each one. A full
// review gives none, so it does nothing: it can't tell an earlier finding it no longer raises from one it words anew.
export function planFollowUps(
  threads: ThreadNode[],
  results: Pick<Results, 'headSha' | 'reReview'>,
  dismissed: ReadonlySet<string> = new Set(),
): FollowUp[] {
  const reReview = results.reReview;
  if (!reReview) return [];
  const statuses = new Map(reReview.earlier.map((e) => [e.url, e]));
  const actions: FollowUp[] = [];
  for (const thread of threads) {
    const posted = postedFinding(thread);
    if (!posted || thread.isResolved) continue;
    const status = statuses.get(thread.first.nodes[0]!.url);
    if (!status) continue;
    if (status.status === 'fixed' && (thread.isOutdated || linesChanged(thread, reReview.changedLines))) {
      actions.push({ kind: 'resolve', thread, id: posted.id });
      continue;
    }
    if (status.status !== 'open' || dismissed.has(thread.id)) continue;
    const last = thread.comments.nodes.at(-1);
    const login = last?.author?.login;
    if (!last || !login || login === botAuthor || !writerAssociations.has(last.authorAssociation) || !last.body.trimStart().startsWith(autopilotPrefix)) continue;
    if (alreadyAnswered(thread)) continue;
    actions.push({ kind: 'reply', thread, id: posted.id, body: stillOpenReply(results.headSha, status.note, login) });
  }
  return actions;
}

const resolveMutation = 'mutation($id: ID!) { resolveReviewThread(input: { threadId: $id }) { thread { isResolved } } }';
const replyMutation = 'mutation($id: ID!, $body: String!) { addPullRequestReviewThreadReply(input: { pullRequestReviewThreadId: $id, body: $body }) { comment { url } } }';

// Carries out the follow-ups through `graphql`, which throws on a refusal. A failed one only warns.
export async function followUpThreads(
  graphql: (query: string, variables: Record<string, unknown>) => Promise<unknown>,
  actions: FollowUp[],
  secrets: Iterable<string>,
  log: (line: string) => void = writeLog,
): Promise<void> {
  for (const action of actions) {
    try {
      if (action.kind === 'resolve') {
        await graphql(resolveMutation, { id: action.thread.id });
        log(`Resolved the thread of ${action.id}: the re-review found it fixed.`);
      } else {
        assertNoSecrets(action.body, secrets, 'The reply');
        await graphql(replyMutation, { id: action.thread.id, body: action.body });
        log(`Replied in the thread of ${action.id} that it stays open.`);
      }
    } catch (error) {
      log(`::warning::Couldn't ${action.kind === 'resolve' ? 'resolve' : 'reply in'} the thread of ${action.id} (${errorText(error)}).`);
    }
  }
}

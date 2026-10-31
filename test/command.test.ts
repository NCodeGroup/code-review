import assert from 'node:assert/strict';
import { test } from 'node:test';
import { commandFromEvent, isFromFork, maxQuestionChars, parseCommand, skipReason, skipReasonFor } from '../src/command.ts';
import { findFinding, type ReviewComment } from '../src/explain.ts';

test('commandFromEvent accepts only an exact /review from a writer on a pull request', () => {
  const event = (body: string, association = 'MEMBER', pullRequest: unknown = {}) => ({
    issue: { number: 7, pull_request: pullRequest },
    comment: { body, author_association: association },
  });
  assert.deepEqual(commandFromEvent(event('/review')), { command: { kind: 'review' }, number: 7 });
  assert.deepEqual(commandFromEvent(event('  /review\n')), { command: { kind: 'review' }, number: 7 });
  assert.equal(commandFromEvent(event('/review please')), undefined);
  assert.equal(commandFromEvent(event('Run /review again')), undefined);
  assert.equal(commandFromEvent(event('/review', 'CONTRIBUTOR')), undefined);
  assert.equal(commandFromEvent(event('/review', 'NONE')), undefined);
  assert.equal(commandFromEvent(event('/review', 'MEMBER', null)), undefined);
});

test('parseCommand reads /review explain with a finding id and no question', () => {
  assert.deepEqual(parseCommand('/review explain F3'), { kind: 'explain', ref: { kind: 'id', id: 'F3' }, question: '' });
  assert.deepEqual(parseCommand('  /review explain f12\n'), { kind: 'explain', ref: { kind: 'id', id: 'F12' }, question: '' });
  assert.deepEqual(parseCommand('/review explain F3:'), { kind: 'explain', ref: { kind: 'id', id: 'F3' }, question: '' });
});

test('parseCommand takes the rest of the comment after the ref as the question', () => {
  assert.deepEqual(parseCommand('/review explain F3 why is a null here a problem?'), {
    kind: 'explain',
    ref: { kind: 'id', id: 'F3' },
    question: 'why is a null here a problem?',
  });
  assert.deepEqual(parseCommand('/review explain F3\n\nThe caller checks it first.\nDoesn\'t that cover it?'), {
    kind: 'explain',
    ref: { kind: 'id', id: 'F3' },
    question: 'The caller checks it first.\nDoesn\'t that cover it?',
  });
  const long = parseCommand(`/review explain F1 ${'x'.repeat(maxQuestionChars + 50)}`);
  assert.equal(long?.kind === 'explain' && long.question.length, maxQuestionChars);
});

test('parseCommand reads a link to a review comment as the ref', () => {
  const ref = (url: string) => {
    const command = parseCommand(`/review explain ${url} is this still true?`);
    return command?.kind === 'explain' ? command.ref : undefined;
  };
  const expected = { kind: 'url', host: 'github.com', repository: 'NCodeGroup/code-review', number: 7, commentId: 1234 };
  assert.deepEqual(ref('https://github.com/NCodeGroup/code-review/pull/7#discussion_r1234'), { ...expected, url: 'https://github.com/NCodeGroup/code-review/pull/7#discussion_r1234' });
  assert.deepEqual(ref('https://github.com/NCodeGroup/code-review/pull/7/files#r1234'), { ...expected, url: 'https://github.com/NCodeGroup/code-review/pull/7/files#r1234' });
  assert.deepEqual(ref('<https://github.com/NCodeGroup/code-review/pull/7#discussion_r1234>'), { ...expected, url: 'https://github.com/NCodeGroup/code-review/pull/7#discussion_r1234' });
  assert.equal(parseCommand('/review explain https://github.com/NCodeGroup/code-review/pull/7#discussion_r1234 why?')?.kind, 'explain');
});

test('parseCommand reads a ref that is neither an id nor a review-comment link as invalid', () => {
  const ref = (text: string) => {
    const command = parseCommand(text);
    return command?.kind === 'explain' ? command.ref : undefined;
  };
  assert.deepEqual(ref('/review explain'), { kind: 'invalid', text: '' });
  assert.deepEqual(ref('/review explain the null check'), { kind: 'invalid', text: 'the' });
  assert.deepEqual(ref('/review explain F0'), { kind: 'invalid', text: 'F0' });
  assert.equal(ref('/review explain http://github.com/NCodeGroup/code-review/pull/7#discussion_r1234')?.kind, 'invalid');
  assert.equal(ref('/review explain https://github.com/NCodeGroup/code-review/pull/7')?.kind, 'invalid');
  assert.equal(ref('/review explain https://github.com/NCodeGroup/code-review/issues/7#issuecomment-1234')?.kind, 'invalid');
  assert.equal(ref('/review explain https://github.com/NCodeGroup/code-review/pull/7?x=1#discussion_r1234')?.kind, 'invalid');
});

test('parseCommand ignores a comment that only mentions /review explain', () => {
  assert.equal(parseCommand('/review explainer F3'), undefined);
  assert.equal(parseCommand('/review please explain F3'), undefined);
  assert.equal(parseCommand('Could you /review explain F3?'), undefined);
  assert.equal(parseCommand('/review\nexplain F3'), undefined);
  assert.equal(parseCommand('/reviewexplain F3'), undefined);
});

test('commandFromEvent accepts /review explain only from a writer on a pull request', () => {
  const event = (association: string, pullRequest: unknown = {}) => ({
    issue: { number: 7, pull_request: pullRequest },
    comment: { body: '/review explain F2 why?', author_association: association },
  });
  assert.deepEqual(commandFromEvent(event('COLLABORATOR')), { command: { kind: 'explain', ref: { kind: 'id', id: 'F2' }, question: 'why?' }, number: 7 });
  assert.equal(commandFromEvent(event('CONTRIBUTOR')), undefined);
  assert.equal(commandFromEvent(event('NONE')), undefined);
  assert.equal(commandFromEvent(event('MEMBER', null)), undefined);
});

// Two reviews of one pull request, each numbering its findings from F1: the newer review's comments have higher ids.
function finding(id: number, review: number, findingId: string, path = 'src/a.ts'): ReviewComment {
  return {
    id,
    pull_request_review_id: review,
    path,
    line: id,
    user: { login: 'ncode-review[bot]' },
    body: `finding ${findingId} of review ${review}\n<!-- ncode-review:finding id=${findingId} fp=0123456789abcdef severity=nit -->`,
    pull_request_url: 'https://api.github.com/repos/NCodeGroup/code-review/pulls/7',
  };
}
const twoReviews = [finding(10, 1, 'F1', 'old.ts'), finding(11, 1, 'F2'), finding(12, 1, 'F3'), finding(20, 2, 'F1', 'new.ts'), finding(21, 2, 'F2')];
const where = { repository: 'NCodeGroup/code-review', number: 7, host: 'github.com' };
const listing = (comments: ReviewComment[]) => async (path: string) => (path.startsWith('/repos/NCodeGroup/code-review/pulls/7/comments?') ? comments : undefined);

test('an id two reviews share means the newest review\'s finding', async () => {
  const resolved = await findFinding({ kind: 'id', id: 'F1' }, where, listing(twoReviews));
  assert.ok('found' in resolved);
  assert.equal(resolved.found.comment.id, 20);
  assert.equal(resolved.found.comment.path, 'new.ts');
});

test('an id only an earlier review has is unknown, and the newest review\'s ids are listed', async () => {
  assert.deepEqual(await findFinding({ kind: 'id', id: 'F3' }, where, listing(twoReviews)), { validIds: ['F1', 'F2'] });
});

test('a link names a finding from an earlier review exactly', async () => {
  const read = async (path: string) => (path === '/repos/NCodeGroup/code-review/pulls/comments/10' ? twoReviews[0] : listing(twoReviews)(path));
  const resolved = await findFinding({ kind: 'url', url: 'https://github.com/NCodeGroup/code-review/pull/7#discussion_r10', host: 'github.com', repository: 'NCodeGroup/code-review', number: 7, commentId: 10 }, where, read);
  assert.ok('found' in resolved);
  assert.equal(resolved.found.id, 'F1');
  assert.equal(resolved.found.comment.path, 'old.ts');
});

test('isFromFork treats a head in another repository, or in none, as a fork', () => {
  assert.equal(isFromFork({ head: { repo: { full_name: 'NCodeGroup/code-review' } } }, 'NCodeGroup/code-review'), false);
  assert.equal(isFromFork({ head: { repo: { full_name: 'someone/code-review' } } }, 'NCodeGroup/code-review'), true);
  assert.equal(isFromFork({ head: { repo: null } }, 'NCodeGroup/code-review'), true);
  assert.equal(isFromFork({ head: {} }, 'NCodeGroup/code-review'), true);
  assert.equal(isFromFork(undefined, 'NCodeGroup/code-review'), true);
});

const own = { number: 7, head: { sha: 'a'.repeat(40), repo: { full_name: 'NCodeGroup/code-review' } } };

// A lookup that records whether it was called, and answers with the given head.
function lookup(head: string | undefined): { calls: number; fn: () => Promise<string | undefined> } {
  const result = { calls: 0, fn: async () => { result.calls++; return head; } };
  return result;
}

test('skipReason skips a pull request from a fork or a deleted fork, without looking up the reviewed head', async () => {
  const looked = lookup('a'.repeat(40));
  assert.match((await skipReason({ ...own, head: { ...own.head, repo: { full_name: 'someone/code-review' } } }, 'NCodeGroup/code-review', looked.fn)) ?? '', /#7 comes from a fork/);
  assert.match((await skipReason({ ...own, head: { sha: own.head.sha, repo: null } }, 'NCodeGroup/code-review', looked.fn)) ?? '', /comes from a fork/);
  assert.equal(looked.calls, 0);
});

test('skipReason skips an automatic review of a head already reviewed', async () => {
  assert.match((await skipReason(own, 'NCodeGroup/code-review', lookup('a'.repeat(40)).fn)) ?? '', /aaaaaaa was already reviewed; comment \/review/);
});

test('skipReason reviews a head not yet reviewed', async () => {
  assert.equal(await skipReason(own, 'NCodeGroup/code-review', lookup('b'.repeat(40)).fn), undefined);
});

test('skipReason reviews when no lookup is passed', async () => {
  assert.equal(await skipReason(own, 'NCodeGroup/code-review'), undefined);
});

test('skipReason reviews a pull request with no head commit, without looking up the reviewed head', async () => {
  const looked = lookup('a'.repeat(40));
  assert.equal(await skipReason({ number: 7, head: { repo: { full_name: 'NCodeGroup/code-review' } } }, 'NCodeGroup/code-review', looked.fn), undefined);
  assert.equal(looked.calls, 0);
});

test('skipReasonFor reviews a head already reviewed again for a /review comment, without looking it up', async () => {
  const looked = lookup('a'.repeat(40));
  assert.equal(await skipReasonFor('comment', own, 'NCodeGroup/code-review', looked.fn), undefined);
  assert.equal(looked.calls, 0);
});

test('skipReasonFor skips a head already reviewed for an automatic run', async () => {
  const looked = lookup('a'.repeat(40));
  assert.match((await skipReasonFor('automatic', own, 'NCodeGroup/code-review', looked.fn)) ?? '', /already reviewed/);
  assert.equal(looked.calls, 1);
});

test('skipReasonFor skips a fork for either trigger', async () => {
  const fork = { ...own, head: { ...own.head, repo: { full_name: 'someone/code-review' } } };
  for (const trigger of ['comment', 'automatic'] as const) {
    assert.match((await skipReasonFor(trigger, fork, 'NCodeGroup/code-review', lookup(undefined).fn)) ?? '', /comes from a fork/);
  }
});

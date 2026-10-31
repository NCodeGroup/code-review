import assert from 'node:assert/strict';
import { test } from 'node:test';
import { commandFromEvent, isFromFork, skipReason } from '../src/command.ts';

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

test('skipReason reviews a head not yet reviewed, a /review that passes no lookup, and a pull request with no head commit', async () => {
  assert.equal(await skipReason(own, 'NCodeGroup/code-review', lookup('b'.repeat(40)).fn), undefined);
  assert.equal(await skipReason(own, 'NCodeGroup/code-review'), undefined);
  const looked = lookup('a'.repeat(40));
  assert.equal(await skipReason({ number: 7, head: { repo: { full_name: 'NCodeGroup/code-review' } } }, 'NCodeGroup/code-review', looked.fn), undefined);
  assert.equal(looked.calls, 0);
});

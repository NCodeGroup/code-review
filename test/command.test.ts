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

test('skipReason skips an automatic review of a pull request from a fork or a deleted fork', () => {
  const own = { number: 7, head: { sha: 'a'.repeat(40), repo: { full_name: 'NCodeGroup/code-review' } } };
  assert.match(skipReason({ ...own, head: { ...own.head, repo: { full_name: 'someone/code-review' } } }, 'NCodeGroup/code-review') ?? '', /#7 comes from a fork/);
  assert.match(skipReason({ ...own, head: { sha: own.head.sha, repo: null } }, 'NCodeGroup/code-review') ?? '', /comes from a fork/);
});

test('skipReason skips an automatic review of a head already reviewed', () => {
  const own = { number: 7, head: { sha: 'a'.repeat(40), repo: { full_name: 'NCodeGroup/code-review' } } };
  assert.match(skipReason(own, 'NCodeGroup/code-review', 'a'.repeat(40)) ?? '', /aaaaaaa was already reviewed; comment \/review/);
});

test('skipReason reviews a head not yet reviewed, or a pull request with no head commit', () => {
  const own = { number: 7, head: { sha: 'a'.repeat(40), repo: { full_name: 'NCodeGroup/code-review' } } };
  assert.equal(skipReason(own, 'NCodeGroup/code-review'), undefined);
  assert.equal(skipReason(own, 'NCodeGroup/code-review', 'b'.repeat(40)), undefined);
  assert.equal(skipReason({ number: 7, head: { repo: { full_name: 'NCodeGroup/code-review' } } }, 'NCodeGroup/code-review', 'a'.repeat(40)), undefined);
});

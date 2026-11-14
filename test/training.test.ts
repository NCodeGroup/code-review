import assert from 'node:assert/strict';
import { test } from 'node:test';
import { botLogin } from '../src/results.ts';
import { useGitHubDotCom } from './github-env.ts';

useGitHubDotCom();

const finding = (title: string) => `🟡 **Nit: ${title}** <sub>F1 · tests</sub>\n\nThe problem.\n\n<!-- ncode-review:finding id=F1 fp=abc severity=nit -->`;
const pull = 'https://api.github.com/repos/o/r/pulls/7';
const bot = (id: number, title = 'Title', pullUrl = pull) => ({ id, user: { login: botLogin }, body: finding(title), path: 'a.cs', line: 3, original_line: 4, pull_request_url: pullUrl });
const reply = (id: number, to: number, body: string, login = 'polewskm') => ({ id, in_reply_to_id: to, user: { login }, body, pull_request_url: pull });

test('outcomeSources reads the verdict of a fixed and a declined finding with the replies', async () => {
  const { outcomeSources } = await import('../training/run.ts');
  const sources = outcomeSources([bot(1, 'One'), bot(2, 'Two'), reply(11, 1, 'Autopilot: fixed in abc1234'), reply(12, 2, 'Autopilot: not changed. It is intended.')], 'Repo', 'polewskm');
  assert.equal(sources.length, 1);
  const [source] = sources;
  assert.equal(source!.kind, 'review-outcomes');
  assert.equal(source!.id, 'outcomes-7');
  assert.equal(source!.label, 'Repo outcomes of #7');
  assert.match(source!.text, /^The review bot's findings on pull request #7 that the maintainer answered, with the replies:\n\n/);
  assert.match(source!.text, /Finding F1 \(nit, by tests\) on a\.cs, line 4: One\nThe problem\.\nOutcome: fixed\nMaintainer: Autopilot: fixed in abc1234/);
  assert.match(source!.text, /Finding F1 \(nit, by tests\) on a\.cs, line 4: Two\nThe problem\.\nOutcome: declined\nMaintainer: Autopilot: not changed\. It is intended\./);
});

test('maintainerComments keeps only the maintainer top-level comments with their replies, one source per pull request', async () => {
  const { maintainerComments } = await import('../training/run.ts');
  const other = 'https://api.github.com/repos/o/r/pulls/8';
  const mine = (id: number, body: string, pullUrl = pull) => ({ id, user: { login: 'polewskm' }, body, path: 'a.cs', line: 3, original_line: 4, diff_hunk: '@@ -1 +1 @@\n+x', pull_request_url: pullUrl });
  const sources = maintainerComments([mine(1, 'Use a span.'), mine(2, 'Rename it.', other), bot(3), reply(21, 1, 'Done', 'someone-else')], 'Repo', 'polewskm');
  assert.deepEqual(sources.map((s) => [s.kind, s.id, s.label]), [['review-comments', 'pr-7', 'Repo review of #7'], ['review-comments', 'pr-8', 'Repo review of #8']]);
  assert.match(sources[0]!.text, /Maintainer: Use a span\.\nReply from someone-else: Done/);
  assert.doesNotMatch(sources[0]!.text, /Title/);
});

test('outcomeSources leaves out a finding nobody answered and a reply from another login', async () => {
  const { outcomeSources } = await import('../training/run.ts');
  const sources = outcomeSources([bot(1), bot(2), reply(11, 2, 'Autopilot: fixed in abc1234', 'someone-else')], 'Repo', 'polewskm');
  assert.deepEqual(sources, []);
});

test('outcomeSources calls a plain reply answered', async () => {
  const { outcomeSources } = await import('../training/run.ts');
  const [source] = outcomeSources([bot(1), reply(11, 1, 'Thanks')], 'Repo', 'polewskm');
  assert.match(source!.text, /Outcome: answered\nMaintainer: Thanks/);
});

test('outcomeSources splits a long pull request into numbered sources with one label', async () => {
  const { outcomeSources } = await import('../training/run.ts');
  const sources = outcomeSources([bot(1), bot(2), reply(11, 1, 'Thanks'), reply(12, 2, 'Thanks')], 'Repo', 'polewskm', 200);
  assert.deepEqual(sources.map((s) => s.id), ['outcomes-7-1', 'outcomes-7-2']);
  assert.deepEqual(sources.map((s) => s.label), ['Repo outcomes of #7', 'Repo outcomes of #7']);
});

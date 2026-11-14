import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
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

test('sourceScopes keeps each general glob once when several folders share a file pattern', async () => {
  const { sourceScopes } = await import('../training/run.ts');
  const scopes = sourceScopes([{ label: 'Repo csharp-production.instructions.md', applyTo: ['src/**/*.cs', 'hosts/**/*.cs', 'analyzers/**/*.cs'] }]);
  assert.deepEqual(scopes.get('Repo csharp-production.instructions.md'), ['**/*.cs']);
});

test('outcomeSources calls an Autopilot nothing-to-change reply declined', async () => {
  const { outcomeSources } = await import('../training/run.ts');
  const [source] = outcomeSources([bot(1), reply(11, 1, 'Autopilot: nothing to change. The sibling does the same.')], 'Repo', 'polewskm');
  assert.match(source!.text, /Outcome: declined\nMaintainer: Autopilot: nothing to change\./);
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

test('extractedFolder finds a folder that differs in case and keeps its spelling for the labels', async () => {
  const { extractedFolder } = await import('../training/run.ts');
  const base = mkdtempSync(path.join(tmpdir(), 'training-folder-'));
  mkdirSync(path.join(base, 'NCodeGroup-Identity'));
  assert.deepEqual(extractedFolder(base, 'NCodeGroup/identity'), { dir: path.join(base, 'NCodeGroup-Identity'), repoName: 'Identity' });
});

test('extractedFolder names the folder a first run creates when none exists', async () => {
  const { extractedFolder } = await import('../training/run.ts');
  const base = mkdtempSync(path.join(tmpdir(), 'training-folder-'));
  assert.deepEqual(extractedFolder(base, 'NCodeGroup/identity-platform'), { dir: path.join(base, 'NCodeGroup-identity-platform'), repoName: 'identity-platform' });
});

test('extractRequest names the files an instruction file applies to', async () => {
  const { extractRequest } = await import('../training/run.ts');
  assert.match(extractRequest({ label: 'L', text: 'T', applyTo: ['src/**/*.cs'] }), /^Source: L\nApplies to: src\/\*\*\/\*\.cs\n\n<source>\nT\n<\/source>$/);
});

test('extractRequest without applyTo is the label and the source only', async () => {
  const { extractRequest } = await import('../training/run.ts');
  assert.equal(extractRequest({ label: 'L', text: 'T' }), 'Source: L\n\n<source>\nT\n</source>');
});

test('staleExtractions lists a saved extraction no source names and not one a source names', async () => {
  const { saveExtracted, staleExtractions } = await import('../training/run.ts');
  const dir = mkdtempSync(path.join(tmpdir(), 'training-stale-'));
  const saved = { hash: 'h', promptHash: 'p', label: 'L', rules: [] };
  saveExtracted(path.join(dir, 'adr', '0204-x.json'), saved);
  saveExtracted(path.join(dir, 'adr', '0205-y.json'), saved);
  writeFileSync(path.join(dir, 'adr', 'notes.txt'), 'kept');
  assert.deepEqual(staleExtractions(dir, [{ kind: 'adr', id: '0205-y' }]), [path.join(dir, 'adr', '0204-x.json')]);
  assert.deepEqual(staleExtractions(path.join(dir, 'missing'), []), []);
});

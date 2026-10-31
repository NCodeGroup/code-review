import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { commandFromEvent, maxRuleChars, parseCommand, type Command } from '../src/command.ts';
import type { GitHubApi, ReviewComment } from '../src/explain.ts';
import { SecretFoundError } from '../src/outputs.ts';
import {
  fenced,
  GitHubError,
  guidanceLabel,
  issueBody,
  issueTitle,
  openGuidanceIssue,
  planTeaching,
  postTeaching,
  publishTeaching,
  replyBody,
  teachingFile,
  usageBody,
  type Teaching,
} from '../src/teach.ts';
import { fetchGuidanceIssues, ruleFromIssue, taughtRules, withTaughtRules, type GuidanceIssue } from '../training/guidance-issues.ts';

type Teach = Extract<Command, { kind: 'teach' }>;

test('parseCommand reads /review teach with a free-standing rule', () => {
  assert.deepEqual(parseCommand('/review teach Prefer records for DTOs.'), { kind: 'teach', scope: 'repository', rule: 'Prefer records for DTOs.' });
  assert.deepEqual(parseCommand('  /review teach\nLine one.\nLine two.\n'), { kind: 'teach', scope: 'repository', rule: 'Line one.\nLine two.' });
});

test('parseCommand reads /review teach F<n> as a rule from that finding', () => {
  assert.deepEqual(parseCommand("/review teach F2 don't flag ConfigureAwait in test code"), {
    kind: 'teach',
    scope: 'repository',
    ref: { kind: 'id', id: 'F2' },
    rule: "don't flag ConfigureAwait in test code",
  });
  assert.deepEqual(parseCommand('/review teach f12: tests may block'), { kind: 'teach', scope: 'repository', ref: { kind: 'id', id: 'F12' }, rule: 'tests may block' });
  const link = parseCommand('/review teach https://github.com/NCodeGroup/code-review/pull/7#discussion_r9 a rule') as Teach;
  assert.deepEqual(link.ref, { kind: 'url', host: 'github.com', repository: 'NCodeGroup/code-review', number: 7, commentId: 9 });
  assert.equal(link.rule, 'a rule');
});

test('parseCommand reads /review teach org as an NCodeGroup-wide rule', () => {
  assert.deepEqual(parseCommand('/review teach org Name async methods with Async.'), { kind: 'teach', scope: 'org', rule: 'Name async methods with Async.' });
  assert.deepEqual(parseCommand('/review teach org F2 a rule'), { kind: 'teach', scope: 'org', rule: 'F2 a rule' });
  assert.deepEqual(parseCommand('/review teach organizations own repositories'), { kind: 'teach', scope: 'repository', rule: 'organizations own repositories' });
});

test('parseCommand keeps an empty rule for the teach step to answer, and ignores a mere mention', () => {
  assert.deepEqual(parseCommand('/review teach'), { kind: 'teach', scope: 'repository', rule: '' });
  assert.deepEqual(parseCommand('/review teach F3'), { kind: 'teach', scope: 'repository', ref: { kind: 'id', id: 'F3' }, rule: '' });
  assert.deepEqual(parseCommand('/review teach org'), { kind: 'teach', scope: 'org', rule: '' });
  assert.equal(parseCommand('/review teacher F3'), undefined);
  assert.equal(parseCommand('Please /review teach F3 x'), undefined);
  assert.equal(parseCommand('/review\nteach F3 x'), undefined);
});

test('commandFromEvent takes /review teach only from a writer, in a top-level comment on a pull request', () => {
  const event = (association: string, pullRequest: unknown = {}) => ({
    issue: { number: 7, pull_request: pullRequest },
    comment: { body: '/review teach F2 a rule', author_association: association },
  });
  assert.deepEqual(commandFromEvent(event('OWNER')), { command: { kind: 'teach', scope: 'repository', ref: { kind: 'id', id: 'F2' }, rule: 'a rule' }, number: 7 });
  for (const association of ['CONTRIBUTOR', 'FIRST_TIME_CONTRIBUTOR', 'NONE']) assert.equal(commandFromEvent(event(association)), undefined);
  assert.equal(commandFromEvent(event('MEMBER', null)), undefined, 'a comment on an issue');
  // A reply in a review thread is a pull_request_review_comment event: a pull request and a comment, but no issue.
  const threadReply = { pull_request: { number: 7 }, comment: { body: '/review teach org a rule', author_association: 'MEMBER', in_reply_to_id: 5 } };
  assert.equal(commandFromEvent(threadReply), undefined);
});

function finding(extra: Partial<ReviewComment> = {}): ReviewComment {
  return {
    id: 42,
    pull_request_review_id: 200,
    path: 'src/a.ts',
    line: 12,
    user: { login: 'ncode-review[bot]' },
    body: '🟠 **Should fix: ConfigureAwait missing** <sub>F2 · async</sub>\n\nThe await in `Run` has no ConfigureAwait(false).\n\n<!-- ncode-review:finding id=F2 fp=0123456789abcdef severity=should-fix -->',
    html_url: 'https://github.com/NCodeGroup/code-review/pull/7#discussion_r42',
    pull_request_url: 'https://api.github.com/repos/NCodeGroup/code-review/pulls/7',
    ...extra,
  };
}

const listPath = '/repos/NCodeGroup/code-review/pulls/7/comments?per_page=100&page=1';
const context = {
  repository: 'NCodeGroup/code-review',
  number: 7,
  host: 'github.com',
  commentUrl: 'https://github.com/NCodeGroup/code-review/pull/7#issuecomment-99',
  author: 'polewskm',
  isPrivate: false,
};
const source = { ...context, pullRequest: 7 };

function reader(table: Record<string, unknown>): { reads: string[]; read: (p: string) => Promise<unknown> } {
  const reads: string[] = [];
  return { reads, read: async (p) => { reads.push(p); return table[p]; } };
}

test('planTeaching for teach F2 words an issue with the rule, the link and the finding\'s file, line and text', async () => {
  const { read } = reader({ [listPath]: [finding()] });
  const plan = await planTeaching(parseCommand("/review teach F2 don't flag ConfigureAwait in test code") as Teach, context, read);
  assert.ok('teaching' in plan);
  const { teaching } = plan;
  assert.equal(teaching.target, 'NCodeGroup/code-review');
  assert.equal(teaching.scope, 'repository');
  assert.equal(teaching.title, "Review guidance: don't flag ConfigureAwait in test code");
  assert.match(teaching.body, /^<!-- ncode-review:guidance scope=repository -->\n\n`polewskm` taught this project review rule with `\/review teach` on \[NCodeGroup\/code-review#7\]\(https:\/\/github\.com\/NCodeGroup\/code-review\/pull\/7#issuecomment-99\)\./);
  assert.ok(teaching.body.includes("### Rule\n\n```text\ndon't flag ConfigureAwait in test code\n```"));
  assert.ok(teaching.body.includes('### From finding F2\n\n[`src/a.ts:12`](https://github.com/NCodeGroup/code-review/pull/7#discussion_r42), as NCode Review posted it:'));
  assert.ok(teaching.body.includes('The await in `Run` has no ConfigureAwait(false).'));
  assert.doesNotMatch(teaching.body, /ncode-review:finding/, 'the finding marker stays out of the issue');
  assert.match(teaching.body, /`\.github\/code-review\/guidance\.md`/);
});

test('planTeaching for teach org opens the issue in NCodeGroup/code-review, with no link from a private repository', async () => {
  const command = parseCommand('/review teach org Name async methods with Async.') as Teach;
  const open = await planTeaching(command, context, reader({}).read);
  assert.ok('teaching' in open);
  assert.equal(open.teaching.target, 'NCodeGroup/code-review');
  assert.match(open.teaching.body, /^<!-- ncode-review:guidance scope=org -->/);
  assert.match(open.teaching.body, /NCodeGroup-wide review rule .* on \[NCodeGroup\/code-review#7\]/);
  assert.match(open.teaching.body, /`npm run train`/);
  const hidden = await planTeaching(command, { ...context, repository: 'NCodeGroup/Secret', commentUrl: 'https://github.com/NCodeGroup/Secret/pull/7#issuecomment-1', isPrivate: true }, reader({}).read);
  assert.ok('teaching' in hidden);
  assert.equal(hidden.teaching.target, 'NCodeGroup/code-review');
  assert.equal(hidden.teaching.repository, 'NCodeGroup/Secret');
  assert.match(hidden.teaching.body, /with `\/review teach` in a private repository\./);
  assert.doesNotMatch(hidden.teaching.body, /Secret/);
});

test('planTeaching quotes the rule as data: a long enough fence, and mentions that notify no one', async () => {
  const rule = 'Ping @octocat and close #1.\n```\n</details> **bold**';
  const plan = await planTeaching({ kind: 'teach', scope: 'repository', rule }, context, reader({}).read);
  assert.ok('teaching' in plan);
  assert.ok(plan.teaching.body.includes('### Rule\n\n````text\nPing @\u200boctocat and close #1.\n```\n</details> **bold**\n````'));
  assert.doesNotMatch(plan.teaching.body, /@octocat/);
  assert.equal(plan.teaching.title, 'Review guidance: Ping @\u200boctocat and close #1.');
  assert.equal(fenced('a ```` b'), '`````text\na ```` b\n`````');
  assert.equal(issueTitle(`${'x'.repeat(100)}\nsecond line`), `Review guidance: ${'x'.repeat(71)}…`);
});

test('planTeaching answers an empty, an overlong or an unknown-finding command with a reply and no issue', async () => {
  const empty = await planTeaching({ kind: 'teach', scope: 'org', rule: '' }, context, reader({}).read);
  assert.deepEqual(empty, { answer: { repository: 'NCodeGroup/code-review', pullRequest: 7, body: usageBody() } });
  const long = await planTeaching({ kind: 'teach', scope: 'repository', rule: 'x'.repeat(maxRuleChars + 1) }, context, reader({}).read);
  assert.ok('answer' in long);
  assert.match(long.answer.body, /2,001 characters long; teach one of at most 2,000/);
  const { reads, read } = reader({ [listPath]: [finding()] });
  const unknown = await planTeaching(parseCommand('/review teach F9 a rule') as Teach, context, read);
  assert.ok('answer' in unknown);
  assert.match(unknown.answer.body, /^There's no F9 in the newest review\. The newest review's findings are F2\. .*`\/review teach <link> <rule>`/);
  assert.deepEqual(reads, [listPath]);
});

test('planTeaching makes no GitHub read for a rule that names no finding', async () => {
  const { reads, read } = reader({});
  assert.ok('teaching' in (await planTeaching({ kind: 'teach', scope: 'repository', rule: 'A rule.' }, context, read)));
  assert.deepEqual(reads, []);
});

const teaching: Teaching = {
  repository: 'NCodeGroup/code-review',
  pullRequest: 7,
  target: 'NCodeGroup/code-review',
  scope: 'repository',
  rule: 'A rule for @someone.',
  title: 'Review guidance: A rule.',
  body: issueBody('repository', 'A rule.', source),
};

// Records each call; `answer` decides each one's result, and an Error it returns is thrown.
function recorder(answer: (method: string, url: string) => unknown): { calls: unknown[][]; api: GitHubApi } {
  const calls: unknown[][] = [];
  return {
    calls,
    api: async (...args) => {
      calls.push(args);
      const result = answer(args[0], args[1]);
      if (result instanceof Error) throw result;
      return result;
    },
  };
}

test('postTeaching creates the missing label, opens the labelled issue and replies with a link to it', async () => {
  const issues = recorder((method, url) =>
    method === 'GET' ? new GitHubError('no label', 404) : url.endsWith('/issues') ? { number: 12, html_url: 'https://github.com/NCodeGroup/code-review/issues/12' } : {},
  );
  const replies = recorder(() => ({ html_url: 'https://github.com/c/1' }));
  assert.equal(await postTeaching(replies.api, issues.api, teaching, ['t'.repeat(20)]), 'https://github.com/c/1');
  assert.deepEqual(issues.calls, [
    ['GET', `/repos/NCodeGroup/code-review/labels/${guidanceLabel}`],
    ['POST', '/repos/NCodeGroup/code-review/labels', { name: guidanceLabel, color: '0e8a16', description: 'A rule taught with /review teach, to add to the review guidance' }],
    ['POST', '/repos/NCodeGroup/code-review/issues', { title: teaching.title, body: teaching.body, labels: [guidanceLabel] }],
  ]);
  assert.deepEqual(replies.calls, [
    ['POST', '/repos/NCodeGroup/code-review/issues/7/comments', { body: 'Opened [NCodeGroup/code-review#12](https://github.com/NCodeGroup/code-review/issues/12) to make this a review rule for this repository.' }],
  ]);
});

test('postTeaching uses an existing label as it is', async () => {
  const issues = recorder((method) => (method === 'GET' ? { name: guidanceLabel } : { number: 3, html_url: 'u' }));
  await postTeaching(recorder(() => ({ html_url: 'r' })).api, issues.api, teaching, []);
  assert.deepEqual(issues.calls.map((c) => `${c[0]} ${c[1]}`), [`GET /repos/NCodeGroup/code-review/labels/${guidanceLabel}`, 'POST /repos/NCodeGroup/code-review/issues']);
});

test('postTeaching replies that the app lacks the permission when GitHub refuses with 403', async () => {
  const issues = recorder((method) => (method === 'GET' ? { name: guidanceLabel } : new GitHubError('Resource not accessible by integration', 403)));
  const replies = recorder(() => ({ html_url: 'r' }));
  await postTeaching(replies.api, issues.api, teaching, []);
  const body = (replies.calls[0]![2] as { body: string }).body;
  assert.match(body, /^I couldn't open a `review-guidance` issue: the NCode Review app can't write issues in NCodeGroup\/code-review\. A maintainer needs to give the app the Issues: Read and write permission\./);
  assert.ok(body.endsWith('```text\nA rule for @\u200bsomeone.\n```'), 'the reply keeps the rule, quoted');
});

test('postTeaching replies that the app lacks the permission when it got no issues token', async () => {
  const replies = recorder(() => ({ html_url: 'r' }));
  await postTeaching(replies.api, undefined, { ...teaching, scope: 'org' }, []);
  assert.equal(replies.calls.length, 1);
  assert.match((replies.calls[0]![2] as { body: string }).body, /Issues: Read and write permission and install it on NCodeGroup\/code-review\./);
});

test('openGuidanceIssue reads 404 as no permission and 410 as issues turned off, and rethrows anything else', async () => {
  assert.deepEqual(await openGuidanceIssue(recorder(() => new GitHubError('x', 404)).api, teaching), { refused: 'permission' });
  assert.deepEqual(await openGuidanceIssue(recorder((m) => (m === 'GET' ? {} : new GitHubError('x', 410))).api, teaching), { refused: 'disabled' });
  assert.match(replyBody(teaching, { refused: 'disabled' }), /issues are turned off in NCodeGroup\/code-review/);
  await assert.rejects(openGuidanceIssue(recorder(() => new GitHubError('x', 500)).api, teaching), /x/);
});

test('postTeaching opens nothing and posts nothing when the issue or the reply holds a secret', async () => {
  const token = 't'.repeat(20);
  for (const leaky of [{ ...teaching, body: `a ${token}` }, { ...teaching, title: `ghp_${'a'.repeat(36)}` }]) {
    const issues = recorder(() => ({ number: 1, html_url: 'u' }));
    const replies = recorder(() => ({ html_url: 'r' }));
    await assert.rejects(postTeaching(replies.api, issues.api, leaky, [token]), SecretFoundError);
    assert.equal(issues.calls.length, 0);
    assert.equal(replies.calls.length, 0);
  }
  // Without an issues token the reply quotes the rule, so it is scanned too.
  const replies = recorder(() => ({ html_url: 'r' }));
  await assert.rejects(postTeaching(replies.api, undefined, { ...teaching, rule: `a ${token}` }, [token]), SecretFoundError);
  assert.equal(replies.calls.length, 0);
});

test('publishTeaching posts the teaching the review step left, and nothing after a review or an explain', async () => {
  const outDir = mkdtempSync(path.join(tmpdir(), 'teach-'));
  let called = false;
  assert.equal(await publishTeaching(outDir, async () => { called = true; }, undefined, []), undefined);
  assert.equal(called, false);
  writeFileSync(path.join(outDir, teachingFile), JSON.stringify(teaching));
  const replies = recorder(() => ({ html_url: 'https://github.com/c/1' }));
  assert.equal(await publishTeaching(outDir, replies.api, undefined, []), 'https://github.com/c/1');
  assert.equal(existsSync(path.join(outDir, 'results.json')), false);
});

function issue(number: number, rule: string, extra: Partial<GuidanceIssue> = {}): GuidanceIssue {
  return {
    number,
    html_url: `https://github.com/NCodeGroup/code-review/issues/${number}`,
    body: issueBody('org', rule, source),
    state_reason: 'completed',
    user: { login: 'ncode-review[bot]' },
    ...extra,
  };
}

test('ruleFromIssue reads back the rule /review teach org quoted, mentions and all', () => {
  assert.equal(ruleFromIssue(issue(1, 'Ask @octocat.\n```\ncode\n```')), 'Ask @octocat.\n```\ncode\n```');
  assert.equal(ruleFromIssue(issue(1, 'A rule.', { body: issueBody('org', 'A rule.', source).replace(/\n/g, '\r\n') })), 'A rule.');
});

test('ruleFromIssue skips an issue not closed as completed, not opened by the bot, a project rule or a pull request', () => {
  assert.equal(ruleFromIssue(issue(1, 'A rule.', { state_reason: 'not_planned' })), undefined);
  assert.equal(ruleFromIssue(issue(1, 'A rule.', { user: { login: 'someone' } })), undefined);
  assert.equal(ruleFromIssue(issue(1, 'A rule.', { body: issueBody('repository', 'A rule.', source) })), undefined);
  assert.equal(ruleFromIssue(issue(1, 'A rule.', { pull_request: {} })), undefined);
  assert.equal(ruleFromIssue(issue(1, 'A rule.', { body: null })), undefined);
});

test('fetchGuidanceIssues reads every page of closed review-guidance issues with the token', async () => {
  const urls: string[] = [];
  const auth: (string | undefined)[] = [];
  const pages = [Array.from({ length: 100 }, (_, i) => issue(i + 1, `Rule ${i + 1}.`)), [issue(101, 'Rule 101.')]];
  const fetchApi = (async (url: string, init?: RequestInit) => {
    urls.push(url);
    auth.push((init?.headers as Record<string, string>)['authorization']);
    return new Response(JSON.stringify(pages[urls.length - 1]), { status: 200 });
  }) as typeof fetch;
  const issues = await fetchGuidanceIssues('NCodeGroup/code-review', 'tok', fetchApi);
  assert.equal(issues.length, 101);
  assert.deepEqual(urls, [1, 2].map((p) => `https://api.github.com/repos/NCodeGroup/code-review/issues?state=closed&labels=review-guidance&per_page=100&page=${p}`));
  assert.deepEqual(auth, ['Bearer tok', 'Bearer tok']);
  await assert.rejects(fetchGuidanceIssues('NCodeGroup/code-review', undefined, (async () => new Response('', { status: 403 })) as typeof fetch), /HTTP 403/);
});

const feedback = '# Corrections to the learned guidance\n\nIntro.\n\n- A maintainer correction.\n';

test('withTaughtRules writes the taught rules into their own section of feedback.md, in issue order', () => {
  const rules = taughtRules([issue(9, 'Second.\nTwo lines.'), issue(3, 'First.'), issue(5, 'Dropped.', { state_reason: 'not_planned' })]);
  const written = withTaughtRules(feedback, rules);
  assert.equal(
    written,
    `${feedback}\n## Taught with /review teach\n\n<!-- Written by \`npm run train\` from the closed \`review-guidance\` issues in NCodeGroup/code-review; each run rewrites this section, so change a rule in its issue. -->\n\n- First. ([NCodeGroup/code-review#3](https://github.com/NCodeGroup/code-review/issues/3))\n- Second.\n  Two lines. ([NCodeGroup/code-review#9](https://github.com/NCodeGroup/code-review/issues/9))\n`,
  );
  assert.equal(withTaughtRules(written, rules), written, 'a second run changes nothing');
  assert.equal(withTaughtRules(written, []), feedback, 'no rules removes the section');
});

test('withTaughtRules keeps a section the maintainer added after it', () => {
  const later = '\n## Later\n\n- Kept.\n';
  const written = `${withTaughtRules(feedback, taughtRules([issue(1, 'Old.')]))}${later}`;
  const rewritten = withTaughtRules(written, taughtRules([issue(2, 'New.')]));
  assert.match(rewritten, /- New\. \(\[NCodeGroup\/code-review#2\]/);
  assert.doesNotMatch(rewritten, /Old\./);
  assert.ok(rewritten.endsWith(later));
  assert.ok(rewritten.startsWith(feedback));
});

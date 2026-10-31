import assert from 'node:assert/strict';
import { test } from 'node:test';
import { commentPageSize, maxCommentPages } from '../src/comments.ts';
import { githubApi } from '../src/github.ts';
import { outcomesMarker, type FindingOutcome } from '../src/outcomes.ts';
import { botLogin, headMarker, reviewMarker, summaryMarker, supersededComment } from '../src/results.ts';
import {
  aggregate,
  costPerFixed,
  discoverRepositories,
  findingsPerPull,
  listClosedPulls,
  maxPullPages,
  maxRepositoryPages,
  monthWindow,
  pageSize,
  parseReportMarker,
  parseRepositories,
  precision,
  previousMonth,
  readPull,
  reportBody,
  reportMarker,
  runReport,
  unattributed,
  type PullRecord,
} from '../tools/report.ts';
import { useGitHubDotCom } from './github-env.ts';

useGitHubDotCom();

const sha = (c: string) => c.repeat(40);

function review(head: string, provider: 'anthropic' | 'bedrock', costUsd: number): string {
  return reviewMarker({ headSha: head, provider, costUsd, synthesisModel: 'claude-opus', reviewers: [] });
}

function finding(id: string, outcome: FindingOutcome['outcome'], reviewers: string[]): FindingOutcome {
  return { id, reviewedAt: sha('a'), reviewers, severity: 'should-fix', outcome };
}

function summary(head: string, provider: 'anthropic' | 'bedrock', costUsd: number, findings?: FindingOutcome[]): string {
  const lines = [summaryMarker, headMarker(head), review(head, provider, costUsd), '### 🤖 Review complete'];
  if (findings) lines.push('', outcomesMarker({ state: 'merged', head, findings }), '### 📋 Outcomes');
  return lines.join('\n');
}

type Comment = { body: string; user: { login: string } };
const bot = (body: string): Comment => ({ body, user: { login: botLogin } });

interface FakeIssue {
  number: number;
  title: string;
  body: string;
  labels: string[];
  user: { login: string };
  html_url: string;
  pull_request?: unknown;
}

// GitHub's REST API as the report calls it, from in-memory repositories, pull requests, comments and issues.
class FakeGitHub {
  orgRepos: { full_name: string; fork?: boolean; private?: boolean }[] = [];
  callers = new Set<string>();
  failingContents = new Set<string>();
  failingPulls = new Set<string>();
  pulls = new Map<string, { number: number; closed_at: string | null; updated_at: string }[]>();
  comments = new Map<string, Comment[]>();
  issues: FakeIssue[] = [];
  calls: string[] = [];
  login = 'github-actions[bot]';

  fetch: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    const method = init?.method ?? 'GET';
    this.calls.push(`${method} ${url.pathname}${url.search}`);
    const page = Number(url.searchParams.get('page') ?? '1');
    const perPage = Number(url.searchParams.get('per_page') ?? '30');
    const paged = <T>(items: T[]) => json(items.slice((page - 1) * perPage, page * perPage));
    const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
    let match: RegExpExecArray | null;
    if ((match = /^\/orgs\/([^/]+)\/repos$/.exec(url.pathname))) return paged(this.orgRepos);
    if ((match = /^\/repos\/([^/]+\/[^/]+)\/contents\/(.+)$/.exec(url.pathname))) {
      if (this.failingContents.has(match[1]!)) return json({ message: 'boom' }, 500);
      return this.callers.has(match[1]!) && match[2] === '.github/workflows/code-review.yml' ? json({ name: 'code-review.yml' }) : json({ message: 'Not Found' }, 404);
    }
    if ((match = /^\/repos\/([^/]+\/[^/]+)\/pulls$/.exec(url.pathname))) {
      if (this.failingPulls.has(match[1]!)) return json({ message: 'boom' }, 500);
      const pulls = [...(this.pulls.get(match[1]!) ?? [])].sort((a, b) => b.updated_at.localeCompare(a.updated_at));
      return paged(pulls);
    }
    if ((match = /^\/repos\/([^/]+\/[^/]+)\/issues\/(\d+)\/comments$/.exec(url.pathname))) {
      return paged(this.comments.get(`${match[1]}#${match[2]}`) ?? []);
    }
    if ((match = /^\/repos\/([^/]+\/[^/]+)\/issues$/.exec(url.pathname))) {
      if (method === 'POST') {
        const sent = JSON.parse(String(init?.body)) as { title: string; body: string; labels: string[] };
        const number = 1000 + this.issues.length;
        const issue = { number, title: sent.title, body: sent.body, labels: sent.labels, user: { login: this.login }, html_url: `https://github.com/${match[1]}/issues/${number}` };
        this.issues.push(issue);
        return json(issue, 201);
      }
      const label = url.searchParams.get('labels');
      return paged(this.issues.filter((i) => !label || i.labels.includes(label)));
    }
    if ((match = /^\/repos\/([^/]+\/[^/]+)\/issues\/(\d+)$/.exec(url.pathname)) && method === 'PATCH') {
      const issue = this.issues.find((i) => i.number === Number(match![2]));
      if (!issue) return json({ message: 'Not Found' }, 404);
      issue.body = (JSON.parse(String(init?.body)) as { body: string }).body;
      return json(issue);
    }
    return json({ message: `unexpected ${method} ${url.pathname}` }, 404);
  };
}

test('the month defaults to the one before now, in UTC, and runs from its first instant to the next month', () => {
  const october = monthWindow(undefined, new Date('2026-11-01T06:00:00Z'));
  assert.equal(october.name, '2026-10');
  assert.equal(october.start.toISOString(), '2026-10-01T00:00:00.000Z');
  assert.equal(october.end.toISOString(), '2026-11-01T00:00:00.000Z');
  assert.equal(monthWindow(undefined, new Date('2027-01-01T06:00:00Z')).name, '2026-12');
  assert.equal(monthWindow(' 2026-02 ', new Date('2026-11-01T00:00:00Z')).end.toISOString(), '2026-03-01T00:00:00.000Z');
});

test('the current month can be reported, but not a later one or a malformed one', () => {
  assert.equal(monthWindow('2026-10', new Date('2026-10-31T08:00:00Z')).name, '2026-10');
  assert.throws(() => monthWindow('2026-11', new Date('2026-10-31T08:00:00Z')), /hasn't started/);
  for (const bad of ['2026-13', '2026-1', '26-10', '2026-10; rm -rf /', '$(id)']) {
    assert.throws(() => monthWindow(bad, new Date('2026-10-31T08:00:00Z')), /YYYY-MM/, bad);
  }
});

test("the previous month of January is the previous year's December", () => {
  assert.equal(previousMonth('2027-01'), '2026-12');
  assert.equal(previousMonth('2026-10'), '2026-09');
});

test('a configured repository list is owner/name only, split on commas and spaces', () => {
  assert.deepEqual(parseRepositories(' NCodeGroup/b, NCodeGroup/a\nNCodeGroup/a '), ['NCodeGroup/a', 'NCodeGroup/b']);
  assert.deepEqual(parseRepositories(''), []);
  assert.deepEqual(parseRepositories(undefined), []);
  assert.throws(() => parseRepositories('NCodeGroup/a,../../etc'), /owner\/name/);
  assert.throws(() => parseRepositories('NCodeGroup/..'), /owner\/name/);
  assert.throws(() => parseRepositories('NCodeGroup/.'), /owner\/name/);
  assert.deepEqual(parseRepositories('NCodeGroup/.github NCodeGroup/a..b'), ['NCodeGroup/.github', 'NCodeGroup/a..b']);
});

test("discovery keeps the owner's public repositories that have the caller workflow, and notes one it can't check", async () => {
  const github = new FakeGitHub();
  github.orgRepos = [
    { full_name: 'NCodeGroup/b' },
    { full_name: 'NCodeGroup/a' },
    { full_name: 'NCodeGroup/no-review' },
    { full_name: 'NCodeGroup/fork', fork: true },
    { full_name: 'NCodeGroup/broken' },
  ];
  github.callers = new Set(['NCodeGroup/a', 'NCodeGroup/b', 'NCodeGroup/fork']);
  github.failingContents.add('NCodeGroup/broken');
  const notes: string[] = [];
  const logged: string[] = [];
  const found = await discoverRepositories(githubApi('t', github.fetch), 'NCodeGroup', notes, (l) => logged.push(l));
  assert.deepEqual(found, ['NCodeGroup/a', 'NCodeGroup/b']);
  assert.equal(notes.length, 1);
  assert.match(notes[0]!, /NCodeGroup\/broken/);
  assert.ok(!github.calls.some((c) => c.includes('NCodeGroup/fork/contents')));
});

test('discovery skips private repositories and notes when there are more repositories than it reads', async () => {
  const github = new FakeGitHub();
  github.orgRepos = [{ full_name: 'NCodeGroup/secret', private: true }, { full_name: 'NCodeGroup/a' }];
  for (let n = github.orgRepos.length; n < maxRepositoryPages * pageSize; n++) github.orgRepos.push({ full_name: `NCodeGroup/fork-${n}`, fork: true });
  github.orgRepos.push({ full_name: 'NCodeGroup/late' });
  github.callers = new Set(['NCodeGroup/a', 'NCodeGroup/secret', 'NCodeGroup/late']);
  const notes: string[] = [];
  const found = await discoverRepositories(githubApi('t', github.fetch), 'NCodeGroup', notes, () => {});
  assert.deepEqual(found, ['NCodeGroup/a']);
  assert.deepEqual(notes, [`Only the first ${maxRepositoryPages * pageSize} of NCodeGroup's repositories were checked.`]);
  assert.equal(github.calls.filter((c) => c.includes('/orgs/')).length, maxRepositoryPages);
});

test('only pull requests closed inside the month count, and the listing stops once updates predate it', async () => {
  const github = new FakeGitHub();
  const month = monthWindow('2026-10', new Date('2026-11-01T06:00:00Z'));
  const pulls = [
    { number: 1, closed_at: '2026-10-01T00:00:00Z', updated_at: '2026-10-01T00:00:00Z' },
    { number: 2, closed_at: '2026-10-31T23:59:59Z', updated_at: '2026-11-02T00:00:00Z' },
    { number: 3, closed_at: '2026-11-01T00:00:00Z', updated_at: '2026-11-01T00:00:00Z' },
    { number: 4, closed_at: '2026-09-30T23:59:59Z', updated_at: '2026-10-05T00:00:00Z' },
    { number: 5, closed_at: null, updated_at: '2026-10-10T00:00:00Z' },
  ];
  // A full page of older pull requests after them: the first page ends before the month, so the second isn't read.
  for (let n = 100; n < 300; n++) pulls.push({ number: n, closed_at: '2026-08-01T00:00:00Z', updated_at: `2026-08-${String(1 + (n % 28)).padStart(2, '0')}T00:00:00Z` });
  github.pulls.set('NCodeGroup/a', pulls);
  const closed = await listClosedPulls(githubApi('t', github.fetch), 'NCodeGroup/a', month, []);
  assert.deepEqual(closed.map((p) => p.number).sort((a, b) => a - b), [1, 2]);
  assert.equal(github.calls.filter((c) => c.includes('/pulls?')).length, 1);
});

function inMonthPulls(count: number) {
  return Array.from({ length: count }, (_, i) => {
    const at = new Date(Date.UTC(2026, 9, 2) + i * 60_000).toISOString();
    return { number: i + 1, closed_at: at, updated_at: at };
  });
}

test('the listing goes on to the next page while updates are still inside the month', async () => {
  const github = new FakeGitHub();
  github.pulls.set('NCodeGroup/a', inMonthPulls(150));
  const notes: string[] = [];
  const closed = await listClosedPulls(githubApi('t', github.fetch), 'NCodeGroup/a', monthWindow('2026-10', new Date('2026-11-01T06:00:00Z')), notes);
  assert.equal(closed.length, 150);
  assert.equal(github.calls.filter((c) => c.includes('/pulls?')).length, 2);
  assert.deepEqual(notes, []);
});

test('the listing stops at its page cap and says the rest are left out', async () => {
  const github = new FakeGitHub();
  github.pulls.set('NCodeGroup/a', inMonthPulls(maxPullPages * pageSize + 1));
  const notes: string[] = [];
  const closed = await listClosedPulls(githubApi('t', github.fetch), 'NCodeGroup/a', monthWindow('2026-10', new Date('2026-11-01T06:00:00Z')), notes);
  assert.equal(closed.length, maxPullPages * pageSize);
  assert.deepEqual(notes, [`NCodeGroup/a has more closed pull requests updated since 2026-10 began than the ${maxPullPages * pageSize} read; the rest are left out.`]);
});

test("a pull request's findings come from the newest outcomes marker, and its cost from every review marker, in the bot's comments only", async () => {
  const github = new FakeGitHub();
  const first = summary(sha('a'), 'anthropic', 1.5);
  github.comments.set('NCodeGroup/a#7', [
    bot(
      supersededComment(sha('b'), 'https://example.test/c', [
        review(sha('a'), 'anthropic', 1.5),
        outcomesMarker({ state: 'closed', head: sha('a'), findings: [finding('F1', 'ignored', ['correctness'])] }),
      ]),
    ),
    { body: `${first}\n${outcomesMarker({ state: 'merged', head: sha('a'), findings: [finding('F1', 'fixed', ['x'])] })}`, user: { login: 'mallory' } },
    bot(summary(sha('b'), 'bedrock', 2.25, [finding('F1', 'fixed', ['correctness']), finding('F2', 'dismissed', ['security', 'correctness'])])),
  ]);
  const record = await readPull(githubApi('t', github.fetch), 'NCodeGroup/a', 7);
  assert.deepEqual(record, {
    repository: 'NCodeGroup/a',
    number: 7,
    findings: [
      { reviewers: ['correctness'], outcome: 'fixed' },
      { reviewers: ['security', 'correctness'], outcome: 'dismissed' },
    ],
    reviews: [
      { provider: 'anthropic', costUsd: 1.5 },
      { provider: 'bedrock', costUsd: 2.25 },
    ],
    unknownCost: 0,
  });
});

test("a summary from before the review marker gives its cost from its visible line; a collapsed one's cost is unknown", async () => {
  const github = new FakeGitHub();
  github.comments.set('NCodeGroup/a#8', [
    bot('<!-- ncode-review:superseded -->\n<sub>Superseded by [the review at bbbbbbb](https://example.test).</sub>'),
    bot(
      [
        summaryMarker,
        headMarker(sha('b')),
        '**Verdict: 💬 Comment** — $99.00 on Claude API',
        '<sub>Trial: findings are posted as review threads and in the check run. $0.80 on Amazon Bedrock, 75s, at bbbbbbb. ([how to interact](https://example.test))</sub>',
      ].join('\n'),
    ),
  ]);
  const record = await readPull(githubApi('t', github.fetch), 'NCodeGroup/a', 8);
  assert.deepEqual(record?.reviews, [{ provider: 'bedrock', costUsd: 0.8 }]);
  assert.equal(record?.unknownCost, 1);
  assert.equal(record?.findings, undefined);
});

test('a pull request the bot never commented on is not a reviewed one, and a damaged marker is skipped', async () => {
  const github = new FakeGitHub();
  github.comments.set('NCodeGroup/a#9', [{ body: summary(sha('a'), 'anthropic', 5), user: { login: 'someone' } }]);
  const api = githubApi('t', github.fetch);
  assert.equal(await readPull(api, 'NCodeGroup/a', 9), undefined);
  github.comments.set('NCodeGroup/a#10', [
    bot(`${summaryMarker}\n<!-- ncode-review:review {"head":"x","provider":"openai","costUsd":3} -->\n<!-- ncode-review:outcomes {"findings":[{"outcome":"great","reviewers":[]},{"outcome":"ignored","reviewers":[1,"r"]}]} -->`),
  ]);
  const record = await readPull(api, 'NCodeGroup/a', 10);
  assert.deepEqual(record?.findings, [{ reviewers: ['r'], outcome: 'ignored' }]);
  assert.deepEqual(record?.reviews, []);
  assert.equal(record?.unknownCost, 1);
});

test("a pull request with more comments than are read can't be recorded", async () => {
  const github = new FakeGitHub();
  github.comments.set('NCodeGroup/a#11', Array.from({ length: maxCommentPages * commentPageSize }, () => bot(summary(sha('a'), 'anthropic', 1))));
  await assert.rejects(readPull(githubApi('t', github.fetch), 'NCodeGroup/a', 11), /more comments than are read/);
});

const pullA: PullRecord = {
  repository: 'NCodeGroup/a',
  number: 1,
  findings: [
    { reviewers: ['correctness'], outcome: 'fixed' },
    { reviewers: ['correctness', 'security'], outcome: 'dismissed' },
    { reviewers: ['security'], outcome: 'fixed' },
    { reviewers: [], outcome: 'acknowledged' },
  ],
  reviews: [
    { provider: 'anthropic', costUsd: 1.25 },
    { provider: 'bedrock', costUsd: 0.75 },
  ],
  unknownCost: 0,
};
const pullB: PullRecord = {
  repository: 'NCodeGroup/b',
  number: 2,
  findings: [
    { reviewers: ['tests'], outcome: 'ignored' },
    { reviewers: ['tests'], outcome: 'dismissed' },
  ],
  reviews: [{ provider: 'bedrock', costUsd: 1 }],
  unknownCost: 0,
};
// Reviewed, but its outcomes were never recorded: its cost counts in the total, not in cost per fixed finding.
const pullC: PullRecord = { repository: 'NCodeGroup/b', number: 3, reviews: [{ provider: 'anthropic', costUsd: 3 }], unknownCost: 1 };

test('aggregation counts outcomes per repository and per reviewer, with precision as fixed over fixed and dismissed', () => {
  const data = aggregate('2026-10', ['NCodeGroup/a', 'NCodeGroup/b'], [pullA, pullB, pullC]);
  assert.deepEqual(data.reviewers, {
    [unattributed]: { fixed: 0, dismissed: 0, acknowledged: 1, ignored: 0 },
    correctness: { fixed: 1, dismissed: 1, acknowledged: 0, ignored: 0 },
    security: { fixed: 1, dismissed: 1, acknowledged: 0, ignored: 0 },
    tests: { fixed: 0, dismissed: 1, acknowledged: 0, ignored: 1 },
  });
  assert.deepEqual(data.byRepository['NCodeGroup/a'], { fixed: 2, dismissed: 1, acknowledged: 1, ignored: 0, pulls: 1, withOutcomes: 1, costUsd: 2 });
  assert.deepEqual(data.byRepository['NCodeGroup/b'], { fixed: 0, dismissed: 1, acknowledged: 0, ignored: 1, pulls: 2, withOutcomes: 1, costUsd: 4 });
  const t = data.totals;
  assert.deepEqual([t.fixed, t.dismissed, t.acknowledged, t.ignored, t.pulls, t.withOutcomes, t.unknownCost], [2, 2, 1, 1, 3, 2, 1]);
  assert.equal(precision(t), 0.5);
  assert.equal(precision(data.reviewers['tests']!), 0);
  assert.equal(precision(data.reviewers[unattributed]!), undefined);
  assert.equal(findingsPerPull(t), 3);
  assert.deepEqual(t.cost, { anthropic: 4.25, bedrock: 1.75 });
  assert.equal(t.costUsd, 6);
  assert.equal(t.outcomeCostUsd, 3);
  assert.equal(costPerFixed(t), 1.5);
  assert.equal(costPerFixed(aggregate('2026-10', [], [pullB]).totals), undefined);
});

test("the issue body has the totals with the previous month's change, a table per reviewer and per repository, and the marker", () => {
  const before = aggregate('2026-09', ['NCodeGroup/a'], [{ ...pullA, findings: [{ reviewers: ['correctness'], outcome: 'dismissed' }, { reviewers: ['correctness'], outcome: 'fixed' }] }]);
  const data = aggregate('2026-10', ['NCodeGroup/a', 'NCodeGroup/b'], [pullA, pullB, pullC]);
  const body = reportBody(data, before, ['NCodeGroup/c#4 is left out: boom.']);
  assert.ok(body.startsWith(reportMarker(data)));
  assert.match(body, /^## Review report 2026-10$/m);
  assert.match(body, /^\| Pull requests reviewed \| 3 \| 1 \| \+2 \|$/m);
  assert.match(body, /^\| Findings per pull request \| 3\.0 \| 2\.0 \| \+1\.0 \|$/m);
  assert.match(body, /^\| Precision \| 50% \| 50% \| 0 pp \|$/m);
  assert.match(body, /^\| Cost \| \$6\.00 \| \$2\.00 \| \+\$4\.00 \|$/m);
  assert.match(body, /^\| Cost on Claude API \| \$4\.25 \| \$1\.25 \| \+\$3\.00 \|$/m);
  assert.match(body, /^\| Cost on Amazon Bedrock \| \$1\.75 \| \$0\.75 \| \+\$1\.00 \|$/m);
  assert.match(body, /^\| Cost per fixed finding \| \$1\.50 \| \$2\.00 \| -\$0\.50 \|$/m);
  assert.match(body, /^\| Acknowledged \| 1 \| 0 \| \+1 \|$/m);
  assert.match(body, /^\| correctness \| 2 \| 1 \| 1 \| 0 \| 0 \| 50% \| 0 pp \|$/m);
  assert.match(body, /^\| tests \| 2 \| 0 \| 1 \| 0 \| 1 \| 0% \| — \|$/m);
  assert.match(body, /^\| \(unattributed\) \| 1 \| 0 \| 0 \| 1 \| 0 \| — \| — \|$/m);
  assert.match(body, /^\| NCodeGroup\/b \| 2 \| 2 \| 2\.0 \| 0 \| 1 \| 0 \| 1 \| 0% \| — \| \$4\.00 \|$/m);
  assert.match(body, /1 review from before summaries recorded their cost is left out of it\./);
  assert.match(body, /^- NCodeGroup\/c#4 is left out: boom\.$/m);
  assert.deepEqual(parseReportMarker(body), data);
});

test('without a previous report the change column is empty, and names are escaped in the tables', () => {
  const data = aggregate('2026-10', ['NCodeGroup/a'], [{ ...pullA, findings: [{ reviewers: ['a|b<script>\n@team'], outcome: 'fixed' }] }]);
  const body = reportBody(data, undefined);
  assert.match(body, /^\| Precision \| 100% \| — \| — \|$/m);
  assert.match(body, /^\| a\\\|b&lt;script> @\u200bteam \| 1 \|/m);
  assert.ok(!body.includes('<script>'));
  assert.ok(!/### Notes/.test(body));
});

test('a report marker that is damaged or holds the wrong types is read as nothing or as zeros', () => {
  assert.equal(parseReportMarker('no marker'), undefined);
  assert.equal(parseReportMarker('<!-- ncode-review:report {not json} -->'), undefined);
  assert.equal(parseReportMarker('<!-- ncode-review:report {"version":2,"month":"2026-09","totals":{}} -->'), undefined);
  const read = parseReportMarker('<!-- ncode-review:report {"version":1,"month":"2026-09","totals":{"fixed":"9","dismissed":-1,"pulls":2.5,"costUsd":1e999,"cost":{"bedrock":2}},"reviewers":{"r":{"fixed":3}}} -->');
  assert.equal(read?.totals.fixed, 0);
  assert.equal(read?.totals.dismissed, 0);
  assert.equal(read?.totals.pulls, 0);
  assert.equal(read?.totals.costUsd, 0);
  assert.deepEqual(read?.totals.cost, { anthropic: 0, bedrock: 2 });
  assert.deepEqual(read?.reviewers, { r: { fixed: 3, dismissed: 0, acknowledged: 0, ignored: 0 } });
  assert.deepEqual(read?.byRepository, {});
});

function octoberGitHub(): FakeGitHub {
  const github = new FakeGitHub();
  github.orgRepos = [{ full_name: 'NCodeGroup/a' }, { full_name: 'NCodeGroup/code-review' }];
  github.callers = new Set(['NCodeGroup/a']);
  github.pulls.set('NCodeGroup/a', [
    { number: 1, closed_at: '2026-10-03T10:00:00Z', updated_at: '2026-10-03T10:00:00Z' },
    { number: 2, closed_at: '2026-10-20T10:00:00Z', updated_at: '2026-10-20T10:00:00Z' },
    { number: 3, closed_at: '2026-09-20T10:00:00Z', updated_at: '2026-09-20T10:00:00Z' },
  ]);
  github.comments.set('NCodeGroup/a#1', [bot(summary(sha('a'), 'anthropic', 1.25, [finding('F1', 'fixed', ['correctness']), finding('F2', 'ignored', ['tests'])]))]);
  github.comments.set('NCodeGroup/a#2', [bot(summary(sha('c'), 'bedrock', 0.75, [finding('F1', 'dismissed', ['correctness'])]))]);
  github.comments.set('NCodeGroup/a#3', [bot(summary(sha('d'), 'bedrock', 9, [finding('F1', 'fixed', ['correctness'])]))]);
  return github;
}

const reportOptions = (github: FakeGitHub) => ({
  fetch: github.fetch,
  token: 'ghs_secret_token_value',
  repository: 'NCodeGroup/code-review',
  now: new Date('2026-11-01T06:00:00Z'),
  log: () => {},
});

test('a run opens one labelled issue for the month, and a re-run updates it instead of adding another', async () => {
  const github = octoberGitHub();
  const first = await runReport(reportOptions(github));
  assert.equal(first.issue?.action, 'created');
  assert.equal(github.issues.length, 1);
  const issue = github.issues[0]!;
  assert.equal(issue.title, 'Review report 2026-10');
  assert.deepEqual(issue.labels, ['review-report']);
  const data = parseReportMarker(issue.body)!;
  assert.deepEqual([data.totals.pulls, data.totals.fixed, data.totals.dismissed, data.totals.ignored, data.totals.costUsd], [2, 1, 1, 1, 2]);
  assert.deepEqual(data.totals.cost, { anthropic: 1.25, bedrock: 0.75 });
  assert.equal(data.repositories, 1);

  const again = await runReport(reportOptions(github));
  assert.equal(again.issue?.action, 'unchanged');
  assert.equal(again.body, issue.body);
  assert.equal(github.issues.length, 1);
  assert.ok(!github.calls.some((c) => c.startsWith('PATCH')));

  // A pull request's outcomes change between runs: the same issue is rewritten.
  github.comments.set('NCodeGroup/a#2', [bot(summary(sha('c'), 'bedrock', 0.75, [finding('F1', 'fixed', ['correctness'])]))]);
  const third = await runReport(reportOptions(github));
  assert.equal(third.issue?.action, 'updated');
  assert.equal(third.issue?.number, issue.number);
  assert.equal(github.issues.length, 1);
  assert.equal(parseReportMarker(github.issues[0]!.body)?.totals.fixed, 2);
});

test("the change comes from the previous month's report by the workflow, never from an issue someone else opened", async () => {
  const github = octoberGitHub();
  const september = aggregate('2026-09', ['NCodeGroup/a'], [{ repository: 'NCodeGroup/a', number: 3, findings: [{ reviewers: ['correctness'], outcome: 'fixed' }], reviews: [{ provider: 'bedrock', costUsd: 9 }], unknownCost: 0 }]);
  const forged = { ...september, totals: { ...september.totals, pulls: 500 } };
  github.issues.push(
    { number: 5, title: 'Review report 2026-09', body: reportBody(forged, undefined), labels: ['review-report'], user: { login: 'mallory' }, html_url: 'https://example.test/5' },
    { number: 6, title: 'Review report 2026-09', body: reportBody(september, undefined), labels: ['review-report'], user: { login: 'github-actions[bot]' }, html_url: 'https://example.test/6' },
    { number: 7, title: 'Review report 2026-10', body: 'squatted', labels: ['review-report'], user: { login: 'mallory' }, html_url: 'https://example.test/7' },
  );
  const result = await runReport(reportOptions(github));
  assert.equal(result.issue?.action, 'created');
  assert.match(result.body, /^\| Pull requests reviewed \| 2 \| 1 \| \+1 \|$/m);
  assert.match(result.body, /^\| Cost \| \$2\.00 \| \$9\.00 \| -\$7\.00 \|$/m);
  assert.equal(github.issues.find((i) => i.number === 7)?.body, 'squatted');
});

test("when the workflow opened two issues for the month, the older one is the one updated", async () => {
  const github = octoberGitHub();
  github.issues.push(
    { number: 8, title: 'Review report 2026-10', body: 'older', labels: ['review-report'], user: { login: 'github-actions[bot]' }, html_url: 'https://example.test/8' },
    { number: 9, title: 'Review report 2026-10', body: 'newer', labels: ['review-report'], user: { login: 'github-actions[bot]' }, html_url: 'https://example.test/9' },
  );
  const result = await runReport(reportOptions(github));
  assert.equal(result.issue?.action, 'updated');
  assert.equal(result.issue?.number, 8);
  assert.equal(github.issues.find((i) => i.number === 8)?.body, result.body);
  assert.equal(github.issues.find((i) => i.number === 9)?.body, 'newer');
});

test('a configured repository list replaces the scan, and a dry run publishes nothing', async () => {
  const github = octoberGitHub();
  const result = await runReport({ ...reportOptions(github), repositories: ['NCodeGroup/a'], dryRun: true });
  assert.equal(result.issue, undefined);
  assert.match(result.body, /^## Review report 2026-10$/m);
  assert.equal(github.issues.length, 0);
  assert.ok(!github.calls.some((c) => c.includes('/orgs/') || c.includes('/contents/')));
});

test("a pull request whose comments can't be read is left out and named in the notes", async () => {
  const github = octoberGitHub();
  const original = github.fetch;
  github.fetch = async (input, init) => (String(input).includes('/issues/2/comments') ? new Response('{}', { status: 502 }) : original(input, init));
  const result = await runReport({ ...reportOptions(github), dryRun: true });
  assert.match(result.body, /^- NCodeGroup\/a#2 is left out: couldn't read its comments \(GitHub refused GET .*HTTP 502\)\.$/m);
  assert.equal(parseReportMarker(result.body)?.totals.pulls, 1);
});

test("a repository whose closed pull requests can't be listed is left out and named in the notes, and the others still count", async () => {
  const github = octoberGitHub();
  github.failingPulls.add('NCodeGroup/down');
  const logged: string[] = [];
  const result = await runReport({ ...reportOptions(github), repositories: ['NCodeGroup/a', 'NCodeGroup/down'], dryRun: true, log: (l: string) => logged.push(l) });
  assert.match(result.body, /^- Couldn't list NCodeGroup\/down's closed pull requests \(GitHub refused GET .*HTTP 500\); it's left out\.$/m);
  assert.ok(logged.some((l) => l.startsWith("::warning::Couldn't list NCodeGroup/down's")));
  const data = parseReportMarker(result.body)!;
  assert.equal(data.totals.pulls, 2);
  assert.deepEqual(Object.keys(data.byRepository), ['NCodeGroup/a']);
});

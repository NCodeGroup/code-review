import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import {
  classify,
  collectOutcomes,
  isClosedEvent,
  isDeclining,
  lineChanged,
  maxComparedFiles,
  maxMarkerLength,
  maxOutcomeRows,
  maxThreadPages,
  outcomesMarker,
  outcomesSection,
  parseFindingComment,
  parseOutcomesMarker,
  patchTouches,
  publishOutcomes,
  readOutcomes,
  readReviewThreads,
  recordOutcomes,
  threadPageSize,
  withOutcomes,
  type Evidence,
  type FindingOutcome,
  type OutcomesReport,
} from '../src/outcomes.ts';
import { headMarker, newestReviewedHead, reviewMarker, reviewRecords, summaryComment, summaryMarker, supersededComment, type Results } from '../src/results.ts';
import type { ReviewedFinding } from '../src/review.ts';
import { threadBody } from '../src/threads.ts';
import { maxReplyAuthorLookups } from '../src/writers.ts';

const none: Evidence = { linesChanged: false, isResolved: false, isOutdated: false, reactions: [], replies: [] };

test('a finding whose lines changed afterwards is fixed, whatever else its thread shows', () => {
  assert.equal(classify({ ...none, linesChanged: true }), 'fixed');
  assert.equal(classify({ ...none, linesChanged: true, reactions: [{ content: 'THUMBS_DOWN', writer: true }] }), 'fixed');
  assert.equal(classify({ ...none, linesChanged: true, isResolved: true }), 'fixed');
});

test('an outdated and resolved thread is fixed; outdated alone is not', () => {
  assert.equal(classify({ ...none, isOutdated: true, isResolved: true }), 'fixed');
  assert.equal(classify({ ...none, isOutdated: true }), 'ignored');
});

test("a writer's thumbs-down dismisses a finding; anyone else's doesn't", () => {
  assert.equal(classify({ ...none, reactions: [{ content: 'THUMBS_DOWN', writer: true }] }), 'dismissed');
  assert.equal(classify({ ...none, reactions: [{ content: 'THUMBS_DOWN', writer: false }] }), 'ignored');
});

test('a thread resolved without a change is dismissed', () => {
  assert.equal(classify({ ...none, isResolved: true }), 'dismissed');
  assert.equal(classify({ ...none, isResolved: true, reactions: [{ content: 'THUMBS_UP', writer: true }] }), 'dismissed');
});

test("a writer's declining reply dismisses a finding; a non-writer's counts for nothing", () => {
  assert.equal(classify({ ...none, replies: [{ body: "Won't fix: this path is internal.", writer: true }] }), 'dismissed');
  assert.equal(classify({ ...none, replies: [{ body: "Won't fix: this path is internal.", writer: false }] }), 'ignored');
});

test("a writer's thumbs-up or other reply acknowledges a finding; a non-writer's doesn't", () => {
  assert.equal(classify({ ...none, reactions: [{ content: 'THUMBS_UP', writer: true }] }), 'acknowledged');
  assert.equal(classify({ ...none, reactions: [{ content: 'THUMBS_UP', writer: false }] }), 'ignored');
  assert.equal(classify({ ...none, replies: [{ body: 'Good catch, I will follow up in another PR.', writer: true }] }), 'acknowledged');
  assert.equal(classify({ ...none, replies: [{ body: 'Good catch.', writer: false }] }), 'ignored');
});

test('a finding nobody touched is ignored', () => {
  assert.equal(classify(none), 'ignored');
});

test('an autopilot "fixed in" reply counts only when the lines changed', () => {
  const autopilot = [{ body: 'Autopilot: fixed in 1a2b3c4.', writer: true }];
  assert.equal(classify({ ...none, replies: autopilot }), 'ignored');
  assert.equal(classify({ ...none, replies: autopilot, linesChanged: true }), 'fixed');
});

test('isDeclining reads common ways to decline and leaves agreement alone', () => {
  for (const reply of [
    "Won't fix",
    'wontfix',
    'This is a false positive.',
    'Not a bug: the caller checks it.',
    'This is by design.',
    'I disagree.',
    'No, the lock is held here.',
    'No.',
    'Not needed.',
    'Dismissing: not applicable here.',
    'Ignoring this one.',
    "We'll ignore it for now.",
    'Autopilot: declined: the caller already checks it.',
  ]) {
    assert.ok(isDeclining(reply), reply);
  }
  for (const reply of [
    'Good catch, thanks!',
    'Will fix in a follow-up.',
    'Agreed.',
    'Noted, tracking in #12.',
    'No worries, fixing it.',
    'No problem, done.',
    "Don't ignore this, good catch.",
    'Good catch, the cast is unnecessary; removing it.',
    'Nothing to add, fixed.',
  ]) {
    assert.ok(!isDeclining(reply), reply);
  }
});

test('patchTouches finds an edited or removed line, and code added right next to it', () => {
  const edit = '@@ -8,5 +8,5 @@\n a\n b\n-old\n+new\n c\n d';
  assert.ok(patchTouches(edit, 10));
  assert.ok(!patchTouches(edit, 11), 'a replaced line leaves the next one alone');
  assert.ok(!patchTouches(edit, 8));
  assert.ok(!patchTouches(edit, 12));
  const insert = '@@ -3,4 +3,5 @@\n a\n b\n+guard\n c\n d';
  assert.ok(patchTouches(insert, 4), 'added right after the line');
  assert.ok(patchTouches(insert, 5), 'added right before the line');
  assert.ok(!patchTouches(insert, 3));
  assert.ok(!patchTouches(insert, 6));
  // A hunk that removes nothing names the line it adds after.
  assert.ok(patchTouches('@@ -7,0 +8,2 @@\n+x\n+y', 7));
  assert.ok(!patchTouches('@@ -7,0 +8,2 @@\n+x\n+y', 9));
  assert.ok(!patchTouches('@@ -1,2 +1,2 @@\n-a\n+b\n c\n@@ -40,3 +40,3 @@\n x\n-y\n+z\n w', 20));
});

test('lineChanged follows a rename, counts a removed file and an unlisted one, and can\'t tell without a patch or past the file limit', () => {
  const patch = '@@ -1,3 +1,3 @@\n a\n-b\n+c\n d';
  assert.equal(lineChanged([{ filename: 'new.cs', previous_filename: 'old.cs', status: 'renamed', patch }], 'old.cs', 2), true);
  assert.equal(lineChanged([{ filename: 'gone.cs', status: 'removed' }], 'gone.cs', 9), true);
  assert.equal(lineChanged([{ filename: 'other.cs', status: 'modified', patch }], 'a.cs', 2), false);
  assert.equal(lineChanged([{ filename: 'big.cs', status: 'modified' }], 'big.cs', 2), undefined);
  const capped = Array.from({ length: maxComparedFiles }, (_, i) => ({ filename: `f${i}.cs`, status: 'modified', patch }));
  assert.equal(lineChanged(capped, 'a.cs', 2), undefined);
  assert.equal(lineChanged(capped.slice(1), 'a.cs', 2), false);
});

function reviewed(overrides: Partial<ReviewedFinding>): ReviewedFinding {
  return { id: 'F1', file: 'src/A.cs', line: 10, severity: 'blocker', title: 't', problem: 'p', consequence: 'c', fix: 'f', evidence: 'e', confidence: 0.9, reviewers: ['security'], ...overrides };
}

test('parseFindingComment reads the marker, and the visible reviewers of a comment posted before the marker named them', () => {
  assert.deepEqual(parseFindingComment(threadBody(reviewed({ id: 'F3', severity: 'nit', reviewers: ['security', 'tests'] }))), {
    id: 'F3',
    severity: 'nit',
    reviewers: ['security', 'tests'],
  });
  const older = '🔴 **Blocker: t** <sub>F2 · correctness, tests</sub>\n\np\n\n<!-- ncode-review:finding id=F2 fp=0123456789abcdef severity=blocker -->';
  assert.deepEqual(parseFindingComment(older), { id: 'F2', severity: 'blocker', reviewers: ['correctness', 'tests'] });
  assert.equal(parseFindingComment('Just a comment.'), undefined);
});

test('parseFindingComment falls back to the visible reviewers when the marker names them as blank', () => {
  const damaged = '🔴 **Blocker: t** <sub>F2 · correctness</sub>\n\np\n\n<!-- ncode-review:finding id=F2 fp=0123456789abcdef severity=blocker reviewer=, -->';
  assert.deepEqual(parseFindingComment(damaged), { id: 'F2', severity: 'blocker', reviewers: ['correctness'] });
});

const findings: FindingOutcome[] = [
  { id: 'F1', reviewedAt: 'a'.repeat(40), reviewers: ['security'], severity: 'blocker', outcome: 'fixed', costUsd: 0.69, provider: 'bedrock', model: 'sonnet' },
  { id: 'F2', reviewedAt: 'a'.repeat(40), reviewers: ['tests'], severity: 'should-fix', outcome: 'dismissed' },
];

test('the outcomes marker holds each finding and the state, and round-trips', () => {
  const marker = outcomesMarker({ state: 'merged', head: 'b'.repeat(40), findings });
  assert.match(marker, /^<!-- ncode-review:outcomes \{.*\} -->$/);
  assert.deepEqual(parseOutcomesMarker(marker), { version: 1, state: 'merged', head: 'b'.repeat(40), findings });
});

test('the outcomes marker escapes text that would end the HTML comment', () => {
  const tricky = [{ ...findings[0]!, reviewers: ['a --> b <c>'] }];
  const marker = outcomesMarker({ state: 'closed', head: 'b'.repeat(40), findings: tricky });
  assert.equal(marker.indexOf('-->'), marker.length - 3);
  assert.deepEqual(parseOutcomesMarker(marker)?.findings[0]?.reviewers, ['a --> b <c>']);
});

test('the outcomes section shows the state and a row per finding', () => {
  const section = outcomesSection({ state: 'closed', head: 'b'.repeat(40), findings });
  assert.match(section, /Closed without merging at bbbbbbb: 1 fixed, 1 dismissed, 0 acknowledged, 0 ignored\./);
  assert.match(section, /\| F1 \| security \| 🔴 Blocker \| ✅ fixed \|/);
  assert.match(section, /\| F2 \| tests \| 🟠 Should fix \| 👎 dismissed \|/);
  assert.match(outcomesSection({ state: 'merged', head: 'b'.repeat(40), findings: [] }), /Merged at bbbbbbb\. No findings were posted as threads\./);
  const odd = outcomesSection({ state: 'merged', head: 'b'.repeat(40), findings: [{ ...findings[0]!, reviewers: ['a\\|b <i>'] }] });
  assert.ok(odd.includes('| a\\\\\\|b &lt;i> |'), odd);
});

test('the outcomes section names the commit of findings from several reviews', () => {
  const later = { ...findings[0]!, reviewedAt: 'c'.repeat(40) };
  const section = outcomesSection({ state: 'merged', head: 'b'.repeat(40), findings: [findings[0]!, later] });
  assert.match(section, /\| F1 at aaaaaaa \|/);
  assert.match(section, /\| F1 at ccccccc \|/);
});

test('the outcomes section shows at most maxOutcomeRows rows, and the marker holds every finding', () => {
  const many = Array.from({ length: maxOutcomeRows + 1 }, (_, i) => ({ ...findings[0]!, id: `F${i + 1}` }));
  const section = outcomesSection({ state: 'merged', head: 'b'.repeat(40), findings: many });
  assert.equal(section.match(/^\| F\d+ \|/gm)?.length, maxOutcomeRows);
  assert.match(section, /\*And 1 more\.\*$/);
  assert.equal(parseOutcomesMarker(section)?.findings.length, maxOutcomeRows + 1);
  assert.equal(parseOutcomesMarker(section)?.omitted, undefined);
});

test('the outcomes marker holds the first findings that fit and counts the rest, so the section fits in a comment', () => {
  const many: FindingOutcome[] = Array.from({ length: 1000 }, (_, i) => ({
    ...findings[0]!,
    id: `F${i + 1}`,
    reviewers: ['architecture', 'completeness', 'conventions', 'correctness', 'data-model', 'hygiene', 'rule-check'],
    model: 'us.anthropic.claude-sonnet-model-id',
  }));
  const marker = outcomesMarker({ state: 'merged', head: 'b'.repeat(40), findings: many });
  assert.ok(marker.length <= maxMarkerLength + 40, `${marker.length}`);
  const parsed = parseOutcomesMarker(marker)!;
  assert.ok(parsed.findings.length > 0 && parsed.findings.length < many.length);
  assert.deepEqual(parsed.findings, many.slice(0, parsed.findings.length));
  assert.equal(parsed.omitted, many.length - parsed.findings.length);
  const section = outcomesSection({ state: 'merged', head: 'b'.repeat(40), findings: many });
  assert.ok(section.length < 65_536 - 1_000, `${section.length}`);
});

test('withOutcomes appends the section and replaces an earlier one', () => {
  const summary = `${summaryMarker}\n${headMarker('a'.repeat(40))}\n### 🤖 Review complete\n\nbody`;
  const first = withOutcomes(summary, outcomesSection({ state: 'closed', head: 'b'.repeat(40), findings }));
  const again = withOutcomes(first, outcomesSection({ state: 'merged', head: 'c'.repeat(40), findings }));
  assert.ok(again.startsWith(`${summary}\n\n<!-- ncode-review:outcomes `));
  assert.equal(again.match(/ncode-review:outcomes/g)?.length, 1);
  assert.equal(parseOutcomesMarker(again)?.state, 'merged');
});

const reviewResults = {
  headSha: 'a'.repeat(40),
  provider: 'bedrock',
  costUsd: 0.69123,
  synthesisModel: 'global.anthropic.claude-opus-5-5',
  reviewers: [
    { name: 'security', status: 'ran', model: 'global.anthropic.claude-sonnet-5-5', findingCount: 1 },
    { name: 'tests', status: 'ran', model: 'global.anthropic.claude-haiku-5-5', findingCount: 1 },
    { name: 'performance', status: 'skipped', model: '', findingCount: 0 },
  ],
} as const;

test("the summary comment records the review's cost, provider and models, and a superseded one keeps them", () => {
  const marker = reviewMarker(reviewResults as unknown as Results);
  assert.deepEqual(reviewRecords(marker), [
    {
      head: 'a'.repeat(40),
      provider: 'bedrock',
      costUsd: 0.6912,
      synthesisModel: 'global.anthropic.claude-opus-5-5',
      models: { security: 'global.anthropic.claude-sonnet-5-5', tests: 'global.anthropic.claude-haiku-5-5' },
    },
  ]);
  const summary = summaryComment(
    { ...reviewResults, summary: 's', verdict: 'comment', findings: [], dropped: [], skipped: [], durationMs: 1000 } as unknown as Results,
    'https://check',
    'https://help',
  );
  assert.ok(summary.includes(marker));
  assert.deepEqual(reviewRecords(supersededComment('b'.repeat(40), 'https://example.test/c/1', [marker])), reviewRecords(marker));
});

test('postSummary keeps the review and outcomes markers of the summary it collapses', async () => {
  const { postSummary } = await import('../src/comments.ts');
  const marker = reviewMarker(reviewResults as unknown as Results);
  const outcomes = outcomesMarker({ state: 'closed', head: 'a'.repeat(40), findings });
  const bodies: unknown[] = [];
  const api = async (method: string, _url: string, body?: unknown): Promise<any> => {
    if (method === 'GET') return [{ id: 1, user: { login: 'ncode-review[bot]' }, body: `${summaryMarker}\n${headMarker('a'.repeat(40))}\n${marker}\nold\n\n${outcomes}\n### 📋 Outcomes` }];
    bodies.push(body);
    return method === 'POST' ? { html_url: 'https://example.test/c/2' } : undefined;
  };
  await postSummary(api, { repository: 'o/r', pullRequest: 1, headSha: 'b'.repeat(40) }, 'new body', () => {});
  assert.deepEqual(bodies[1], { body: supersededComment('b'.repeat(40), 'https://example.test/c/2', [marker, outcomes]) });
  assert.deepEqual(parseOutcomesMarker((bodies[1] as { body: string }).body)?.findings, findings);
});

const reviewedAt = 'a'.repeat(40);
const closedHead = 'b'.repeat(40);

function botThread(finding: ReviewedFinding, extra: { reactions?: { content: string; login: string }[]; replies?: { login: string; association: string; body: string }[]; isResolved?: boolean; isOutdated?: boolean } = {}) {
  return {
    isResolved: extra.isResolved ?? false,
    isOutdated: extra.isOutdated ?? false,
    path: finding.file,
    comments: {
      nodes: [
        {
          author: { login: 'ncode-review' },
          authorAssociation: 'NONE',
          body: threadBody(finding),
          originalLine: finding.line,
          originalCommit: { oid: reviewedAt },
          reactions: { nodes: (extra.reactions ?? []).map((r) => ({ content: r.content, user: { login: r.login } })) },
        },
        ...(extra.replies ?? []).map((r) => ({
          author: { login: r.login },
          authorAssociation: r.association,
          body: r.body,
          originalLine: finding.line,
          originalCommit: { oid: reviewedAt },
          reactions: { nodes: [] },
        })),
      ],
    },
  };
}

// A pull request with one finding whose line was fixed, one a writer gave a thumbs-down, one only a non-writer reacted to
// and replied on, and a thread a person started.
function fakeGitHub(options: { summary?: boolean; threads?: boolean } = {}) {
  const calls: string[] = [];
  const threads = options.threads === false
    ? []
    : [
        botThread(reviewed({ id: 'F1', file: 'src/A.cs', line: 10, severity: 'blocker', reviewers: ['security'] })),
        botThread(reviewed({ id: 'F2', file: 'src/B.cs', line: 20, severity: 'should-fix', reviewers: ['tests'] }), { reactions: [{ content: 'THUMBS_DOWN', login: 'maintainer' }] }),
        botThread(reviewed({ id: 'F3', file: 'src/C.cs', line: 5, severity: 'nit', reviewers: ['style'] }), {
          reactions: [{ content: 'THUMBS_DOWN', login: 'drive-by' }],
          replies: [{ login: 'drive-by', association: 'CONTRIBUTOR', body: "Won't fix this." }],
        }),
        { isResolved: false, isOutdated: false, path: 'src/D.cs', comments: { nodes: [{ author: { login: 'someone' }, authorAssociation: 'MEMBER', body: 'A question.', originalLine: 1, originalCommit: { oid: reviewedAt }, reactions: { nodes: [] } }] } },
      ];
  const summaryBody = `${summaryMarker}\n${headMarker(reviewedAt)}\n${reviewMarker(reviewResults as unknown as Results)}\n### 🤖 Review complete`;
  const api = async (method: string, url: string, body?: any): Promise<any> => {
    calls.push(`${method} ${url}`);
    if (url === '/graphql') {
      const page = body.variables.cursor === null ? threads.slice(0, 2) : threads.slice(2);
      const hasNextPage = body.variables.cursor === null && threads.length > 2;
      return { data: { repository: { pullRequest: { reviewThreads: { pageInfo: { hasNextPage, endCursor: hasNextPage ? 'c1' : null }, nodes: page } } } } };
    }
    if (url.startsWith('/repos/o/r/issues/5/comments')) {
      return options.summary === false ? [] : [{ id: 42, user: { login: 'ncode-review[bot]' }, body: summaryBody }];
    }
    if (url === `/repos/o/r/compare/${reviewedAt}...${closedHead}`) {
      return { files: [{ filename: 'src/A.cs', status: 'modified', patch: '@@ -9,3 +9,3 @@\n a\n-bug\n+fix\n b' }, { filename: 'src/B.cs', status: 'modified', patch: '@@ -40,1 +40,1 @@\n-x\n+y' }] };
    }
    if (url === '/repos/o/r/collaborators/maintainer/permission') return { permission: 'write' };
    if (url === '/repos/o/r/collaborators/drive-by/permission') return { permission: 'read' };
    throw new Error(`Unexpected ${method} ${url}`);
  };
  return { api, calls, summaryBody };
}

test('collectOutcomes records fixed, dismissed and ignored findings with their review, by GitHub calls alone', async () => {
  const { api, calls, summaryBody } = fakeGitHub();
  const report = await collectOutcomes(api, 'o/r', { number: 5, merged: true, head: { sha: closedHead } }, () => {});
  assert.deepEqual(report, {
    repository: 'o/r',
    pullRequest: 5,
    state: 'merged',
    head: closedHead,
    findings: [
      { id: 'F1', reviewedAt, reviewers: ['security'], severity: 'blocker', outcome: 'fixed', costUsd: 0.6912, provider: 'bedrock', model: 'global.anthropic.claude-sonnet-5-5' },
      { id: 'F2', reviewedAt, reviewers: ['tests'], severity: 'should-fix', outcome: 'dismissed', costUsd: 0.6912, provider: 'bedrock', model: 'global.anthropic.claude-haiku-5-5' },
      { id: 'F3', reviewedAt, reviewers: ['style'], severity: 'nit', outcome: 'ignored', costUsd: 0.6912, provider: 'bedrock', model: 'global.anthropic.claude-opus-5-5' },
    ],
    summaryCommentId: 42,
    summaryBody,
  });
  // Only GitHub's API, and only reads: no model call.
  assert.ok(calls.every((call) => / \/(graphql|repos\/o\/r\/)/.test(call)), calls.join('\n'));
  assert.ok(calls.every((call) => call.startsWith('GET ') || call === 'POST /graphql'));
  assert.equal(calls.filter((call) => call.includes('/compare/')).length, 1);
});

test('collectOutcomes records a pull request closed without merging as closed', async () => {
  const { api } = fakeGitHub();
  const report = await collectOutcomes(api, 'o/r', { number: 5, merged: false, head: { sha: closedHead } }, () => {});
  assert.equal(report?.state, 'closed');
});

test('collectOutcomes counts every finding as unchanged when the comparison fails', async () => {
  const { api: base } = fakeGitHub();
  const api = async (method: string, url: string, body?: unknown) => {
    if (url.includes('/compare/')) throw new Error('HTTP 404');
    return base(method, url, body);
  };
  const lines: string[] = [];
  const report = await collectOutcomes(api, 'o/r', { number: 5, merged: true, head: { sha: closedHead } }, (line) => lines.push(line));
  assert.equal(report?.findings[0]?.outcome, 'ignored');
  assert.ok(lines.some((line) => line.startsWith("::warning::Couldn't compare aaaaaaa with bbbbbbb")));
});

test('collectOutcomes lets an outdated thread decide, and warns, when the comparison has no patch for its file', async () => {
  const { api: base } = fakeGitHub();
  const api = async (method: string, url: string, body?: unknown) => {
    if (url.includes('/compare/')) return { files: [{ filename: 'src/A.cs', status: 'modified' }, { filename: 'src/B.cs', status: 'modified' }] };
    const answer = await base(method, url, body);
    if (url === '/graphql') for (const thread of answer.data.repository.pullRequest.reviewThreads.nodes) thread.isOutdated = thread.path === 'src/A.cs';
    return answer;
  };
  const lines: string[] = [];
  const report = await collectOutcomes(api, 'o/r', { number: 5, merged: true, head: { sha: closedHead } }, (line) => lines.push(line));
  assert.deepEqual(report?.findings.map((f) => f.outcome), ['fixed', 'dismissed', 'ignored']);
  assert.deepEqual(lines.filter((line) => line.includes("doesn't show whether")).map((line) => / (F\d)'s /.exec(line)?.[1]), ['F1', 'F2']);
});

test("collectOutcomes makes the thread's path printable in the comparison warning", async () => {
  const { api: base } = fakeGitHub();
  const unsafe = 'src/A\r\n::error::x.cs';
  const api = async (method: string, url: string, body?: unknown) => {
    if (url.includes('/compare/')) return { files: [{ filename: unsafe, status: 'modified' }] };
    const answer = await base(method, url, body);
    if (url === '/graphql') for (const thread of answer.data.repository.pullRequest.reviewThreads.nodes) if (thread.path === 'src/A.cs') thread.path = unsafe;
    return answer;
  };
  const lines: string[] = [];
  await collectOutcomes(api, 'o/r', { number: 5, merged: true, head: { sha: closedHead } }, (line) => lines.push(line));
  assert.deepEqual(lines.filter((line) => line.includes("doesn't show whether")), [
    "::warning::Comparing aaaaaaa with bbbbbbb doesn't show whether F1's line in src/A::error::x.cs changed; its thread being outdated decides.",
  ]);
});

test('collectOutcomes records nothing on a pull request the bot never reviewed', async () => {
  const { api } = fakeGitHub({ summary: false, threads: false });
  assert.equal(await collectOutcomes(api, 'o/r', { number: 5, merged: true, head: { sha: closedHead } }, () => {}), undefined);
});

test('collectOutcomes still records the threads when there is no summary comment', async () => {
  const { api } = fakeGitHub({ summary: false });
  const report = await collectOutcomes(api, 'o/r', { number: 5, merged: true, head: { sha: closedHead } }, () => {});
  assert.equal(report?.summaryCommentId, undefined);
  assert.deepEqual(report?.findings.map((f) => [f.id, f.outcome, f.costUsd]), [['F1', 'fixed', undefined], ['F2', 'dismissed', undefined], ['F3', 'ignored', undefined]]);
});

test("collectOutcomes counts a reactor whose permission can't be read as a non-writer, and warns", async () => {
  const { api: base } = fakeGitHub();
  const api = async (method: string, url: string, body?: unknown) => {
    if (url.endsWith('/collaborators/maintainer/permission')) throw new Error('HTTP 404');
    return base(method, url, body);
  };
  const lines: string[] = [];
  const report = await collectOutcomes(api, 'o/r', { number: 5, merged: true, head: { sha: closedHead } }, (line) => lines.push(line));
  assert.equal(report?.findings.find((f) => f.id === 'F2')?.outcome, 'ignored');
  assert.ok(lines.some((line) => /^::warning::Couldn't read maintainer's permission \(.*HTTP 404/.test(line)), lines.join('\n'));
});

test("collectOutcomes leaves out the bot's own reactions and replies", async () => {
  const { api: base, calls } = fakeGitHub();
  const thread = botThread(reviewed({ id: 'F9', file: 'src/Z.cs', line: 99, severity: 'nit' }), {
    reactions: [{ content: 'THUMBS_UP', login: 'ncode-review[bot]' }, { content: 'THUMBS_DOWN', login: 'ncode-review' }],
    replies: [{ login: 'ncode-review', association: 'MEMBER', body: "Won't fix this." }, { login: 'ncode-review[bot]', association: 'MEMBER', body: 'Thanks.' }],
  });
  const api = async (method: string, url: string, body?: unknown) => {
    if (url === '/graphql') return { data: { repository: { pullRequest: { reviewThreads: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [thread] } } } } };
    return base(method, url, body);
  };
  const report = await collectOutcomes(api, 'o/r', { number: 5, merged: true, head: { sha: closedHead } }, () => {});
  assert.deepEqual(report?.findings.map((f) => [f.id, f.outcome]), [['F9', 'ignored']]);
  assert.ok(!calls.some((call) => call.includes('/permission')), calls.join('\n'));
});

// One finding thread with these replies, and the rest of fakeGitHub's answers.
function repliedThread(replies: { login: string; association: string; body: string }[], answer: (url: string) => unknown) {
  const { api: base } = fakeGitHub();
  const thread = botThread(reviewed({ id: 'F9', file: 'src/Z.cs', line: 99, severity: 'nit' }), { replies });
  return async (method: string, url: string, body?: unknown) => {
    if (url === '/graphql') return { data: { repository: { pullRequest: { reviewThreads: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [thread] } } } } };
    if (url.endsWith('/permission')) return answer(url);
    return base(method, url, body);
  };
}

test('collectOutcomes counts a reply from a writer whose association does not say so', async () => {
  const api = repliedThread([{ login: 'private-member', association: 'CONTRIBUTOR', body: "Won't fix this." }], (url) => {
    if (url === '/repos/o/r/collaborators/private-member/permission') return { permission: 'write' };
    throw new Error(`Unexpected ${url}`);
  });
  const report = await collectOutcomes(api, 'o/r', { number: 5, merged: true, head: { sha: closedHead } }, () => {});
  assert.deepEqual(report?.findings.map((f) => [f.id, f.outcome]), [['F9', 'dismissed']]);
});

test('collectOutcomes counts a replier whose permission cannot be read as a non-writer, and warns', async () => {
  const api = repliedThread([{ login: 'private-member', association: 'CONTRIBUTOR', body: "Won't fix this." }], () => {
    throw new Error('HTTP 502');
  });
  const lines: string[] = [];
  const report = await collectOutcomes(api, 'o/r', { number: 5, merged: true, head: { sha: closedHead } }, (line) => lines.push(line));
  assert.deepEqual(report?.findings.map((f) => [f.id, f.outcome]), [['F9', 'ignored']]);
  assert.ok(
    lines.some((line) => /^::warning::Couldn't read private-member's permission \(.*HTTP 502.*\); their reactions and replies count as a non-writer's\.$/.test(line)),
    lines.join('\n'),
  );
});

test('collectOutcomes looks up at most maxReplyAuthorLookups repliers', async () => {
  const looked: string[] = [];
  const replies = Array.from({ length: maxReplyAuthorLookups + 1 }, (_, i) => ({ login: `user${i}`, association: 'CONTRIBUTOR', body: 'Thanks.' }));
  const api = repliedThread(replies, (url) => {
    looked.push(url);
    return { permission: 'read' };
  });
  await collectOutcomes(api, 'o/r', { number: 5, merged: true, head: { sha: closedHead } }, () => {});
  assert.equal(looked.length, maxReplyAuthorLookups);
});

test('collectOutcomes takes the newest review marker of a commit reviewed twice', async () => {
  const { api: base, summaryBody } = fakeGitHub();
  const earlier = supersededComment(reviewedAt, 'https://example.test/c/42', [reviewMarker({ ...reviewResults, costUsd: 0.1, provider: 'anthropic' } as unknown as Results)]);
  const api = async (method: string, url: string, body?: unknown) => {
    if (url.startsWith('/repos/o/r/issues/5/comments')) return [{ id: 41, user: { login: 'ncode-review[bot]' }, body: earlier }, { id: 42, user: { login: 'ncode-review[bot]' }, body: summaryBody }];
    return base(method, url, body);
  };
  const report = await collectOutcomes(api, 'o/r', { number: 5, merged: true, head: { sha: closedHead } }, () => {});
  assert.deepEqual(report?.findings.map((f) => [f.costUsd, f.provider]), [[0.6912, 'bedrock'], [0.6912, 'bedrock'], [0.6912, 'bedrock']]);
  assert.equal(report?.summaryCommentId, 42);
});

test("readReviewThreads throws on GraphQL errors and on an answer without the threads, rather than reading no threads", async () => {
  await assert.rejects(readReviewThreads(async () => ({ errors: [{ message: 'boom' }] }), 'o/r', 5, () => {}), /refused the review threads: boom/);
  await assert.rejects(readReviewThreads(async () => ({ data: { repository: null } }), 'o/r', 5, () => {}), /Couldn't read the review threads of #5/);
});

test('readReviewThreads stops after maxThreadPages pages and warns', async () => {
  let pages = 0;
  const api = async () => {
    pages++;
    return { data: { repository: { pullRequest: { reviewThreads: { pageInfo: { hasNextPage: true, endCursor: `c${pages}` }, nodes: [{ isResolved: false, isOutdated: false, path: 'a', comments: { nodes: [] } }] } } } } };
  };
  const lines: string[] = [];
  const threads = await readReviewThreads(api, 'o/r', 5, (line) => lines.push(line));
  assert.equal(pages, maxThreadPages);
  assert.equal(threads.length, maxThreadPages);
  assert.deepEqual(lines, [`::warning::#5 has more than ${maxThreadPages * threadPageSize} review threads; outcomes are recorded for the first ${maxThreadPages}.`]);
});

const report: OutcomesReport = { repository: 'o/r', pullRequest: 5, state: 'merged', head: closedHead, findings, summaryCommentId: 42, summaryBody: `${summaryMarker}\n${headMarker(reviewedAt)}\nbody` };

test('publishOutcomes adds the outcomes to the newest summary comment', async () => {
  const calls: { call: string; body: any }[] = [];
  const api = async (method: string, url: string, body?: unknown) => {
    calls.push({ call: `${method} ${url}`, body });
  };
  await publishOutcomes(api, report, ['secret-token'], () => {});
  assert.deepEqual(calls.map((c) => c.call), ['PATCH /repos/o/r/issues/comments/42']);
  const body = calls[0]!.body.body as string;
  assert.ok(body.startsWith(report.summaryBody!));
  assert.deepEqual(parseOutcomesMarker(body)?.findings, findings);
});

test('publishOutcomes posts a final comment when there is no summary or it cannot be edited', async () => {
  const calls: { call: string; body: any }[] = [];
  const api = async (method: string, url: string, body?: unknown) => {
    calls.push({ call: `${method} ${url}`, body });
    if (method === 'PATCH') throw new Error('HTTP 404');
    return { html_url: 'https://example.test/c/9' };
  };
  const { summaryCommentId: _id, summaryBody: _body, ...withoutSummary } = report;
  await publishOutcomes(api, withoutSummary, [], () => {});
  await publishOutcomes(api, report, [], () => {});
  assert.deepEqual(calls.map((c) => c.call), ['POST /repos/o/r/issues/5/comments', 'PATCH /repos/o/r/issues/comments/42', 'POST /repos/o/r/issues/5/comments']);
  const posted = calls[0]!.body.body as string;
  assert.ok(posted.startsWith(`${summaryMarker}\n<!-- ncode-review:outcomes `));
  assert.equal(parseOutcomesMarker(posted)?.state, 'merged');
  // The final comment that stands in for a summary it couldn't edit names that summary's commit, so a reopen skips it.
  const fallback = calls[2]!.body.body as string;
  assert.ok(fallback.startsWith(`${summaryMarker}\n${headMarker(reviewedAt)}\n<!-- ncode-review:outcomes `));
  assert.equal(newestReviewedHead([{ user: { login: 'ncode-review[bot]' }, body: report.summaryBody! }, { user: { login: 'ncode-review[bot]' }, body: fallback }]), reviewedAt);
});

test('publishOutcomes refuses to post a secret', async () => {
  const api = async () => undefined;
  const leaky = { ...report, summaryBody: `${report.summaryBody} ghs_0123456789abcdefghijABCDEFGHIJ` };
  await assert.rejects(publishOutcomes(api, leaky, [], () => {}));
});

test('publishOutcomes warns when the marker leaves findings out', async () => {
  const many = Array.from({ length: 1000 }, (_, i) => ({ ...findings[0]!, id: `F${i + 1}` }));
  const lines: string[] = [];
  await publishOutcomes(async () => undefined, { ...report, findings: many }, [], (line) => lines.push(line));
  assert.ok(lines.some((line) => /^::warning::The outcomes marker holds the first \d+ of 1000 findings/.test(line)), lines.join('\n'));
  lines.length = 0;
  await publishOutcomes(async () => undefined, report, [], (line) => lines.push(line));
  assert.ok(!lines.some((line) => line.startsWith('::warning::')), lines.join('\n'));
});

test('only a closed pull request records outcomes, never a comment or another action', () => {
  assert.ok(isClosedEvent({ action: 'closed', pull_request: {} }));
  for (const action of ['opened', 'reopened', 'ready_for_review', 'synchronize']) assert.ok(!isClosedEvent({ action, pull_request: {} }), action);
  assert.ok(!isClosedEvent({ action: 'closed', comment: {}, pull_request: {} }));
  assert.ok(!isClosedEvent({ action: 'created', comment: {} }));
});

test("recordOutcomes skips a fork's pull request without a call", async () => {
  const calls: string[] = [];
  const api = async (method: string, url: string) => {
    calls.push(`${method} ${url}`);
  };
  const lines: string[] = [];
  await recordOutcomes(api, { pull_request: { number: 5, merged: true, head: { sha: closedHead, repo: { full_name: 'fork/r' } } } }, 'o/r', 'unused', (line) => lines.push(line));
  assert.deepEqual(calls, []);
  assert.match(lines[0]!, /comes from a fork/);
});

// Runs recordOutcomes with a scratch output folder and GITHUB_OUTPUT file, removed afterwards.
async function recordInScratch(api: Parameters<typeof recordOutcomes>[0], event: Parameters<typeof recordOutcomes>[1]) {
  const dir = mkdtempSync(path.join(tmpdir(), 'outcomes-'));
  const saved = process.env['GITHUB_OUTPUT'];
  process.env['GITHUB_OUTPUT'] = path.join(dir, 'github-output');
  const lines: string[] = [];
  try {
    await recordOutcomes(api, event, 'o/r', path.join(dir, 'out'), (line) => lines.push(line));
    const output = existsSync(path.join(dir, 'github-output')) ? readFileSync(path.join(dir, 'github-output'), 'utf8') : '';
    return { report: existsSync(path.join(dir, 'out')) ? readOutcomes(path.join(dir, 'out')) : undefined, output, lines };
  } finally {
    if (saved === undefined) delete process.env['GITHUB_OUTPUT'];
    else process.env['GITHUB_OUTPUT'] = saved;
    rmSync(dir, { recursive: true, force: true });
  }
}

const closedEvent = { pull_request: { number: 5, merged: true, head: { sha: closedHead, repo: { full_name: 'o/r' } } } };

test('recordOutcomes writes outcomes.json for the publish step and sets the outcomes output', async () => {
  const { report, output, lines } = await recordInScratch(fakeGitHub().api, closedEvent);
  assert.equal(report?.state, 'merged');
  assert.deepEqual(report?.findings.map((f) => [f.id, f.outcome]), [['F1', 'fixed'], ['F2', 'dismissed'], ['F3', 'ignored']]);
  assert.equal(output, 'outcomes=true\n');
  assert.deepEqual(lines, ['Merged: F1 fixed, F2 dismissed, F3 ignored.']);
});

test('recordOutcomes writes nothing for a pull request the bot never reviewed', async () => {
  const { report, output, lines } = await recordInScratch(fakeGitHub({ summary: false, threads: false }).api, closedEvent);
  assert.equal(report, undefined);
  assert.equal(output, '');
  assert.deepEqual(lines, ['#5 was never reviewed; no outcomes to record.']);
});

test("recordOutcomes refuses a closed event that doesn't name the head", async () => {
  await assert.rejects(recordOutcomes(fakeGitHub().api, { pull_request: { number: 5, head: { repo: { full_name: 'o/r' } } } }, 'o/r', 'unused', () => {}), /doesn't name the pull request and its head/);
});

test('readOutcomes reads the outcomes the review step left, and none after a review', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'outcomes-read-'));
  try {
    assert.equal(readOutcomes(dir), undefined);
    writeFileSync(path.join(dir, 'outcomes.json'), JSON.stringify(report));
    assert.deepEqual(readOutcomes(dir), report);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the caller triggers on closed, and the action gives a closed run no model key', () => {
  const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8');
  assert.match(readme, /types: \[opened, reopened, ready_for_review, closed\]/);
  assert.match(readme, /github\.event\.action == 'closed' \|\|/);
  const action = readFileSync(new URL('../action.yml', import.meta.url), 'utf8');
  assert.match(action, /CODE_REVIEW_BEDROCK_KEY: \$\{\{ github\.event\.action != 'closed' && inputs\.bedrock-api-key \|\| '' \}\}/);
});

test("this repository's workflow triggers on closed exactly when its pin is a release that records outcomes", () => {
  const workflow = readFileSync(new URL('../.github/workflows/code-review.yml', import.meta.url), 'utf8');
  assert.match(workflow, /github\.event\.action == 'closed' \|\|/);
  const pin = /NCodeGroup\/code-review@[0-9a-f]{40} # v(\d+)\.(\d+)\.(\d+)/.exec(workflow);
  assert.ok(pin, 'the action is pinned to a release');
  const [major, minor, patch] = pin.slice(1).map(Number) as [number, number, number];
  // v0.3.1 and earlier review a closed pull request at model cost; a later release records its outcomes instead.
  const recordsOutcomes = major > 0 || minor > 3 || (minor === 3 && patch > 1);
  assert.equal(/types: \[[^\]]*\bclosed\b/.test(workflow), recordsOutcomes, recordsOutcomes ? 'add closed to the types with this pin' : 'closed waits for a pin that records outcomes');
});

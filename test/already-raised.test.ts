import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import type { ThreadNode } from '../src/rereview.ts';
import type { Results } from '../src/results.ts';
import type { ReviewedFinding } from '../src/review.ts';
import { threadBody } from '../src/threads.ts';
import { runStep } from './steps.ts';

const made: string[] = [];
after(() => {
  for (const dir of made) rmSync(dir, { recursive: true, force: true });
});

const headSha = 'c'.repeat(40);
const threadUrl = 'https://github.com/o/r/pull/1#discussion_r1000';

const finding = (overrides: Partial<ReviewedFinding> = {}): ReviewedFinding => ({
  id: 'F1', severity: 'nit', file: 'src/Rule.cs', line: 25, title: 'ADR-1202 citation removed rather than moved', problem: 'p', consequence: 'c', fix: 'f', evidence: 'e', confidence: 0.9, reviewers: ['hygiene'], ...overrides,
});

test('the publish step reports a finding that repeats a dismissed thread as already raised, and posts no review', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'already-raised-'));
  made.push(dir);
  const out = path.join(dir, 'out');
  mkdirSync(out);
  const earlier = finding({ id: 'F2', title: 'Was the ADR-1202 citation meant to be dropped?' });
  const first = { author: { login: 'ncode-review' }, authorAssociation: 'NONE', body: threadBody(earlier), url: threadUrl };
  const dismissed: ThreadNode = {
    id: 'PRRT_1',
    isResolved: true,
    isOutdated: false,
    resolvedBy: { login: 'polewskm' },
    path: earlier.file,
    line: earlier.line,
    originalLine: earlier.line,
    first: { nodes: [{ ...first, reactions: { nodes: [] } }] },
    comments: { totalCount: 1, nodes: [first] },
  };
  const results: Results = {
    repository: 'o/r',
    pullRequest: 1,
    headSha,
    provider: 'bedrock',
    providerReason: 'test',
    summary: 'One nit.',
    verdict: 'comment',
    findings: [finding()],
    reviewers: [{ name: 'hygiene', status: 'ran', model: 'haiku', findingCount: 1, topSeverity: 'nit' }],
    skipped: [],
    synthesisModel: '',
    calls: [],
    costUsd: 0,
    durationMs: 0,
    notShown: [],
    dropped: [],
    changedLines: { 'src/Rule.cs': [25] },
  };
  writeFileSync(path.join(out, 'results.json'), JSON.stringify(results));
  const { requests } = runStep(
    'publish.ts',
    dir,
    {
      rest: {
        'GET https://api.github.com/repos/o/r/collaborators/polewskm/permission': { role_name: 'admin', permission: 'admin' },
        'POST https://api.github.com/repos/o/r/check-runs': { html_url: 'https://github.com/o/r/runs/1' },
        'GET https://api.github.com/repos/o/r/pulls/1/comments?per_page=100&page=1': [{ user: { login: 'ncode-review[bot]' }, path: earlier.file, line: earlier.line, body: threadBody(earlier), html_url: threadUrl }],
        'GET https://api.github.com/repos/o/r/issues/1/comments?per_page=100&page=1': [],
        'POST https://api.github.com/repos/o/r/issues/1/comments': { html_url: 'https://github.com/o/r/pull/1#issuecomment-1' },
      },
      graphql: [['reviewThreads', { data: { repository: { pullRequest: { reviewThreads: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [dismissed] } } } } }]],
    },
    { CODE_REVIEW_OUT: out, CODE_REVIEW_APP_TOKEN: 'app-token' },
  );
  assert.equal(requests.some((r) => r.method === 'POST' && r.url.endsWith('/pulls/1/reviews')), false);
  const check = requests.find((r) => r.method === 'POST' && r.url === 'https://api.github.com/repos/o/r/check-runs');
  const output = check!.body.output;
  assert.equal(output.title, 'No new findings, 1 already raised');
  assert.deepEqual(output.annotations, []);
  assert.ok(output.text.includes('- **F1 Nit** `src/Rule.cs:25`: **ADR-1202 citation removed rather than moved** p *Fix:* f — already raised as [F2](https://github.com/o/r/pull/1#discussion_r1000), dismissed.'), output.text);
  const comment = requests.find((r) => r.method === 'POST' && r.url === 'https://api.github.com/repos/o/r/issues/1/comments');
  const body: string = comment!.body.body;
  assert.ok(body.includes('**Verdict: ✅ Approve**'), body);
  assert.ok(body.includes('— 0 findings, 1 already raised ([run details](https://github.com/o/r/runs/1))'), body);
  assert.ok(body.includes('<details><summary>Already raised (1)</summary>'), body);
  assert.ok(body.includes('- 🟡 **F1** `src/Rule.cs:25`: ADR-1202 citation removed rather than moved (already raised as [F2](https://github.com/o/r/pull/1#discussion_r1000), dismissed)'), body);
  assert.ok(!body.includes('<summary>Findings</summary>'), body);
});

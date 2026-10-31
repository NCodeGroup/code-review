import assert from 'node:assert/strict';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import type { AgentRequest, AgentRun, CallRecord } from '../src/agent.ts';
import { budgets, findingsPerVerification, verificationOn } from '../src/config.ts';
import { checkText, type Results } from '../src/results.ts';
import { loadCharters, type ReviewedFinding } from '../src/review.ts';
import {
  applyVerifications,
  hunkFor,
  verdictAfterVerification,
  verificationBatches,
  verificationNote,
  verifyFindings,
  verifyReview,
  type Verification,
  type VerificationAgent,
  type VerificationInput,
} from '../src/verify.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const finding = (id: string, severity: ReviewedFinding['severity'], file = 'src/a.ts', line = 3): ReviewedFinding => ({
  id,
  severity,
  file,
  line,
  title: `title ${id}`,
  problem: `problem ${id}`,
  consequence: 'c',
  fix: 'f',
  evidence: 'e',
  confidence: 0.7,
  reviewers: ['correctness'],
});

const diff = [
  'diff --git a/src/a.ts b/src/a.ts',
  '--- a/src/a.ts',
  '+++ b/src/a.ts',
  '@@ -1,2 +1,3 @@',
  ' one',
  '+two',
  ' three',
  '@@ -20,2 +21,3 @@',
  ' twenty',
  '+far away',
  ' twenty-two',
  'diff --git a/src/b.ts b/src/b.ts',
  '--- a/src/b.ts',
  '+++ b/src/b.ts',
  '@@ -1 +1,2 @@',
  ' b',
  '+bee',
  '',
].join('\n');

function record(costUsd: number): CallRecord {
  return { role: 'verification', provider: 'bedrock', model: 'global.anthropic.claude-sonnet-5-5', costUsd, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, turns: 1, durationMs: 1, outcome: 'success' };
}

const verdict = (id: string, v: Verification['verdict'], extra: Partial<Verification> = {}): Verification =>
  ({ id, verdict: v, path: `src/a.ts:3 → src/c.ts:9`, reason: `reason ${id}`, question: '', ...extra });

// A verification agent that answers from a table and records every request it gets.
function fakeAgent(answers: Map<string, Verification>, cost = 0.1) {
  const requests: { run: AgentRun; request: AgentRequest }[] = [];
  const agent: VerificationAgent = async (run, request) => {
    requests.push({ run, request });
    const text = Array.isArray(request.prompt) ? request.prompt.join('\n') : request.prompt;
    const ids = [...text.matchAll(/<finding id="(F\d+)"/g)].map((m) => m[1]!);
    return { output: { verifications: ids.flatMap((id) => (answers.has(id) ? [answers.get(id)!] : [])) }, records: [record(cost)] };
  };
  return { agent, requests };
}

function input(findings: ReviewedFinding[], agent: VerificationAgent, enabled = true): VerificationInput {
  return {
    run: { provider: 'bedrock', proxyUrl: 'http://127.0.0.1:1', checkout: '/checkout', workdir: '/work' },
    findings,
    diff,
    pullRequest: '<pull_request>\n#1: t\n</pull_request>',
    systemPrompt: 'verify',
    charters: new Map([['correctness', 'Correctness charter.'], ['security', 'Security charter.']]),
    log: () => {},
    enabled,
    agent,
  };
}

test('verificationOn is off unless CODE_REVIEW_VERIFICATION is on', () => {
  assert.equal(verificationOn(''), false);
  assert.equal(verificationOn('off'), false);
  assert.equal(verificationOn('yes'), false);
  assert.equal(verificationOn('on'), true);
});

test('verifyFindings makes no call and changes nothing when verification is off', async () => {
  const { agent, requests } = fakeAgent(new Map([['F1', verdict('F1', 'refuted')]]));
  const findings = [finding('F1', 'blocker')];
  const out = await verifyFindings(input(findings, agent, false));
  assert.equal(requests.length, 0);
  assert.deepEqual(out, { findings, refuted: [], questioned: 0, calls: [], trace: [] });
});

test('verifyFindings leaves nits unverified and makes no call when only nits remain', async () => {
  const { agent, requests } = fakeAgent(new Map([['F1', verdict('F1', 'refuted')], ['F2', verdict('F2', 'refuted')]]));
  const out = await verifyFindings(input([finding('F1', 'nit'), finding('F2', 'should-fix')], agent));
  assert.equal(requests.length, 1);
  assert.doesNotMatch(String(requests[0]!.request.prompt), /id="F1"/);
  assert.deepEqual(out.findings.map((f) => [f.id, f.title, f.severity]), [['F1', 'title F1', 'nit']]);

  const none = fakeAgent(new Map());
  assert.equal((await verifyFindings(input([finding('F1', 'nit')], none.agent))).calls.length, 0);
  assert.equal(none.requests.length, 0);
});

test('verificationBatches groups blockers and should-fixes by file, up to the batch size', () => {
  const findings = [finding('F1', 'blocker', 'a'), finding('F2', 'nit', 'a'), finding('F3', 'should-fix', 'b'), finding('F4', 'should-fix', 'a'), finding('F5', 'blocker', 'a')];
  assert.deepEqual(verificationBatches(findings, 2).map((b) => b.map((f) => f.id)), [['F1', 'F4'], ['F5'], ['F3']]);
  assert.ok(findingsPerVerification > 1);
});

test('verifyFindings makes one call per file, each on Sonnet with the checkout, its budget and only that file\'s findings', async () => {
  const { agent, requests } = fakeAgent(new Map());
  await verifyFindings(input([finding('F1', 'blocker', 'src/a.ts'), finding('F2', 'should-fix', 'src/b.ts', 2), finding('F3', 'should-fix', 'src/a.ts', 22)], agent));
  assert.equal(requests.length, 2);
  for (const { run, request } of requests) {
    assert.equal(run.checkout, '/checkout');
    assert.equal(request.role, 'verification');
    assert.equal(request.tier, 'sonnet');
    assert.equal(request.budgetUsd, budgets.verification);
    assert.equal(request.systemPrompt, 'verify');
  }
  const [first, second] = requests.map((r) => r.request.prompt as string[]);
  // The shared first block is the same in every call, so the provider caches it.
  assert.equal(first![0], second![0]);
  assert.match(first![0]!, /<charter reviewer="correctness">\nCorrectness charter\.\n<\/charter>/);
  assert.doesNotMatch(first![0]!, /Security charter/);
  assert.match(first![0]!, /The checkout is at: \/checkout/);
  assert.match(first![1]!, /id="F1"[\s\S]*\+two[\s\S]*id="F3"[\s\S]*\+far away/);
  assert.doesNotMatch(first![1]!, /id="F2"/);
  assert.match(second![1]!, /id="F2"[\s\S]*\+bee/);
});

test('a confirmed finding stays, with the code path added to its evidence', async () => {
  const { agent } = fakeAgent(new Map([['F1', verdict('F1', 'confirmed')]]));
  const out = await verifyFindings(input([finding('F1', 'blocker')], agent));
  assert.equal(out.findings.length, 1);
  assert.equal(out.findings[0]!.severity, 'blocker');
  assert.equal(out.findings[0]!.evidence, 'e\n\nVerified: src/a.ts:3 → src/c.ts:9');
  assert.deepEqual(out.refuted, []);
});

test('a refuted finding is dropped and recorded with its reason, in the outcome and the trace', async () => {
  const { agent } = fakeAgent(new Map([['F1', verdict('F1', 'refuted')]]));
  const out = await verifyFindings(input([finding('F1', 'blocker'), finding('F2', 'should-fix', 'src/b.ts')], agent));
  assert.deepEqual(out.findings.map((f) => [f.id, f.title]), [['F1', 'title F2']]);
  assert.equal(out.refuted.length, 1);
  assert.equal(out.refuted[0]!.finding.title, 'title F1');
  assert.equal(out.refuted[0]!.reason, 'reason F1');
  assert.equal(out.refuted[0]!.path, 'src/a.ts:3 → src/c.ts:9');
  assert.equal(out.trace.length, 2);
  assert.deepEqual(out.trace.find((c) => c.file === 'src/a.ts')!.verifications, [verdict('F1', 'refuted')]);
});

test('a refutation without a reason drops nothing and makes the finding a question', () => {
  const out = applyVerifications([finding('F1', 'blocker')], new Map([['F1', verdict('F1', 'refuted', { reason: ' ' })]]));
  assert.deepEqual(out.refuted, []);
  assert.deepEqual(out.findings.map((f) => [f.severity, f.problem]), [['should-fix', 'Is this intended? problem F1']]);
});

test('an uncertain finding becomes a question one severity lower', async () => {
  const { agent } = fakeAgent(new Map([
    ['F1', verdict('F1', 'uncertain', { question: 'Is the cache meant to be shared? If not, scope it per tenant.' })],
    ['F2', verdict('F2', 'uncertain')],
  ]));
  const out = await verifyFindings(input([finding('F1', 'blocker'), finding('F2', 'should-fix'), finding('F3', 'blocker')], agent));
  assert.deepEqual(out.findings.map((f) => [f.id, f.title, f.severity, f.problem]), [
    ['F1', 'title F3', 'blocker', 'problem F3'],
    ['F2', 'title F1', 'should-fix', 'Is the cache meant to be shared? If not, scope it per tenant.'],
    ['F3', 'title F2', 'nit', 'Is this intended? problem F2'],
  ]);
  assert.match(out.findings[1]!.evidence, /Verification couldn't settle it: reason F1$/);
});

test('a failed verification call leaves its findings as they were and records the error', async () => {
  const agent: VerificationAgent = async () => ({ output: undefined, records: [{ ...record(0.02), outcome: 'error' }], error: 'budget' });
  const findings = [finding('F1', 'blocker')];
  const out = await verifyFindings(input(findings, agent));
  assert.deepEqual(out.findings, findings);
  assert.equal(out.trace[0]!.error, 'budget');
  assert.equal(out.calls.length, 1);
});

test('verification calls are recorded as the verification role and costed in the check run, with the refuted findings', async () => {
  const { agent } = fakeAgent(new Map([['F1', verdict('F1', 'refuted', { reason: 'The <caller> checks it | always.' })]]), 0.125);
  const out = await verifyFindings(input([finding('F1', 'blocker'), finding('F2', 'should-fix', 'src/b.ts')], agent));
  assert.deepEqual(out.calls.map((c) => [c.role, c.costUsd]), [['verification', 0.125], ['verification', 0.125]]);
  const text = checkText({ findings: out.findings, refuted: out.refuted, reviewers: [], calls: out.calls } as unknown as Results);
  assert.match(text, /### Refuted by verification\n\n- Blocker `src\/a\.ts:3` \*\*title F1\*\* \(correctness\): The &lt;caller> checks it \\\| always\. — `src\/a\.ts:3 → src\/c\.ts:9`/);
  assert.match(text, /\| verification \| ran \| \| \$0\.250 \|/);
  const off = checkText({ findings: [], reviewers: [], calls: [] } as unknown as Results);
  assert.doesNotMatch(off, /Refuted by verification|\| verification/);
});

test('hunkFor gives the hunk that holds the line, or the nearest one', () => {
  const section = diff.split('diff --git a/src/b.ts')[0]!;
  assert.match(hunkFor(section, 2), /^@@ -1,2 \+1,3 @@\n one\n\+two\n three$/);
  assert.match(hunkFor(section, 22), /^@@ -20,2 \+21,3 @@[\s\S]*\+far away/);
  assert.match(hunkFor(section, 30), /\+far away/);
  assert.match(hunkFor(undefined, 1), /no hunk/);
});

test('verdictAfterVerification eases a request for changes when verification leaves nothing serious, and never approves', () => {
  assert.equal(verdictAfterVerification('request-changes', []), 'comment');
  assert.equal(verdictAfterVerification('request-changes', [finding('F1', 'nit')]), 'comment');
  assert.equal(verdictAfterVerification('request-changes', [finding('F1', 'should-fix')]), 'request-changes');
  assert.equal(verdictAfterVerification('comment', [finding('F1', 'nit')]), 'comment');
  assert.equal(verdictAfterVerification('comment', []), 'comment');
});

test('a verification agent that throws leaves its findings as they were and records the error', async () => {
  const agent: VerificationAgent = async () => {
    throw new Error('socket hang up');
  };
  const findings = [finding('F1', 'blocker'), finding('F2', 'should-fix', 'src/b.ts')];
  const out = await verifyFindings(input(findings, agent));
  assert.deepEqual(out.findings, findings);
  assert.deepEqual(out.refuted, []);
  assert.deepEqual(out.trace.map((c) => c.error), ['socket hang up', 'socket hang up']);
  assert.deepEqual(out.calls.map((c) => [c.role, c.costUsd, c.outcome]), [['verification', 0, 'error'], ['verification', 0, 'error']]);
});

test('a verification call rerun on Bedrock records both calls and costs them together', async () => {
  const refused: CallRecord = { ...record(0.01), provider: 'anthropic', model: 'claude-sonnet-5-5', outcome: 'credits ran out' };
  const agent: VerificationAgent = async () => ({ output: { verifications: [verdict('F1', 'confirmed')] }, records: [refused, record(0.1)] });
  const out = await verifyFindings(input([finding('F1', 'blocker')], agent));
  assert.deepEqual(out.calls.map((c) => [c.provider, c.costUsd]), [['anthropic', 0.01], ['bedrock', 0.1]]);
  assert.equal(out.trace[0]!.costUsd, 0.11);
  assert.match(out.findings[0]!.evidence, /Verified:/);
});

test('a verification agent that throws after the run switched to Bedrock records the call on Bedrock', async () => {
  const agent: VerificationAgent = async () => {
    throw new Error('socket hang up');
  };
  const run: AgentRun = { provider: 'anthropic', proxyUrl: 'http://127.0.0.1:1', checkout: '/checkout', workdir: '/work', fallback: { switched: true } };
  const out = await verifyFindings({ ...input([finding('F1', 'blocker')], agent), run });
  assert.deepEqual(out.calls.map((c) => [c.provider, c.outcome]), [['bedrock', 'error']]);
});

test('a verdict for a finding outside the call\'s batch is ignored', async () => {
  const agent: VerificationAgent = async (_run, request) => {
    const text = (request.prompt as string[]).join('\n');
    // Every call claims to refute F2, but only the call on src/b.ts was given it, and that one confirms it.
    const own = text.includes('id="F2"') ? [verdict('F2', 'confirmed')] : [verdict('F2', 'refuted')];
    return { output: { verifications: own }, records: [record(0.1)] };
  };
  const out = await verifyFindings(input([finding('F1', 'blocker'), finding('F2', 'should-fix', 'src/b.ts')], agent));
  assert.deepEqual(out.refuted, []);
  assert.deepEqual(out.findings.map((f) => [f.id, f.title]), [['F1', 'title F1'], ['F2', 'title F2']]);
  assert.match(out.findings[1]!.evidence, /Verified:/);
  assert.deepEqual(out.trace.find((c) => c.file === 'src/a.ts')!.verifications, []);
});

test('when a call names a finding twice, its first verdict holds', async () => {
  const agent: VerificationAgent = async () => ({
    output: { verifications: [verdict('F1', 'confirmed'), verdict('F1', 'refuted')] },
    records: [record(0.1)],
  });
  const out = await verifyFindings(input([finding('F1', 'blocker')], agent));
  assert.deepEqual(out.refuted, []);
  assert.equal(out.findings[0]!.severity, 'blocker');
  assert.match(out.findings[0]!.evidence, /Verified:/);
});

test('the trace maps each verified finding to the id it was posted with', async () => {
  const { agent } = fakeAgent(new Map([['F1', verdict('F1', 'refuted')], ['F2', verdict('F2', 'uncertain')], ['F3', verdict('F3', 'confirmed')]]));
  const out = await verifyFindings(input([finding('F1', 'blocker'), finding('F2', 'blocker'), finding('F3', 'should-fix')], agent));
  assert.deepEqual(out.findings.map((f) => [f.id, f.title]), [['F1', 'title F2'], ['F2', 'title F3']]);
  assert.deepEqual(out.trace[0]!.findings.map((f) => [f.id, f.postedAs]), [['F1', undefined], ['F2', 'F1'], ['F3', 'F2']]);
  assert.equal(out.questioned, 1);
});

test('a confirmed verdict without a path puts its reason in the evidence', () => {
  const out = applyVerifications([finding('F1', 'blocker')], new Map([['F1', verdict('F1', 'confirmed', { path: ' ' })]]));
  assert.equal(out.findings[0]!.evidence, 'e\n\nVerified: reason F1');
});

test('hunkFor gives the start of a section without hunk headers', () => {
  const section = 'diff --git a/bin b/bin\nBinary files differ\n';
  assert.equal(hunkFor(section, 1), section);
  assert.equal(hunkFor('x'.repeat(7_000), 1).length, 6_000);
});

test('verificationNote names the refuted findings and counts the ones verification made questions', () => {
  const refuted = (title: string) => ({ finding: { ...finding('F1', 'blocker'), title }, path: 'p', reason: 'r' });
  assert.equal(verificationNote([], 0), '');
  assert.equal(
    verificationNote([refuted('Token leaks')], 0),
    ' After this summary was written, verification refuted one finding, which the check run lists with its reason: "Token leaks".',
  );
  assert.equal(
    verificationNote([refuted('A'), refuted('B')], 2),
    ' After this summary was written, verification refuted 2 findings, which the check run lists with their reasons: "A"; "B", and couldn\'t settle 2 findings, now questions one severity lower.',
  );
  assert.equal(verificationNote([], 1), ' After this summary was written, verification couldn\'t settle one finding, now a question one severity lower.');
});

// What review() hands verification after synthesis, and what it takes back.
function reviewInput(agent: VerificationAgent, enabled = true): Omit<VerificationInput, 'findings'> {
  const { findings: _findings, ...rest } = input([], agent, enabled);
  return rest;
}

test('verifyReview with verification off returns synthesis\'s review unchanged', async () => {
  const { agent, requests } = fakeAgent(new Map([['F1', verdict('F1', 'refuted')]]));
  const synthesized = { summary: 'Risky.', verdict: 'request-changes' as const, findings: [finding('F1', 'blocker')] };
  const out = await verifyReview(synthesized, reviewInput(agent, false));
  assert.equal(requests.length, 0);
  assert.deepEqual(out, { ...synthesized, refuted: [], calls: [], trace: [] });
});

test('verifyReview drops a refuted blocker, names it in the summary and eases request-changes to comment, not approve', async () => {
  const { agent } = fakeAgent(new Map([['F1', verdict('F1', 'refuted')]]));
  const out = await verifyReview({ summary: 'Risky.', verdict: 'request-changes', findings: [finding('F1', 'blocker')] }, reviewInput(agent));
  assert.deepEqual(out.findings, []);
  assert.deepEqual(out.refuted.map((r) => r.finding.title), ['title F1']);
  assert.equal(out.summary, 'Risky. After this summary was written, verification refuted one finding, which the check run lists with its reason: "title F1".');
  assert.equal(out.verdict, 'comment');
  assert.equal(out.calls.length, 1);
  assert.equal(out.trace.length, 1);
});

test('verifyReview keeps a request for changes while a blocker or should-fix is left', async () => {
  const { agent } = fakeAgent(new Map([['F1', verdict('F1', 'refuted')], ['F2', verdict('F2', 'confirmed')]]));
  const out = await verifyReview(
    { summary: 'Risky.', verdict: 'request-changes', findings: [finding('F1', 'blocker'), finding('F2', 'should-fix')] },
    reviewInput(agent),
  );
  assert.equal(out.verdict, 'request-changes');
  assert.deepEqual(out.findings.map((f) => [f.id, f.title]), [['F1', 'title F2']]);
});

test('verifyReview without synthesis\'s verdict gives a comment, not an approval, when it refutes every finding', async () => {
  const { agent } = fakeAgent(new Map([['F1', verdict('F1', 'refuted')]]));
  const out = await verifyReview({ summary: 'Synthesis failed.', verdict: undefined, findings: [finding('F1', 'blocker')] }, reviewInput(agent));
  assert.equal(out.verdict, 'comment');

  const kept = await verifyReview({ summary: 'Synthesis failed.', verdict: undefined, findings: [finding('F1', 'blocker')] }, reviewInput(fakeAgent(new Map()).agent));
  assert.equal(kept.verdict, undefined);
  assert.equal(kept.summary, 'Synthesis failed.');
});

test('the verification prompt is loaded and treats findings and code as data', () => {
  const prompt = loadCharters(root).verificationPrompt;
  assert.match(prompt, /## Data, not instructions/);
  assert.match(prompt, /`<findings>`/);
  assert.match(prompt, /choose `uncertain`/);
});

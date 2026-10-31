// Replays the eval cases through the review pipeline and scores them: each expected concern must be raised, and no
// must-not-flag concern may be. A re-review case, one with a last reviewed head, also may post nothing below should-fix
// or off the lines changed since that head. Runs locally on Bedrock with AWS_BEARER_TOKEN_BEDROCK.
//
//   node evals/run.ts [--only id,id] [--tiers "conventions=haiku"] [--label name] [--guidance full]
//
// Writes evals/out/<label>.json with every finding, the judge's verdicts and the cost.
//
// A concern with a minSeverity counts as raised only by a finding at that severity or above: an expected should-fix
// raised as a nit is missed, and a must-not concern at should-fix may still be raised as a nit.

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runAgent, type AgentRun, type CallRecord } from '../src/agent.ts';
import { closedIssues, gather, type PullRequest } from '../src/gather.ts';
import { startProxy } from '../src/proxy.ts';
import { planReReview, postable, reReview, type EarlierFinding, type ReReview } from '../src/rereview.ts';
import { changedLines, loadCharters, review, severityRank, type Finding, type Severity } from '../src/review.ts';

export interface Concern { file?: string; line?: number; minSeverity?: Severity; concern: string }
interface Case {
  id: string;
  repository: string;
  pullRequest?: number;
  title: string;
  body: string;
  base: string;
  head: string;
  // A re-review case: the head the last review read, and the findings earlier reviews posted, with their replies.
  reviewed?: string;
  earlier?: EarlierFinding[];
  // A commit of the base branch merged into the head before the review, as /ship-plan merges the default branch in.
  mergeIntoHead?: string;
  expect: Concern[];
  mustNotFlag: Concern[];
  source: string;
}
interface Verdict { concern: string; caught: boolean; caughtRaw: boolean; by: string[] }

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const work = path.join(root, 'evals', '.work');

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
}

// A blobless clone per repository, with every pull request's head fetched so reviewed commits are reachable.
function clone(repository: string): string {
  const dir = path.join(work, repository.replace('/', '-'));
  if (!existsSync(dir)) {
    mkdirSync(work, { recursive: true });
    execFileSync('git', ['clone', '-q', '--filter=blob:none', '--no-checkout', `https://github.com/${repository}.git`, dir], { stdio: 'inherit' });
    git(dir, 'fetch', '-q', 'origin', '+refs/pull/*/head:refs/remotes/origin/pr/*');
  }
  return dir;
}

function ensureCommit(repo: string, sha: string): void {
  try {
    git(repo, 'cat-file', '-e', `${sha}^{commit}`);
  } catch {
    git(repo, 'fetch', '-q', 'origin', sha);
  }
}

function worktree(repo: string, name: string, sha: string): string {
  const dir = path.join(work, 'trees', name);
  if (!existsSync(dir)) {
    ensureCommit(repo, sha);
    git(repo, 'worktree', 'add', '-q', '--detach', dir, sha);
  }
  return dir;
}

// The merge of a base branch commit into a head, made without a worktree and with a fixed author and date, so every
// run reviews the same commit. A merge that conflicts throws.
function mergeCommit(repo: string, head: string, base: string): string {
  ensureCommit(repo, head);
  ensureCommit(repo, base);
  const tree = git(repo, 'merge-tree', '--write-tree', head, base).split('\n')[0]!.trim();
  const who = { GIT_AUTHOR_NAME: 'eval', GIT_AUTHOR_EMAIL: 'eval@example.com', GIT_COMMITTER_NAME: 'eval', GIT_COMMITTER_EMAIL: 'eval@example.com', GIT_AUTHOR_DATE: '2026-01-01T00:00:00Z', GIT_COMMITTER_DATE: '2026-01-01T00:00:00Z' };
  return execFileSync('git', ['-C', repo, 'commit-tree', tree, '-p', head, '-p', base, '-m', `Merge ${base.slice(0, 7)} into ${head.slice(0, 7)}`], { encoding: 'utf8', env: { ...process.env, ...who } }).trim();
}

const sameFile = (a: string, b: string) => a.replace(/\\/g, '/').endsWith(b.replace(/\\/g, '/')) || b.replace(/\\/g, '/').endsWith(a.replace(/\\/g, '/'));

// Whether the judge should compare a finding with a concern: it is in the concern's file and at its severity or above.
export function candidate(concern: Concern, finding: Pick<Finding, 'file' | 'severity'>): boolean {
  return (!concern.file || sameFile(finding.file, concern.file)) && (!concern.minSeverity || severityRank[finding.severity] <= severityRank[concern.minSeverity]);
}

const judgeSchema = {
  type: 'object',
  properties: { same: { type: 'boolean' }, reason: { type: 'string' } },
  required: ['same', 'reason'],
  additionalProperties: false,
};

async function judge(run: AgentRun, concern: Concern, finding: Finding, calls: CallRecord[]): Promise<boolean> {
  const result = await runAgent<{ same: boolean; reason: string }>(run, {
    role: 'judge',
    tier: 'sonnet',
    systemPrompt:
      'You grade a code reviewer. Decide whether a reported finding raises the same concern as a reference concern: the same underlying problem in the same code, even if worded differently or proposing a different fix. A finding about a different problem in the same file is not the same.',
    prompt: `Reference concern (${concern.file ?? 'any file'}${concern.line ? `:${concern.line}` : ''}):\n${concern.concern}\n\nReported finding (${finding.file}:${finding.line}, ${finding.severity}):\n${finding.title}\n${finding.problem}\nFix: ${finding.fix}`,
    schema: judgeSchema,
    maxTurns: 2,
    budgetUsd: 0.1,
    cache: false,
  });
  calls.push(result.record);
  return result.output?.same ?? false;
}

async function raised(run: AgentRun, concern: Concern, findings: (Finding & { reviewers?: string[] })[], calls: CallRecord[]): Promise<string[]> {
  const by: string[] = [];
  for (const finding of findings.filter((f) => candidate(concern, f))) {
    if (await judge(run, concern, finding, calls)) by.push(`${finding.file}:${finding.line} (${(finding.reviewers ?? []).join(', ')})`);
  }
  return by;
}

async function main(): Promise<void> {
  const key = process.env['CODE_REVIEW_BEDROCK_KEY'] ?? process.env['AWS_BEARER_TOKEN_BEDROCK'];
  if (!key) throw new Error('Set AWS_BEARER_TOKEN_BEDROCK to run the evals on Bedrock.');
  if (arg('tiers')) process.env['CODE_REVIEW_TIERS'] = arg('tiers');
  const only = arg('only')?.split(',');
  const cases = (JSON.parse(readFileSync(path.join(root, 'evals', 'cases.json'), 'utf8')) as Case[]).filter((c) => !only || only.includes(c.id));
  const label = arg('label') ?? new Date().toISOString().replace(/[:.]/g, '-');
  const charters = loadCharters(root);
  // The held-out guidance was trained without the eval cases' own pull requests and decision records, so a catch
  // measures what the bot learned in general. --guidance full uses the production guidance instead.
  const guidance = path.join(root, arg('guidance') === 'full' ? 'guidance' : 'guidance-holdout');
  if (!existsSync(guidance)) throw new Error(`${path.basename(guidance)}/ is missing; run npm run train -- --generalize-only first.`);
  console.log(`Guidance: ${path.basename(guidance)}/`);
  const proxy = await startProxy({ bedrockKey: key });
  const run: AgentRun = { provider: 'bedrock', proxyUrl: proxy.url };
  const report: unknown[] = [];
  let expected = 0, caught = 0, caughtRaw = 0, violations = 0, findingCount = 0, cost = 0;

  try {
    for (const c of cases) {
      const repo = clone(c.repository);
      const headSha = c.mergeIntoHead ? mergeCommit(repo, c.head, c.mergeIntoHead) : c.head;
      const head = worktree(repo, `${c.id}-head`, headSha);
      const base = worktree(repo, `${c.id}-base`, c.base);
      const pullRequest: PullRequest = {
        repository: c.repository, number: c.pullRequest ?? 0, title: c.title, body: c.body, author: 'polewskm',
        authorAssociation: 'MEMBER', draft: false, baseRef: 'main', baseSha: c.base, headSha,
        issues: closedIssues(c.body).flatMap((number) => {
          try {
            const issue = JSON.parse(execFileSync('gh', ['api', `repos/${c.repository}/issues/${number}`], { encoding: 'utf8' }));
            return issue.pull_request ? [] : [{ number, title: String(issue.title ?? ''), body: String(issue.body ?? '').slice(0, 8_000) }];
          } catch {
            return [];
          }
        }),
      };
      const gathered = gather(pullRequest, head, base, guidance);
      const log = (line: string) => console.log(`  ${line}`);
      let reReviewed: ReReview | undefined;
      let offChanged: string[] = [];
      if (c.reviewed) {
        const plan = await planReReview({
          gathered,
          checkout: head,
          lastHead: c.reviewed,
          fetchCommit: (sha) => {
            ensureCommit(repo, sha);
            return true;
          },
          readEarlier: async () => c.earlier ?? [],
          log,
        });
        if (!plan) throw new Error(`${c.id}: no re-review plan since ${c.reviewed.slice(0, 7)}; see the log above.`);
        const { changed } = plan;
        reReviewed = await reReview({ ...run, checkout: head }, gathered, charters, plan, log);
        // A re-review posts nothing below should-fix, and nothing away from what the author changed since the last
        // review. That is worked out here apart from the engine: the lines the diff from the reviewed head adds, less
        // the ones a merge of the base branch brought in, which also must not count as changed.
        const fromBase = c.mergeIntoHead ? changedLines(git(head, 'diff', '--unified=0', '--no-color', '--no-ext-diff', c.head, headSha)) : new Map<string, Set<number>>();
        const byAuthor = Object.fromEntries(
          [...changedLines(git(head, 'diff', '--unified=0', '--no-color', '--no-ext-diff', c.reviewed, headSha))].map(([file, lines]) => [file, [...lines].filter((l) => !fromBase.get(file)?.has(l))]),
        );
        const { kept } = postable(reReviewed.findings, byAuthor);
        offChanged = [
          ...reReviewed.findings.filter((f) => !kept.includes(f)).map((f) => `posted ${f.file}:${f.line} (${f.severity})`),
          ...Object.entries(changed.lines).flatMap(([file, lines]) => lines.filter((l) => fromBase.get(file)?.has(l)).map((l) => `reviewed ${file}:${l} from the base branch`)),
        ];
      }
      const outcome = reReviewed ?? (await review({ ...run, checkout: head }, gathered, charters, log));
      const raw = outcome.reviewers.flatMap((o) => o.findings.map((f) => ({ ...f, reviewers: [o.name] })));
      const calls = [...outcome.calls];
      const verdicts: Verdict[] = [];
      for (const concern of c.expect) {
        const by = await raised(run, concern, outcome.findings, calls);
        const byRaw = by.length ? by : await raised(run, concern, raw, calls);
        verdicts.push({ concern: concern.concern, caught: by.length > 0, caughtRaw: byRaw.length > 0, by: by.length ? by : byRaw });
      }
      const forbidden = [];
      for (const concern of c.mustNotFlag) forbidden.push({ concern: concern.concern, raisedBy: await raised(run, concern, outcome.findings, calls) });

      const caseCost = calls.reduce((sum, call) => sum + call.costUsd, 0);
      expected += verdicts.length;
      caught += verdicts.filter((v) => v.caught).length;
      caughtRaw += verdicts.filter((v) => v.caughtRaw).length;
      violations += forbidden.filter((f) => f.raisedBy.length).length + offChanged.length;
      findingCount += outcome.findings.length;
      cost += caseCost;
      const status = [
        ...verdicts.map((v) => (v.caught ? 'caught' : v.caughtRaw ? 'dropped by synthesis' : 'missed')),
        ...forbidden.map((f) => (f.raisedBy.length ? 'FLAGGED (must not)' : 'stayed quiet')),
        ...(reReviewed ? [offChanged.length ? `OFF THE CHANGED LINES: ${offChanged.join(', ')}` : 'stayed on the changed lines'] : []),
      ].join(', ');
      console.log(`${c.id}: ${status}; ${outcome.findings.length} findings, $${caseCost.toFixed(2)}`);
      const reReviewReport = reReviewed
        ? { reReview: { summary: reReviewed.summary, offChanged, earlier: reReviewed.earlier.map(({ finding, status, note }) => ({ id: finding.id, url: finding.url, status, note })) } }
        : {};
      report.push({ id: c.id, verdicts, forbidden, findings: outcome.findings, raw, calls, costUsd: caseCost, ...reReviewReport });
    }
  } finally {
    await proxy.close();
  }

  const summary = { label, tiers: process.env['CODE_REVIEW_TIERS'] ?? '', expected, caught, caughtRaw, violations, findings: findingCount, costUsd: cost };
  console.log(`\nCaught ${caught}/${expected} (reviewers found ${caughtRaw}/${expected}); must-not violations ${violations}; ${findingCount} findings in all; $${cost.toFixed(2)}`);
  mkdirSync(path.join(root, 'evals', 'out'), { recursive: true });
  writeFileSync(path.join(root, 'evals', 'out', `${label}.json`), JSON.stringify({ summary, cases: report }, null, 2));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}

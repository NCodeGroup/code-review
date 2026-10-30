// Stages 2, 3 and 6 of the baseline: selection, specialists and synthesis.

import { mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { runAgent, type AgentRun, type CallRecord } from './agent.ts';
import { budgets, maxFindings, maxTurns, minConfidence, reviewerTiers, type ModelTier } from './config.ts';
import { guidanceRules, repositoryRules, selectContext, type Decision, type IndexedRule } from './context.ts';
import type { ChangedFile, Gathered } from './gather.ts';

export type Severity = 'blocker' | 'should-fix' | 'nit';

export interface Finding {
  severity: Severity;
  file: string;
  line: number;
  title: string;
  problem: string;
  consequence: string;
  fix: string;
  evidence: string;
  confidence: number;
}

export interface ReviewedFinding extends Finding {
  id: string;
  reviewers: string[];
}

export interface ReviewerOutcome {
  name: string;
  status: 'ran' | 'failed';
  findings: Finding[];
  error?: string;
}

export type Verdict = 'approve' | 'request-changes' | 'comment';

export interface Review {
  reviewers: ReviewerOutcome[];
  summary: string;
  verdict: Verdict;
  findings: ReviewedFinding[];
  calls: CallRecord[];
  // Roster reviewers the path rules and selection didn't choose.
  skipped: string[];
}

const findingProperties = {
  severity: { type: 'string', enum: ['blocker', 'should-fix', 'nit'] },
  file: { type: 'string' },
  line: { type: 'integer', minimum: 1 },
  title: { type: 'string' },
  problem: { type: 'string' },
  consequence: { type: 'string' },
  fix: { type: 'string' },
  evidence: { type: 'string' },
  confidence: { type: 'number', minimum: 0, maximum: 1 },
};
const findingRequired = Object.keys(findingProperties);

const specialistSchema = {
  type: 'object',
  properties: {
    findings: {
      type: 'array',
      items: { type: 'object', properties: findingProperties, required: findingRequired, additionalProperties: false },
    },
  },
  required: ['findings'],
  additionalProperties: false,
};

const synthesisSchema = {
  type: 'object',
  properties: {
    summary: { type: 'string' },
    verdict: { type: 'string', enum: ['approve', 'request-changes', 'comment'] },
    findings: {
      type: 'array',
      items: {
        type: 'object',
        properties: { ...findingProperties, reviewers: { type: 'array', items: { type: 'string' } } },
        required: [...findingRequired, 'reviewers'],
        additionalProperties: false,
      },
    },
  },
  required: ['summary', 'verdict', 'findings'],
  additionalProperties: false,
};

const selectionSchema = {
  type: 'object',
  properties: {
    add: { type: 'array', items: { type: 'object', properties: { reviewer: { type: 'string' }, reason: { type: 'string' } }, required: ['reviewer', 'reason'], additionalProperties: false } },
  },
  required: ['add'],
  additionalProperties: false,
};

export interface Charters {
  specialistPrompt: string;
  selectionPrompt: string;
  synthesisPrompt: string;
  reviewers: Map<string, string>;
}

export function loadCharters(root: string): Charters {
  const reviewers = new Map<string, string>();
  for (const name of readdirSync(path.join(root, 'reviewers')).filter((n) => n.endsWith('.md')).sort()) {
    reviewers.set(name.slice(0, -3), readFileSync(path.join(root, 'reviewers', name), 'utf8'));
  }
  const prompt = (name: string) => readFileSync(path.join(root, 'prompts', `${name}.md`), 'utf8');
  return { specialistPrompt: prompt('specialist'), selectionPrompt: prompt('selection'), synthesisPrompt: prompt('synthesis'), reviewers };
}

const securityPath = /(auth|crypt|jose|jwt|jwk|jws|jwe|token|secret|key|sign|password|oauth|oidc|openid|saml|serializ|pars|claim|session|cookie|cors|csrf)/i;
const testPath = /(^|\/)tests?\/|Tests?\.cs$|\.(test|spec)\.[a-z]+$/i;
const productCode = /\.(cs|fs|ts|tsx|js|py|go|rs|java|ps1|psm1)$/i;

// The reviewers every pull request gets from the paths it touches. Selection can add to these, never remove.
export function selectionFloor(files: ChangedFile[], hasDescription: boolean, hasReviewRules = false): string[] {
  const reviewed = files.filter((f) => !f.generated);
  const code = reviewed.filter((f) => productCode.test(f.path) && !testPath.test(f.path));
  const floor = new Set<string>(['hygiene']);
  if (code.length) floor.add('correctness');
  if (code.some((f) => securityPath.test(f.path))) floor.add('security');
  if (reviewed.some((f) => /(^|\/)PublicAPI\.[A-Za-z]+\.txt$/.test(f.path))) floor.add('api-compat');
  if (code.length && !reviewed.some((f) => testPath.test(f.path))) floor.add('tests');
  if (/(^|\/)Migrations\/|\.sql$/i.test(reviewed.map((f) => f.path).join('\n'))) floor.add('data-model');
  if (hasDescription && code.length) floor.add('intent');
  if (hasReviewRules) floor.add('conventions');
  // Duct tape and unfinished capabilities build up in changes big enough to have a design; a one-line fix rarely does.
  if (code.reduce((lines, f) => lines + f.additions + f.deletions, 0) >= architectureMinLines) {
    floor.add('architecture');
    floor.add('completeness');
  }
  return [...floor];
}

export const architectureMinLines = 60;

function pullRequestBlock(gathered: Gathered): string {
  const pr = gathered.pullRequest;
  const description = pr.body ? `\nDescription:\n${pr.body}` : '\n(No description, or its author lacks write access.)';
  const issues = (pr.issues ?? []).map((i) => `\nIssue #${i.number}, which it closes: ${i.title}\n${i.body}`).join('');
  const commits = gathered.commits.length ? `\nCommits:\n${gathered.commits.map((c) => `- ${c}`).join('\n')}` : '';
  return `<pull_request>\n#${pr.number}: ${pr.title}\nAuthor: ${pr.author}${description}${issues}${commits}\n</pull_request>`;
}

function fileList(gathered: Gathered): string {
  return gathered.files
    .map((f) => `${f.path} (+${f.additions} -${f.deletions})${f.generated ? ' [generated]' : ''}${f.shown ? '' : ' [diff not shown: over the size budget]'}`)
    .join('\n');
}

function changeContext(gathered: Gathered, diff: string): string {
  return [
    pullRequestBlock(gathered),
    `Changed files:\n${fileList(gathered)}`,
    `The diff against the merge base. The pull request's head is checked out at the path given below; use it to read whole files.\n<diff>\n${diff}\n</diff>`,
  ].join('\n\n');
}

function rulesBlock(rules: IndexedRule[] | undefined): string {
  if (!rules?.length) return '';
  return `\n\nReview rules for your charter that bear on this change, picked from NCodeGroup's guidance (learned from the organization's decisions, conventions and past reviews) and this repository's own conventions. Check the change against each one, and name the rule you apply in \`evidence\`.\n<review_rules>\n${rules.map((r) => r.text).join('\n')}\n</review_rules>`;
}

function decisionsBlock(decisions: Decision[]): string {
  if (!decisions.length) return '';
  const text = decisions.map((d) => `${d.id}: ${d.title}\n${d.decision}`).join('\n\n');
  return `\n\nDecisions this repository has accepted that bear on this change. Don't report what a decision deliberately accepts; do report code that breaks one, citing it.\n<decisions>\n${text}\n</decisions>`;
}

// The part every specialist shares, so the provider can cache it; each charter comes after it.
function sharedContext(gathered: Gathered, decisions: Decision[]): string {
  return `Conventions of this repository, from its default branch:\n<conventions>\n${gathered.conventions || '(none)'}\n</conventions>${decisionsBlock(decisions)}\n\n${changeContext(gathered, gathered.diff)}`;
}

export async function mapWithConcurrency<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index]!);
    }
  });
  await Promise.all(workers);
  return results;
}

// Lines a finding can sit on: lines the diff adds, per file. A finding elsewhere goes in the summary instead.
export function changedLines(diff: string): Map<string, Set<number>> {
  const lines = new Map<string, Set<number>>();
  let file: string | undefined;
  let line = 0;
  for (const text of diff.split('\n')) {
    const header = /^\+\+\+ b\/(.+)$/.exec(text);
    if (header) { file = header[1]!.trim(); lines.set(file, new Set()); continue; }
    if (text.startsWith('--- ')) continue;
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(text);
    if (hunk) { line = Number(hunk[1]); continue; }
    if (!file) continue;
    if (text.startsWith('+')) { lines.get(file)!.add(line); line++; }
    else if (text.startsWith(' ')) line++;
  }
  return lines;
}

export async function review(run: AgentRun, gathered: Gathered, charters: Charters, log: (line: string) => void): Promise<Review> {
  const calls: CallRecord[] = [];
  const roster = [...charters.reviewers.keys()];

  // Context: the rules and decisions that bear on this change.
  const catalog = [...guidanceRules(gathered.guidance), ...repositoryRules(gathered.reviewRules)];
  const { context, result: contextResult } = await selectContext(run, gathered, catalog, gathered.decisions, (g) =>
    `${pullRequestBlock(g)}\n\nChanged files:\n${fileList(g)}\n\n<diff>\n${g.diff.slice(0, 80_000)}\n</diff>`,
  );
  if (contextResult) calls.push(contextResult.record);
  const picked = [...new Set([...context.rulesFor.values()].flat())].length;
  log(`Context: ${picked} of ${catalog.length} rules, ${context.decisions.length} of ${gathered.decisions.length} decisions${contextResult?.error ? ` (failed: ${contextResult.error})` : ''}`);
  const shared = sharedContext(gathered, context.decisions);

  // Selection only routes, so Sonnet is enough, at about half Opus's cost.
  const hasRules = (context.rulesFor.get('conventions')?.length ?? 0) > 0;
  const floor = selectionFloor(gathered.files, Boolean(gathered.pullRequest.body), hasRules && charters.reviewers.has('conventions'));
  const selected = new Set(floor);
  const selection = await runAgent<{ add: { reviewer: string; reason: string }[] }>(
    { provider: run.provider, proxyUrl: run.proxyUrl },
    {
      role: 'selection',
      tier: 'sonnet',
      systemPrompt: charters.selectionPrompt,
      prompt: `Roster: ${roster.join(', ')}\nAlready chosen: ${floor.join(', ')}\n\n${pullRequestBlock(gathered)}\n\nChanged files:\n${fileList(gathered)}\n\n<diff>\n${gathered.diff.slice(0, 60_000)}\n</diff>`,
      schema: selectionSchema,
      maxTurns: 3,
      budgetUsd: budgets.selection,
      cache: false,
    },
  );
  calls.push(selection.record);
  for (const addition of selection.output?.add ?? []) {
    if (charters.reviewers.has(addition.reviewer)) selected.add(addition.reviewer);
  }
  log(`Reviewers: ${[...selected].join(', ')}${selection.error ? ` (selection failed: ${selection.error})` : ''}`);

  // Specialists, each with the picked rules for its charter. The part they share is the first block of every prompt;
  // one reviewer per model goes first and caches it, and the rest of that model's reviewers read the cache instead of
  // each writing it again.
  const tiers = reviewerTiers();
  const sharedBlock = `${shared}\n\nThe checkout is at: ${run.checkout}`;
  const reviewRun: AgentRun = { ...run, workdir: mkdtempSync(path.join(tmpdir(), 'code-review-work-')) };
  const jobs = [...selected].map((reviewer) => ({
    name: reviewer,
    tier: tiers[reviewer] ?? ('haiku' as ModelTier),
    prompt: [sharedBlock, `${rulesBlock(context.rulesFor.get(reviewer)).trimStart()}\n\nYour charter:\n${charters.reviewers.get(reviewer)!}`],
  }));
  const first = jobs.filter((job, i) => jobs.findIndex((other) => other.tier === job.tier) === i);
  const reviewOne = async ({ name, tier, prompt }: (typeof jobs)[number]): Promise<ReviewerOutcome> => {
    const result = await runAgent<{ findings: Finding[] }>(reviewRun, {
      role: `reviewer:${name}`,
      tier,
      systemPrompt: charters.specialistPrompt,
      prompt,
      schema: specialistSchema,
      maxTurns: maxTurns.specialist,
      budgetUsd: budgets.specialist[tier],
    });
    calls.push(result.record);
    const reported = result.output?.findings ?? [];
    const kept = reported.filter((f) => f.confidence >= minConfidence);
    log(`  ${name}: ${result.error ? `failed (${result.error})` : `${kept.length} findings${reported.length > kept.length ? ` (${reported.length - kept.length} below ${minConfidence} confidence dropped)` : ''}`} $${result.record.costUsd.toFixed(3)}`);
    return result.error ? { name, status: 'failed', findings: [], error: result.error } : { name, status: 'ran', findings: kept };
  };
  const outcomes = [
    ...(await mapWithConcurrency(first, 4, reviewOne)),
    ...(await mapWithConcurrency(jobs.filter((job) => !first.includes(job)), 4, reviewOne)),
  ];

  // Synthesis.
  const raw = outcomes.flatMap((o) => o.findings.map((f) => ({ reviewer: o.name, ...f })));
  let summary = '';
  let verdict: Verdict | undefined;
  let findings: ReviewedFinding[] = [];
  if (raw.length) {
    const synthesis = await runAgent<{ summary: string; verdict: Verdict; findings: (Finding & { reviewers: string[] })[] }>(
      { provider: run.provider, proxyUrl: run.proxyUrl },
      {
        role: 'synthesis',
        tier: 'opus',
        systemPrompt: charters.synthesisPrompt,
        prompt: `Limit: ${maxFindings} findings.\n\n${pullRequestBlock(gathered)}\n\n<diff>\n${gathered.diff.slice(0, 120_000)}\n</diff>\n\nFindings from the reviewers:\n<findings>\n${JSON.stringify(raw, null, 1)}\n</findings>`,
        schema: synthesisSchema,
        maxTurns: 3,
        budgetUsd: budgets.synthesis,
        cache: false,
      },
    );
    calls.push(synthesis.record);
    if (synthesis.output) {
      summary = synthesis.output.summary;
      verdict = synthesis.output.verdict;
      findings = synthesis.output.findings.slice(0, maxFindings).map((f, i) => ({ ...f, id: `F${i + 1}` }));
    } else {
      // Without synthesis, fall back to the reviewers' own findings, most severe first.
      const rank: Record<Severity, number> = { blocker: 0, 'should-fix': 1, nit: 2 };
      summary = `Synthesis failed (${synthesis.error}); these are the reviewers' unmerged findings.`;
      findings = raw
        .sort((a, b) => rank[a.severity] - rank[b.severity] || b.confidence - a.confidence)
        .slice(0, maxFindings)
        .map(({ reviewer, ...f }, i) => ({ ...f, reviewers: [reviewer], id: `F${i + 1}` }));
    }
  } else {
    summary = 'No findings.';
  }

  const skipped = roster.filter((name) => !selected.has(name));
  verdict ??= findings.some((f) => f.severity === 'blocker') ? 'request-changes' : findings.length ? 'comment' : 'approve';
  return { reviewers: outcomes, summary, verdict, findings, calls, skipped };
}

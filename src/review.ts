// Stages 2, 3 and 6 of the baseline: selection, specialists and synthesis.

import { mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { runAgent, type AgentRun, type CallRecord } from './agent.ts';
import { budgets, findingsPerExtraChunk, maxFindings, maxFindingsCap, maxTurns, minConfidence, reviewerTiers, ruleChecksOn, rulesPerCheck, type ModelTier } from './config.ts';
import { guidanceRules, repositoryRules, selectContext, type Decision, type IndexedRule } from './context.ts';
import { globToRegExp, splitDiff, type ChangedFile, type Gathered } from './gather.ts';
import type { ProjectCharter } from './settings.ts';

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
        // The ids of the reviewers' findings this one merges.
        properties: { ...findingProperties, sources: { type: 'array', items: { type: 'string' } } },
        required: [...findingRequired, 'sources'],
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
  ruleCheckPrompt: string;
  reviewers: Map<string, string>;
}

// The rules the context stage picked for any reviewer, once each and in catalog order so a topic's rules share a batch,
// in batches for the rule checks.
export function ruleBatches(catalog: IndexedRule[], rulesFor: Map<string, IndexedRule[]>, size: number): IndexedRule[][] {
  const picked = new Set([...rulesFor.values()].flat().map((r) => r.id));
  const rules = catalog.filter((r) => picked.has(r.id));
  const batches: IndexedRule[][] = [];
  for (let i = 0; i < rules.length; i += size) batches.push(rules.slice(i, i + size));
  return batches;
}

export function loadCharters(root: string): Charters {
  const reviewers = new Map<string, string>();
  for (const name of readdirSync(path.join(root, 'reviewers')).filter((n) => n.endsWith('.md')).sort()) {
    reviewers.set(name.slice(0, -3), readFileSync(path.join(root, 'reviewers', name), 'utf8'));
  }
  const prompt = (name: string) => readFileSync(path.join(root, 'prompts', `${name}.md`), 'utf8');
  return {
    specialistPrompt: prompt('specialist'),
    selectionPrompt: prompt('selection'),
    synthesisPrompt: prompt('synthesis'),
    ruleCheckPrompt: prompt('rule-check'),
    reviewers,
  };
}

export const projectPrefix = 'project:';

// The engine's charters with the repository's own reviewers added as project:<name>. An engine charter is never
// replaced by a project one.
export function withProjectCharters(charters: Charters, project: ProjectCharter[]): Charters {
  const reviewers = new Map(charters.reviewers);
  for (const charter of project) {
    const name = `${projectPrefix}${charter.name}`;
    if (!reviewers.has(name)) reviewers.set(name, charter.text);
  }
  return { ...charters, reviewers };
}

// The project reviewers whose paths: match a reviewed file, which join the floor.
export function projectFloor(project: ProjectCharter[], files: ChangedFile[]): string[] {
  const reviewed = files.filter((f) => !f.generated).map((f) => f.path);
  return project
    .filter((charter) => charter.paths.map(globToRegExp).some((p) => reviewed.some((file) => p.test(file))))
    .map((charter) => `${projectPrefix}${charter.name}`);
}

// What each project reviewer looks at, for selection: the roster's engine names say it, a project's may not.
function projectRoster(project: ProjectCharter[]): string {
  if (!project.length) return '';
  const describe = (text: string) => {
    const line = text.split('\n').map((l) => l.trim()).find((l) => l && !l.startsWith('#')) ?? '';
    return line.length > 200 ? `${line.slice(0, 199)}…` : line;
  };
  return `\nThis repository's own reviewers:\n${project.map((c) => `- ${projectPrefix}${c.name}: ${describe(c.text)}`).join('\n')}`;
}

const securityPath = /(auth|crypt|jose|jwt|jwk|jws|jwe|token|secret|key|sign|password|oauth|oidc|openid|saml|serializ|pars|claim|session|cookie|cors|csrf|iam|role|policy|kms|trust|firewall)/i;
const testPath = /(^|\/)tests?\/|Tests?\.cs$|\.(test|spec)\.[a-z]+$/i;
const productCode = /\.(cs|fs|ts|tsx|js|py|go|rs|java|ps1|psm1|tf|tofu|hcl)$/i;
const infrastructurePath = /\.(tf|tofu|tfvars|hcl)$/i;

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
  if (reviewed.some((f) => infrastructurePath.test(f.path))) floor.add('infrastructure');
  if (hasReviewRules) floor.add('conventions');
  // Duct tape and unfinished capabilities build up in changes big enough to have a design; a one-line fix rarely does.
  if (code.reduce((lines, f) => lines + f.additions + f.deletions, 0) >= architectureMinLines) {
    floor.add('architecture');
    floor.add('completeness');
  }
  return [...floor];
}

export const architectureMinLines = 60;

// The rule checks report as one reviewer, outside the roster so selection never adds or skips them.
export const ruleCheckName = 'rule-check';

function pullRequestBlock(gathered: Gathered): string {
  const pr = gathered.pullRequest;
  const description = pr.body ? `\nDescription:\n${pr.body}` : '\n(No description, or its author lacks write access.)';
  const issues = (pr.issues ?? []).map((i) => `\nIssue #${i.number}, which it closes: ${i.title}\n${i.body}`).join('');
  const commits = gathered.commits.length ? `\nCommits:\n${gathered.commits.map((c) => `- ${c}`).join('\n')}` : '';
  return `<pull_request>\n#${pr.number}: ${pr.title}\nAuthor: ${pr.author}${description}${issues}${commits}\n</pull_request>`;
}

function fileList(gathered: Gathered): string {
  return [
    ...gathered.files.map((f) => `${f.path} (+${f.additions} -${f.deletions})${f.generated ? ' [generated]' : ''}${f.shown ? '' : ' [diff not shown: over the size budget]'}`),
    ...(gathered.skippedByConfig ?? []).map((f) => `${f} [not reviewed: skipped by the repository's config]`),
  ].join('\n');
}

function changeContext(gathered: Gathered, diff: string, part: number, parts: number): string {
  const scope = parts > 1
    ? ` This pull request is too large for one review, so its diff is reviewed in ${parts} parts and this is part ${part + 1}. Review the files in this part's diff; other reviewers have the rest. Read any other file when you need its context.`
    : '';
  return [
    pullRequestBlock(gathered),
    `Changed files:\n${fileList(gathered)}`,
    `The diff against the merge base. The pull request's head is checked out at the path given below; use it to read whole files.${scope}\n<diff>\n${diff}\n</diff>`,
  ].join('\n\n');
}

function rulesBlock(rules: IndexedRule[] | undefined): string {
  if (!rules?.length) return '';
  return `\n\nReview rules for your charter that bear on this change, picked from NCodeGroup's guidance (learned from the organization's decisions, conventions and past reviews) and this repository's own conventions. Check the change against each one, and name the rule you apply in \`evidence\`.\n<review_rules>\n${rules.map((r) => r.text).join('\n')}\n</review_rules>`;
}

function decisionsBlock(decisions: Decision[]): string {
  if (!decisions.length) return '';
  const text = decisions.map((d) => `${d.id}: ${d.title}${d.proposed ? ' (added or changed by this pull request)' : ''}\n${d.decision}`).join('\n\n');
  return `\n\nDecisions this repository has accepted that bear on this change. Don't report what a decision deliberately accepts, including what its consequences accept; do report code that breaks one, citing it. A decision this pull request adds or changes is part of the change: what it accepts isn't a defect in the code, but you may question the decision itself.\n<decisions>\n${text}\n</decisions>`;
}

// The part every specialist on one part of the diff shares, so the provider can cache it; each charter comes after it.
function sharedContext(gathered: Gathered, decisions: Decision[], diff: string, part: number, parts: number): string {
  return `Conventions of this repository, from its default branch:\n<conventions>\n${gathered.conventions || '(none)'}\n</conventions>${decisionsBlock(decisions)}\n\n${changeContext(gathered, diff, part, parts)}`;
}

// The limit on posted findings: higher for a pull request reviewed in parts.
export function findingLimit(parts: number): number {
  return Math.min(maxFindingsCap, maxFindings + findingsPerExtraChunk * Math.max(0, parts - 1));
}

// What synthesis sees of the diff: the files the findings name, then the start of the diff, within the budget.
function synthesisDiff(gathered: Gathered, files: string[], budget: number): string {
  const sections = splitDiff(gathered.diff);
  let out = '';
  for (const file of new Set(files)) {
    const section = sections.get(file);
    if (section && out.length + section.length <= budget) out += section;
  }
  return out || gathered.diff.slice(0, budget);
}

const severityRank: Record<Severity, number> = { blocker: 0, 'should-fix': 1, nit: 2 };

// Synthesis merges and ranks but never drops: a reviewer's finding no merged finding names as a source is added back
// after them, most severe first, so the maintainer sees it and decides. A source in another file isn't a duplicate, so
// naming it doesn't count.
export function mergeSynthesis(
  merged: (Finding & { sources: string[] })[],
  raw: (Finding & { id: string; reviewer: string })[],
  limit: number,
): ReviewedFinding[] {
  const byId = new Map(raw.map((f) => [f.id, f]));
  for (const f of merged) f.sources = f.sources.filter((id) => byId.get(id)?.file === f.file);
  const covered = new Set(merged.flatMap((f) => f.sources));
  const missed = raw
    .filter((f) => !covered.has(f.id))
    .sort((a, b) => severityRank[a.severity] - severityRank[b.severity] || b.confidence - a.confidence);
  const out = [
    ...merged.map(({ sources, ...f }) => ({ ...f, reviewers: [...new Set(sources.flatMap((id) => (byId.has(id) ? [byId.get(id)!.reviewer] : [])))] })),
    ...missed.map(({ id: _id, reviewer, ...f }) => ({ ...f, reviewers: [reviewer] })),
  ];
  return out.slice(0, limit).map((f, i) => ({ ...f, id: `F${i + 1}` }));
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

export async function review(run: AgentRun, gathered: Gathered, engineCharters: Charters, log: (line: string) => void): Promise<Review> {
  const calls: CallRecord[] = [];
  const project = gathered.projectReviewers ?? [];
  const charters = withProjectCharters(engineCharters, project);
  const roster = [...charters.reviewers.keys()];

  // Context: the rules and decisions that bear on this change.
  const catalog = [...guidanceRules(gathered.guidance), ...repositoryRules(gathered.reviewRules)];
  const { context, result: contextResult } = await selectContext(run, gathered, catalog, gathered.decisions, (g) =>
    `${pullRequestBlock(g)}\n\nChanged files:\n${fileList(g)}\n\n<diff>\n${g.diff.slice(0, 80_000)}\n</diff>`,
  );
  if (contextResult) calls.push(contextResult.record);
  const picked = [...new Set([...context.rulesFor.values()].flat())].length;
  log(`Context: ${picked} of ${catalog.length} rules, ${context.decisions.length} of ${gathered.decisions.length} decisions${contextResult?.error ? ` (failed: ${contextResult.error})` : ''}`);

  // Selection only routes, so Sonnet is enough, at about half Opus's cost.
  const hasRules = (context.rulesFor.get('conventions')?.length ?? 0) > 0;
  const floor = [...new Set([
    ...selectionFloor(gathered.files, Boolean(gathered.pullRequest.body), hasRules && charters.reviewers.has('conventions')),
    ...projectFloor(project, gathered.files),
  ])];
  const selected = new Set(floor);
  const selection = await runAgent<{ add: { reviewer: string; reason: string }[] }>(
    { provider: run.provider, proxyUrl: run.proxyUrl },
    {
      role: 'selection',
      tier: 'sonnet',
      systemPrompt: charters.selectionPrompt,
      prompt: `Roster: ${roster.join(', ')}${projectRoster(project)}\nAlready chosen: ${floor.join(', ')}\n\n${pullRequestBlock(gathered)}\n\nChanged files:\n${fileList(gathered)}\n\n<diff>\n${gathered.diff.slice(0, 60_000)}\n</diff>`,
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

  // Specialists, each with the picked rules for its charter, and each part of the diff with its own set of them. The
  // part of the prompt they share is its first block; one reviewer per model and part goes first and caches it, and the
  // rest read the cache instead of each writing it again.
  const tiers = reviewerTiers(undefined, gathered.tiers ?? {});
  const parts = gathered.chunks.length ? gathered.chunks : [gathered.diff];
  const reviewRun: AgentRun = { ...run, workdir: mkdtempSync(path.join(tmpdir(), 'code-review-work-')) };
  const batches = ruleChecksOn() ? ruleBatches(catalog, context.rulesFor, rulesPerCheck) : [];
  const jobs = parts.flatMap((diff, part) => {
    const sharedBlock = `${sharedContext(gathered, context.decisions, diff, part, parts.length)}\n\nThe checkout is at: ${run.checkout}`;
    return [
      ...[...selected].map((reviewer) => ({
        name: reviewer,
        part,
        label: '',
        tier: tiers[reviewer] ?? ('haiku' as ModelTier),
        prompt: [sharedBlock, `${rulesBlock(context.rulesFor.get(reviewer)).trimStart()}\n\nYour charter:\n${charters.reviewers.get(reviewer)!}`],
      })),
      ...batches.map((batch, i) => ({
        name: ruleCheckName,
        part,
        label: `rules ${i * rulesPerCheck + 1}-${i * rulesPerCheck + batch.length}`,
        tier: 'sonnet' as ModelTier,
        prompt: [sharedBlock, `${rulesBlock(batch).trimStart()}\n\nYour charter:\n${charters.ruleCheckPrompt}`],
      })),
    ];
  });
  const first = jobs.filter((job, i) => jobs.findIndex((other) => other.tier === job.tier && other.part === job.part) === i);
  const reviewOne = async ({ name, part, label, tier, prompt }: (typeof jobs)[number]): Promise<ReviewerOutcome> => {
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
    const where = [parts.length > 1 ? `part ${part + 1}` : '', label].filter(Boolean).join(', ');
    log(`  ${name}${where ? ` (${where})` : ''}: ${result.error ? `failed (${result.error})` : `${kept.length} findings${reported.length > kept.length ? ` (${reported.length - kept.length} below ${minConfidence} confidence dropped)` : ''}`} $${result.record.costUsd.toFixed(3)}`);
    return result.error ? { name, status: 'failed', findings: [], error: result.error } : { name, status: 'ran', findings: kept };
  };
  const concurrency = 6;
  const perJob = [
    ...(await mapWithConcurrency(first, concurrency, reviewOne)),
    ...(await mapWithConcurrency(jobs.filter((job) => !first.includes(job)), concurrency, reviewOne)),
  ];
  // One outcome per reviewer across the parts and rule batches: it ran if any of its calls ran.
  const outcomes: ReviewerOutcome[] = [...selected, ...(batches.length ? [ruleCheckName] : [])].map((name) => {
    const mine = perJob.filter((o) => o.name === name);
    const errors = mine.flatMap((o) => (o.error ? [o.error] : []));
    return {
      name,
      status: mine.some((o) => o.status === 'ran') ? 'ran' : 'failed',
      findings: mine.flatMap((o) => o.findings),
      ...(errors.length ? { error: errors.join('; ') } : {}),
    };
  });

  // Synthesis.
  const limit = findingLimit(parts.length);
  const raw = outcomes.flatMap((o) => o.findings.map((f) => ({ reviewer: o.name, ...f }))).map((f, i) => ({ id: `R${i + 1}`, ...f }));
  let summary = '';
  let verdict: Verdict | undefined;
  let findings: ReviewedFinding[] = [];
  if (raw.length) {
    const diff = synthesisDiff(gathered, raw.map((f) => f.file), 120_000);
    const synthesis = await runAgent<{ summary: string; verdict: Verdict; findings: (Finding & { sources: string[] })[] }>(
      { provider: run.provider, proxyUrl: run.proxyUrl },
      {
        role: 'synthesis',
        tier: 'opus',
        systemPrompt: charters.synthesisPrompt,
        prompt: `Limit: ${limit} findings.\n\n${pullRequestBlock(gathered)}\n\n<diff>\n${diff}\n</diff>\n\nFindings from the reviewers:\n<findings>\n${JSON.stringify(raw, null, 1)}\n</findings>`,
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
      findings = mergeSynthesis(synthesis.output.findings, raw, limit);
    } else {
      // Without synthesis, fall back to the reviewers' own findings, most severe first.
      summary = `Synthesis failed (${synthesis.error}); these are the reviewers' unmerged findings.`;
      findings = mergeSynthesis([], raw, limit);
    }
  } else {
    summary = 'No findings.';
  }

  const skipped = roster.filter((name) => !selected.has(name));
  verdict ??= findings.some((f) => f.severity === 'blocker') ? 'request-changes' : findings.length ? 'comment' : 'approve';
  return { reviewers: outcomes, summary, verdict, findings, calls, skipped };
}

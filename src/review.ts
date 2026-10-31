// Stages 2, 3 and 6 of the baseline: selection, specialists and synthesis.

import { mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { runAgent, type AgentRun, type CallRecord } from './agent.ts';
import { budgets, findingsPerExtraChunk, maxFindings, maxFindingsCap, maxTurns, maxUpstreamFindings, minConfidence, reviewerTiers, ruleChecksOn, rulesPerCheck, type ModelTier } from './config.ts';
import { guidanceRules, repositoryRules, selectContext, type Decision, type IndexedRule } from './context.ts';
import { splitDiff, type ChangedFile, type Gathered } from './gather.ts';
import { isTemplateOwned, type Template } from './template.ts';

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
  // Findings on the template's files: they belong in the template's repository, not in threads on this pull request.
  upstream: ReviewedFinding[];
  // Places on the template's files past the upstream list's limit.
  upstreamOmitted: number;
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

const securityPath = /(auth|crypt|jose|jwt|jwk|jws|jwe|token|secret|key|sign|password|oauth|oidc|openid|saml|serializ|pars|claim|session|cookie|cors|csrf|iam|role|policy|kms|trust|firewall)/i;
const testPath = /(^|\/)tests?\/|Tests?\.cs$|\.(test|spec)\.[a-z]+$/i;
const productCode = /\.(cs|fs|ts|tsx|js|py|go|rs|java|ps1|psm1|tf|tofu|hcl)$/i;
const infrastructurePath = /\.(tf|tofu|tfvars|hcl)$/i;

// The reviewers every pull request gets from the paths it touches. Selection can add to these, never remove. The
// template's files don't count: they aren't this repository's code to test or redesign.
export function selectionFloor(files: ChangedFile[], hasDescription: boolean, hasReviewRules = false): string[] {
  const reviewed = files.filter((f) => !f.generated && !f.templateOwned);
  const code = reviewed.filter((f) => productCode.test(f.path) && !testPath.test(f.path));
  const floor = new Set<string>(['hygiene']);
  if (code.length) floor.add('correctness');
  if (code.some((f) => securityPath.test(f.path))) floor.add('security');
  if (reviewed.some((f) => /(^|\/)PublicAPI\.[A-Za-z]+\.txt$/.test(f.path))) floor.add('api-compat');
  if (code.length && !reviewed.some((f) => testPath.test(f.path))) floor.add('tests');
  if (reviewed.some((f) => /(^|\/)Migrations\//i.test(f.path) || /\.sql$/i.test(f.path))) floor.add('data-model');
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
  return gathered.files
    .map((f) => `${f.path} (+${f.additions} -${f.deletions})${f.generated ? ' [generated]' : ''}${f.templateOwned ? ' [template-owned]' : ''}${f.shown ? '' : ' [diff not shown: over the size budget]'}`)
    .join('\n');
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

// Tells the reviewers which changed files are the template's, and that a template adoption or update is still reviewed
// for what the project chose.
export function templateBlock(gathered: Gathered): string {
  const template = gathered.template;
  if (!template || !gathered.files.some((f) => f.templateOwned)) return '';
  return `\n\nThis repository is made from the project template ${template.repository}${template.commit ? ` (${template.commit})` : ''}. The changed files marked [template-owned] are the template's: a template update replaces them and discards any edit, so this repository can't fix them. Don't review them as this repository's code: don't ask for tests of them here, and don't report their style, comments or wording. Report a defect in one only when it's a real bug in the template; it goes on a list for ${template.repository}, not on this pull request. A blocker stays on this pull request: report one when a change in these files makes the change unsafe to merge, such as a hook, script or agent prompt that leaks secrets, weakens a check or runs code from outside the repository. Every other file is the project's, so review it as usual, including what the project chose when it adopted or updated the template: its answers in .copier-answers.yml, the files it merges with the template's (such as .gitignore, .gitattributes, editor and tool settings and the workflows), AGENTS.md, and its own files.`;
}

// The part every specialist on one part of the diff shares, so the provider can cache it; each charter comes after it.
function sharedContext(gathered: Gathered, decisions: Decision[], diff: string, part: number, parts: number): string {
  return `Conventions of this repository, from its default branch:\n<conventions>\n${gathered.conventions || '(none)'}\n</conventions>${decisionsBlock(decisions)}${templateBlock(gathered)}\n\n${changeContext(gathered, diff, part, parts)}`;
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

// Splits findings into the repository's own, which become threads, and the template's, which belong upstream. A blocker
// stays on the pull request even in the template's file: it makes the change unsafe to merge, whoever has to fix it.
export function byOwner<T extends Pick<Finding, 'file' | 'severity'>>(findings: T[], template: Template | undefined): { own: T[]; upstream: T[] } {
  const upstream = (f: T) => f.severity !== 'blocker' && isTemplateOwned(f.file, template);
  return { own: findings.filter((f) => !upstream(f)), upstream: findings.filter(upstream) };
}

// The findings on the template's files, for the summary's list for the template's repository: one per file and line,
// keeping the most severe and naming every reviewer that raised it. The list stops at maxUpstreamFindings; omitted
// counts the places past it.
export function upstreamFindings(findings: (Finding & { reviewers: string[] })[]): { upstream: ReviewedFinding[]; omitted: number } {
  const byPlace = new Map<string, Finding & { reviewers: string[] }>();
  const ranked = [...findings].sort((a, b) => severityRank[a.severity] - severityRank[b.severity] || b.confidence - a.confidence);
  for (const f of ranked) {
    const key = `${f.file}:${f.line}`;
    const kept = byPlace.get(key);
    if (kept) kept.reviewers = [...new Set([...kept.reviewers, ...f.reviewers])];
    else byPlace.set(key, { ...f, reviewers: [...f.reviewers] });
  }
  const places = [...byPlace.values()];
  return {
    upstream: places.slice(0, maxUpstreamFindings).map((f, i) => ({ ...f, id: `U${i + 1}` })),
    omitted: Math.max(0, places.length - maxUpstreamFindings),
  };
}

// After synthesis, which may still place a finding in one of the template's files: moves those to the upstream list,
// renumbers the rest, and, when only the template's findings remain, says so in the summary.
export function settleUpstream(
  findings: ReviewedFinding[],
  upstreamRaw: (Finding & { reviewers: string[] })[],
  template: Template | undefined,
  summary: string,
): { findings: ReviewedFinding[]; upstream: ReviewedFinding[]; upstreamOmitted: number; summary: string } {
  const placed = byOwner(findings, template);
  const own = placed.own.map((f, i) => ({ ...f, id: `F${i + 1}` }));
  const { upstream, omitted } = upstreamFindings([...upstreamRaw, ...placed.upstream]);
  const total = upstream.length + omitted;
  return {
    findings: own,
    upstream,
    upstreamOmitted: omitted,
    summary: !own.length && total ? `No findings in this repository's own files; ${total} in the template's belong upstream, in ${template!.repository}.` : summary,
  };
}

const verdictRank: Record<Verdict, number> = { approve: 0, comment: 1, 'request-changes': 2 };

// The review's verdict: synthesis's when it gave one, else what the findings call for. When settling moved some of
// synthesis's findings upstream, its verdict may rest on them, so it's capped at what the findings left here call for.
export function settledVerdict(synthesized: Verdict | undefined, movedUpstream: boolean, findings: Pick<Finding, 'severity'>[]): Verdict {
  const called: Verdict = findings.some((f) => f.severity === 'blocker') ? 'request-changes' : findings.length ? 'comment' : 'approve';
  if (!synthesized) return called;
  return movedUpstream && verdictRank[called] < verdictRank[synthesized] ? called : synthesized;
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

  // Specialists, each with the picked rules for its charter, and each part of the diff with its own set of them. The
  // part of the prompt they share is its first block; one reviewer per model and part goes first and caches it, and the
  // rest read the cache instead of each writing it again.
  const tiers = reviewerTiers();
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
  // Findings on the template's files skip synthesis: they're listed for the template's repository instead.
  const split = byOwner(outcomes.flatMap((o) => o.findings.map((f) => ({ reviewer: o.name, ...f }))), gathered.template);
  const raw = split.own.map((f, i) => ({ id: `R${i + 1}`, ...f }));
  const upstreamRaw: (Finding & { reviewers: string[] })[] = split.upstream.map(({ reviewer, ...f }) => ({ ...f, reviewers: [reviewer] }));
  let summary = '';
  let synthesized: Verdict | undefined;
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
      synthesized = synthesis.output.verdict;
      findings = mergeSynthesis(synthesis.output.findings, raw, limit);
    } else {
      // Without synthesis, fall back to the reviewers' own findings, most severe first.
      summary = `Synthesis failed (${synthesis.error}); these are the reviewers' unmerged findings.`;
      findings = mergeSynthesis([], raw, limit);
    }
  } else {
    summary = 'No findings.';
  }
  // Synthesis may still place a finding in a template's file.
  const settled = settleUpstream(findings, upstreamRaw, gathered.template, summary);

  const skipped = roster.filter((name) => !selected.has(name));
  const verdict = settledVerdict(synthesized, settled.findings.length < findings.length, settled.findings);
  return { reviewers: outcomes, summary: settled.summary, verdict, findings: settled.findings, upstream: settled.upstream, upstreamOmitted: settled.upstreamOmitted, calls, skipped };
}

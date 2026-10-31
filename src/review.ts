// Stages 2, 3 and 6 of the baseline: selection, specialists and synthesis, then verification when it's on.

import { mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { runAgent, type AgentRun, type CallRecord } from './agent.ts';
import { mapWithConcurrency } from './concurrency.ts';
import { budgets, deepReviewerTiers, findingsPerExtraChunk, lightReviewerTiers, maxFindings, maxFindingsCap, maxTurns, minConfidence, reviewerTiers, ruleChecksOn, rulesPerCheck, runCeiling, verificationOn, type ModelTier } from './config.ts';
import { guidanceRules, repositoryRules, selectContext, type Context, type Decision, type IndexedRule } from './context.ts';
import { globToRegExp, isDocumentation, splitDiff, type ChangedFile, type Gathered } from './gather.ts';
import { settingsFolder, type ProjectCharter } from './settings.ts';
import { verifyReview, type RefutedFinding, type VerificationCall } from './verify.ts';

export type Severity = 'blocker' | 'should-fix' | 'nit';
// Most severe first.
export const severityRank: Record<Severity, number> = { blocker: 0, 'should-fix': 1, nit: 2 };

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
  // Skipped: the run's cost ceiling was reached before any of the reviewer's calls started.
  status: 'ran' | 'failed' | 'skipped';
  findings: Finding[];
  error?: string;
}

export type Verdict = 'approve' | 'request-changes' | 'comment';

// How deep a review goes: deep for a change to a sensitive path, light for one to documentation only.
export type ReviewDepth = 'standard' | 'deep' | 'light';

export interface Review {
  reviewers: ReviewerOutcome[];
  summary: string;
  verdict: Verdict;
  findings: ReviewedFinding[];
  // Findings verification refuted and dropped, with its reasons, and every verification call.
  refuted: RefutedFinding[];
  verification: VerificationCall[];
  calls: CallRecord[];
  // Roster reviewers the path rules and selection didn't choose.
  skipped: string[];
  // What in the repository's settings the review couldn't use, beside gather's warnings, for the check run.
  warnings: string[];
  depth: ReviewDepth;
  // The changed files config.yml's sensitive: names, which made the review deep.
  sensitiveFiles: string[];
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
  verificationPrompt: string;
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
    verificationPrompt: prompt('verification'),
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
export function projectRoster(project: ProjectCharter[]): string {
  if (!project.length) return '';
  const describe = (text: string) => {
    const line = text.split('\n').map((l) => l.trim()).find((l) => l && !l.startsWith('#')) ?? '';
    return line.length > 200 ? `${line.slice(0, 199)}…` : line;
  };
  return `\nThis repository's own reviewers:\n${project.map((c) => `- ${projectPrefix}${c.name}: ${describe(c.text)}`).join('\n')}`;
}

// A warning for the tiers: names that match no reviewer on the roster, such as a misspelled one, which would
// otherwise change no model without a word.
export function unknownTiers(tiers: Record<string, ModelTier>, roster: string[]): string | undefined {
  const unknown = Object.keys(tiers).filter((name) => !roster.includes(name));
  if (!unknown.length) return undefined;
  return `"tiers" in ${settingsFolder}/config.yml names no reviewer: ${unknown.join(', ')}; the reviewers are ${roster.join(', ')}.`;
}

const securityPath = /(auth|crypt|jose|jwt|jwk|jws|jwe|token|secret|key|sign|password|oauth|oidc|openid|saml|serializ|pars|claim|session|cookie|cors|csrf|iam|role|policy|kms|trust|firewall)/i;
const testPath = /(^|\/)tests?\/|Tests?\.cs$|\.(test|spec)\.[a-z]+$/i;
const productCode = /\.(cs|fs|ts|tsx|js|py|go|rs|java|ps1|psm1|tf|tofu|hcl)$/i;
const infrastructurePath = /\.(tf|tofu|tfvars|hcl)$/i;
const publicApiPath = /(^|\/)PublicAPI\.[A-Za-z]+\.txt$/;

// A file is sensitive when a glob from config.yml's sensitive: matches it.
export function sensitiveMatcher(globs: string[]): (file: string) => boolean {
  const patterns = globs.map(globToRegExp);
  return (file) => patterns.some((p) => p.test(file));
}

// The changed files config.yml's sensitive: names, generated ones aside.
export function sensitiveFiles(files: ChangedFile[], globs: string[]): string[] {
  const sensitive = sensitiveMatcher(globs);
  return files.filter((f) => !f.generated && sensitive(f.path)).map((f) => f.path);
}

// A template update changes one of these, and with them only files the project template owns and replaces on every
// update, as its instructions list them.
const templateVersion = /^(\.template-version|\.copier-answers\.yml)$/;
const templateOwned = [
  templateVersion,
  /^\.template\//,
  /^\.githooks\/commit-msg$/,
  /^CLAUDE\.md$/,
  /^\.claude\/(agents\/plan-executor\.md$|commands\/)/,
  /^\.github\/(agents|prompts|skills)\//,
  /^\.github\/instructions\/project-template\.instructions\.md$/,
];

// A pull request that changes only documentation: every changed file is documentation (gather's pattern, which takes
// in CHANGELOG.md), or, in a template update, a file the template owns. A public API listing is a .txt file, but it is
// the API, so it isn't documentation.
export function documentationOnly(files: ChangedFile[]): boolean {
  if (!files.length) return false;
  const templateUpdate = files.some((f) => templateVersion.test(f.path));
  return files.every((f) =>
    !publicApiPath.test(f.path) && (isDocumentation(f.path) || (templateUpdate && templateOwned.some((p) => p.test(f.path)))));
}

// Deep when any changed file is sensitive, even documentation in a sensitive folder; light when the change is only
// documentation; standard otherwise. A small code change gets the standard review: the light review is for changes
// with no code in them, never to save on reviewers that catch real problems.
export function reviewDepth(files: ChangedFile[], sensitive: string[]): ReviewDepth {
  if (sensitiveFiles(files, sensitive).length) return 'deep';
  if (documentationOnly(files)) return 'light';
  return 'standard';
}

// The parts of the diff a deep review's reviewers go deep on: those with a sensitive file in them. A sensitive file
// too big for any part goes to the first, whose reviewers can read it in the checkout.
export function sensitiveParts(parts: string[], files: string[]): Set<number> {
  if (!files.length) return new Set();
  const indexes = parts.flatMap((diff, i) => ([...splitDiff(diff).keys()].some((file) => files.includes(file)) ? [i] : []));
  return new Set(indexes.length ? indexes : [0]);
}

// Each reviewer's model on one part of the diff. On a deep review's sensitive parts, correctness and security go to
// Opus over the repository's tiers:; CODE_REVIEW_TIERS still overrides any reviewer, and anyone unnamed runs on Haiku.
export function partTiers(depth: ReviewDepth, deepPart: boolean, repository: Record<string, ModelTier>, override?: string): Record<string, ModelTier> {
  const tiers = depth === 'light' ? lightReviewerTiers : depth === 'deep' && deepPart ? deepReviewerTiers : {};
  return reviewerTiers(override, repository, tiers);
}

// The reviewers every pull request gets from the paths it touches. Selection can add to these, never remove.
export function selectionFloor(files: ChangedFile[], hasDescription: boolean, hasReviewRules = false): string[] {
  const reviewed = files.filter((f) => !f.generated);
  const code = reviewed.filter((f) => productCode.test(f.path) && !testPath.test(f.path));
  const floor = new Set<string>(['hygiene']);
  if (code.length) floor.add('correctness');
  if (code.some((f) => securityPath.test(f.path))) floor.add('security');
  if (reviewed.some((f) => publicApiPath.test(f.path))) floor.add('api-compat');
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

export function fileList(gathered: Gathered): string {
  return [
    ...gathered.files.map((f) => `${f.path} (+${f.additions} -${f.deletions})${f.generated ? ' [generated]' : ''}${f.shown ? '' : ' [diff not shown: over the size budget]'}`),
    ...gathered.skippedByConfig.map((f) => `${f} [not reviewed: skipped by the repository's config]`),
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

// Why a reviewer call that never started was skipped, in the check run.
export const runBudgetReason = 'run budget';

export async function review(
  run: AgentRun,
  gathered: Gathered,
  engineCharters: Charters,
  log: (line: string) => void,
  agent: typeof runAgent = runAgent,
): Promise<Review> {
  const calls: CallRecord[] = [];
  const spent = () => calls.reduce((sum, c) => sum + c.costUsd, 0);
  const project = gathered.projectReviewers;
  const charters = withProjectCharters(engineCharters, project);
  const roster = [...charters.reviewers.keys()];
  const unknown = unknownTiers(gathered.tiers, roster);
  const warnings = unknown ? [unknown] : [];
  const sensitive = sensitiveFiles(gathered.files, gathered.sensitive);
  const depth = reviewDepth(gathered.files, gathered.sensitive);
  const light = depth === 'light';

  // A pull request whose every changed file the repository's skip: leaves out has nothing to review: no model runs.
  if (!gathered.files.length && gathered.skippedByConfig.length) {
    log('Every changed file is skipped by config; nothing to review');
    return {
      reviewers: [],
      summary: `Nothing was reviewed: every changed file is skipped by \`skip:\` in \`${settingsFolder}/config.yml\`.`,
      verdict: 'comment',
      findings: [],
      refuted: [],
      verification: [],
      calls,
      skipped: roster,
      warnings,
      depth,
      sensitiveFiles: sensitive,
    };
  }
  if (depth === 'deep') log(`Deep review: sensitive files ${sensitive.join(', ')}`);
  if (light) log('Light review (documentation only): hygiene alone, with no context, selection or synthesis');

  // Context: the rules and decisions that bear on this change. A light review has none, beside the decision records
  // the pull request itself adds or changes.
  const catalog = light ? [] : [...guidanceRules(gathered.guidance), ...repositoryRules(gathered.reviewRules)];
  let context: Context = { rulesFor: new Map(), decisions: gathered.decisions.filter((d) => d.proposed) };
  if (!light) {
    const picked = await selectContext(
      run,
      gathered,
      catalog,
      gathered.decisions,
      (g) => `${pullRequestBlock(g)}\n\nChanged files:\n${fileList(g)}\n\n<diff>\n${g.diff.slice(0, 80_000)}\n</diff>`,
      agent,
    );
    context = picked.context;
    if (picked.result) calls.push(picked.result.record);
    const count = [...new Set([...context.rulesFor.values()].flat())].length;
    log(`Context: ${count} of ${catalog.length} rules, ${context.decisions.length} of ${gathered.decisions.length} decisions${picked.result?.error ? ` (failed: ${picked.result.error})` : ''}`);
  }

  // Selection only routes, so Sonnet is enough, at about half Opus's cost. A light review has hygiene alone.
  const hasRules = (context.rulesFor.get('conventions')?.length ?? 0) > 0;
  const floor = light ? ['hygiene'] : [...new Set([
    ...selectionFloor(gathered.files, Boolean(gathered.pullRequest.body), hasRules && charters.reviewers.has('conventions')),
    ...projectFloor(project, gathered.files),
  ])];
  const selected = new Set(floor);
  if (!light) {
    const selection = await agent<{ add: { reviewer: string; reason: string }[] }>(
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
  }

  // Specialists, each with the picked rules for its charter, and each part of the diff with its own set of them. The
  // part of the prompt they share is its first block; one reviewer per model and part goes first and caches it, and the
  // rest read the cache instead of each writing it again. On a deep review, the parts with a sensitive file also get
  // correctness and security, both on Opus.
  const parts = gathered.chunks.length ? gathered.chunks : [gathered.diff];
  const deepParts = depth === 'deep' ? sensitiveParts(parts, sensitive) : new Set<number>();
  const deepReviewers = deepParts.size ? Object.keys(deepReviewerTiers).filter((name) => charters.reviewers.has(name)) : [];
  if (deepParts.size) log(`Deep: ${deepReviewers.join(', ')} on ${parts.length > 1 ? `part ${[...deepParts].map((p) => p + 1).join(', ')}` : 'the diff'}`);
  const reviewRun: AgentRun = { ...run, workdir: mkdtempSync(path.join(tmpdir(), 'code-review-work-')) };
  const batches = !light && ruleChecksOn() ? ruleBatches(catalog, context.rulesFor, rulesPerCheck) : [];
  const jobs = parts.flatMap((diff, part) => {
    const sharedBlock = `${sharedContext(gathered, context.decisions, diff, part, parts.length)}\n\nThe checkout is at: ${run.checkout}`;
    const deepPart = deepParts.has(part);
    const tiers = partTiers(depth, deepPart, gathered.tiers);
    return [
      ...[...new Set([...selected, ...(deepPart ? deepReviewers : [])])].map((reviewer) => ({
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
  // A runaway guard only: calls already running finish, and each call's own cap bounds how far they go past it.
  const ceiling = runCeiling(parts.length, undefined, (message) => log(`::warning::${message}`));
  const reviewOne = async ({ name, part, label, tier, prompt }: (typeof jobs)[number]): Promise<ReviewerOutcome> => {
    const where = [parts.length > 1 ? `part ${part + 1}` : '', label].filter(Boolean).join(', ');
    if (spent() >= ceiling) {
      log(`  ${name}${where ? ` (${where})` : ''}: skipped (${runBudgetReason})`);
      return { name, status: 'skipped', findings: [], error: runBudgetReason };
    }
    const result = await agent<{ findings: Finding[] }>(reviewRun, {
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
    log(`  ${name}${where ? ` (${where})` : ''}: ${result.error ? `failed (${result.error})` : `${kept.length} findings${reported.length > kept.length ? ` (${reported.length - kept.length} below ${minConfidence} confidence dropped)` : ''}`} $${result.record.costUsd.toFixed(3)}`);
    return result.error ? { name, status: 'failed', findings: [], error: result.error } : { name, status: 'ran', findings: kept };
  };
  const concurrency = 6;
  const perJob = [
    ...(await mapWithConcurrency(first, concurrency, reviewOne)),
    ...(await mapWithConcurrency(jobs.filter((job) => !first.includes(job)), concurrency, reviewOne)),
  ];
  // One outcome per reviewer across the parts and rule batches: it ran if any of its calls ran, and was skipped only if
  // all of them were.
  const reviewers = [...new Set([...selected, ...deepReviewers])];
  const outcomes: ReviewerOutcome[] = [...reviewers, ...(batches.length ? [ruleCheckName] : [])].map((name) => {
    const mine = perJob.filter((o) => o.name === name);
    const status = mine.some((o) => o.status === 'ran') ? 'ran' : mine.some((o) => o.status === 'failed') ? 'failed' : 'skipped';
    const errors = mine.flatMap((o) => (o.status === 'failed' && o.error ? [o.error] : []));
    const skippedCalls = mine.filter((o) => o.status === 'skipped').length;
    if (skippedCalls) errors.push(status === 'skipped' ? runBudgetReason : `${skippedCalls} of ${mine.length} calls skipped: ${runBudgetReason}`);
    return {
      name,
      status,
      findings: mine.flatMap((o) => o.findings),
      ...(errors.length ? { error: errors.join('; ') } : {}),
    };
  });
  const skippedJobs = perJob.filter((o) => o.status === 'skipped').length;
  let ceilingWarning = '';
  if (skippedJobs) {
    const names = [...new Set(perJob.filter((o) => o.status === 'skipped').map((o) => o.name))].join(', ');
    ceilingWarning = `This review reached its $${ceiling.toFixed(2)} cost ceiling ($${spent().toFixed(2)} spent) and skipped ${skippedJobs} of ${jobs.length} reviewer calls (${names}), so it is incomplete.`;
    log(`::warning::${ceilingWarning}`);
  }

  // Synthesis. A light review posts hygiene's findings as it reported them, most severe first.
  const limit = findingLimit(parts.length);
  const raw = outcomes.flatMap((o) => o.findings.map((f) => ({ reviewer: o.name, ...f }))).map((f, i) => ({ id: `R${i + 1}`, ...f }));
  let summary = '';
  let verdict: Verdict | undefined;
  let findings: ReviewedFinding[] = [];
  if (light) {
    findings = mergeSynthesis([], raw, limit);
    const failed = outcomes.find((o) => o.status === 'failed');
    summary = failed ? `${failed.name} failed (${failed.error}), so nothing was reviewed.` : findings.length ? `${findings.length} finding${findings.length === 1 ? '' : 's'} from hygiene, not merged by synthesis.` : 'No findings.';
    // A review whose one reviewer failed hasn't looked at the change, so it can't approve it.
    if (failed && !findings.length) verdict = 'comment';
  } else if (raw.length) {
    const diff = synthesisDiff(gathered, raw.map((f) => f.file), 120_000);
    const synthesis = await agent<{ summary: string; verdict: Verdict; findings: (Finding & { sources: string[] })[] }>(
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

  // Verification of the merged blockers and should-fixes, with the checkout, on Opus for a deep review's sensitive files.
  // Off unless CODE_REVIEW_VERIFICATION=on, and never on a light review.
  const verified = await verifyReview({ summary, verdict, findings }, {
    run: reviewRun,
    diff: gathered.diff,
    pullRequest: pullRequestBlock(gathered),
    systemPrompt: charters.verificationPrompt,
    charters: new Map([...charters.reviewers, [ruleCheckName, charters.ruleCheckPrompt]]),
    log,
    enabled: verificationOn() && !light,
    ...(depth === 'deep' ? { deep: sensitiveMatcher(gathered.sensitive) } : {}),
    agent,
  });
  calls.push(...verified.calls);
  ({ summary, verdict, findings } = verified);

  const skipped = roster.filter((name) => !reviewers.includes(name));
  verdict ??= findings.some((f) => f.severity === 'blocker') ? 'request-changes' : findings.length ? 'comment' : 'approve';
  if (depth !== 'standard') summary = `${depthLabel[depth]}: ${summary}`;
  if (ceilingWarning) {
    summary = `${summary}\n\n⚠️ ${ceilingWarning}`;
    // A review cut short hasn't seen enough of the change to approve it.
    if (verdict === 'approve') verdict = 'comment';
  }
  return { reviewers: outcomes, summary, verdict, findings, refuted: verified.refuted, verification: verified.trace, calls, skipped, warnings, depth, sensitiveFiles: sensitive };
}

// How the summary and the check run name a review that isn't standard.
export const depthLabel: Record<ReviewDepth, string> = {
  standard: 'Standard review',
  deep: 'Deep review (sensitive paths)',
  light: 'Light review (documentation only)',
};

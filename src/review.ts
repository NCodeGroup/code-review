// Stages 2, 3 and 6 of the baseline: selection, specialists and synthesis, then verification when it's on.

import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { runAgent, totalCost, withoutTools, type AgentRequest, type AgentResult, type AgentRun, type CallRecord } from './agent.ts';
import { parseCharter, type Charter } from './charter.ts';
import { dropContradicted, type DroppedFinding } from './claims.ts';
import { mapWithConcurrency } from './concurrency.ts';
import { budgets, findingsPerExtraChunk, maxFindings, maxFindingsCap, maxTurns, maxUpstreamFindings, minConfidence, reviewerTiers, ruleChecksOn, rulesPerCheck, runCeiling, shadowOverride, shadowPromptRate, verificationOn, type ModelTier } from './config.ts';
import { guidanceRules, repositoryRules, rulesForFiles, selectContext, type Decision, type IndexedRule } from './context.ts';
import { closedIssues, splitDiff, type ChangedFile, type Gathered } from './gather.ts';
import { isTemplateOwned, type Template } from './template.ts';
import { severityRank, type Severity } from './severity.ts';
import { verifyReview, type RefutedFinding, type SynthesizedReview, type VerificationCall } from './verify.ts';

export { severityRank, type Severity };

// The exact code for a mechanical fix of a few lines: it replaces lines startLine to endLine of the new file, whole.
export interface Suggestion {
  startLine: number;
  endLine: number;
  replacement: string;
}

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
  suggestion?: Suggestion;
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

export type PromptName = 'specialist' | 'selection' | 'synthesis' | 'rule-check';
export const promptNames: PromptName[] = ['specialist', 'selection', 'synthesis', 'rule-check'];

// A shadow prompt's call beside the live call it shadows, for comparison in the trace. Its output is never posted.
export interface ShadowPromptRun {
  prompts: PromptName[];
  role: string;
  live: unknown;
  shadow: unknown;
}

export interface Review {
  // The live reviewers: what synthesis, the threads, the summary and the verdict are made from.
  reviewers: ReviewerOutcome[];
  // The shadow reviewers that ran. Their findings go only to the trace and the check run's shadow section.
  shadow: ReviewerOutcome[];
  // Shadow reviewers the path rules and selection didn't choose.
  shadowSkipped: string[];
  // The shadow prompts' calls, when this review was sampled for them.
  shadowPrompts: ShadowPromptRun[];
  summary: string;
  verdict: Verdict;
  findings: ReviewedFinding[];
  // Findings on the template's files: they belong in the template's repository, not in threads on this pull request.
  upstream: ReviewedFinding[];
  // Places on the template's files past the upstream list's limit.
  upstreamOmitted: number;
  // Findings left out because they say a file the pull request changes isn't changed.
  dropped: DroppedFinding[];
  // Findings verification refuted and dropped, with its reasons, and every verification call.
  refuted: RefutedFinding[];
  verification: VerificationCall[];
  calls: CallRecord[];
  // Live roster reviewers the path rules and selection didn't choose.
  skipped: string[];
}

export const findingProperties = {
  severity: { type: 'string', enum: ['blocker', 'should-fix', 'nit'] },
  file: { type: 'string' },
  line: { type: 'integer', minimum: 1 },
  title: { type: 'string' },
  problem: { type: 'string' },
  consequence: { type: 'string' },
  fix: { type: 'string' },
  evidence: { type: 'string' },
  confidence: { type: 'number', minimum: 0, maximum: 1 },
  // Optional: only for a fix of a few lines that needs no other change.
  suggestion: {
    type: 'object',
    properties: {
      startLine: { type: 'integer', minimum: 1 },
      endLine: { type: 'integer', minimum: 1 },
      replacement: { type: 'string' },
    },
    required: ['startLine', 'endLine', 'replacement'],
    additionalProperties: false,
  },
};
export const findingRequired = Object.keys(findingProperties).filter((name) => name !== 'suggestion');

export const specialistSchema = {
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

export const synthesisSchema = {
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
  reReviewPrompt: string;
  verificationPrompt: string;
  reviewers: Map<string, Charter>;
  // prompts/<name>.shadow.md, for each prompt that has one: run alongside the live prompt on a sample of reviews.
  shadowPrompts: Partial<Record<PromptName, string>>;
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

// The files one part of the diff covers, and the changed files no part shows, which every part's reviewers may read.
export function partFiles(files: ChangedFile[], diff: string): string[] {
  return [...splitDiff(diff).keys(), ...files.filter((f) => !f.generated && !f.shown).map((f) => f.path)];
}

export interface ReviewJob { name: string; part: number; label: string; tier: ModelTier; rules: IndexedRule[] }

// The reviewer calls for each part of the diff: every selected reviewer with its picked rules, and each rule batch.
// A rule learned for some files reaches only the parts that change them, and a batch left with no rules for a part
// doesn't run on it.
export function reviewJobs(
  parts: string[],
  files: ChangedFile[],
  selected: string[],
  rulesFor: Map<string, IndexedRule[]>,
  batches: IndexedRule[][],
  tiers: Record<string, ModelTier>,
): ReviewJob[] {
  return parts.flatMap((diff, part) => {
    const shown = partFiles(files, diff);
    const scoped = (rules: IndexedRule[] | undefined) => rulesForFiles(rules ?? [], shown);
    return [
      ...selected.map((reviewer) => ({ name: reviewer, part, label: '', tier: tiers[reviewer] ?? ('haiku' as ModelTier), rules: scoped(rulesFor.get(reviewer)) })),
      ...batches.flatMap((batch, i) => {
        const rules = scoped(batch);
        const label = `rules ${i * rulesPerCheck + 1}-${i * rulesPerCheck + batch.length}`;
        return rules.length ? [{ name: ruleCheckName, part, label, tier: 'sonnet' as ModelTier, rules }] : [];
      }),
    ];
  });
}

// The reviewers that get an outcome: every selected one, and the rule check when any of its calls is planned.
export function outcomeNames(selected: string[], jobs: Pick<ReviewJob, 'name'>[]): string[] {
  return [...selected, ...(jobs.some((job) => job.name === ruleCheckName) ? [ruleCheckName] : [])];
}

export function loadCharters(root: string): Charters {
  const reviewers = new Map<string, Charter>();
  for (const name of readdirSync(path.join(root, 'reviewers')).filter((n) => n.endsWith('.md')).sort()) {
    reviewers.set(name.slice(0, -3), parseCharter(readFileSync(path.join(root, 'reviewers', name), 'utf8')));
  }
  const prompt = (name: string) => readFileSync(path.join(root, 'prompts', `${name}.md`), 'utf8');
  const shadowPrompts: Partial<Record<PromptName, string>> = {};
  for (const name of promptNames) {
    try {
      shadowPrompts[name] = readFileSync(path.join(root, 'prompts', `${name}.shadow.md`), 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  return {
    specialistPrompt: prompt('specialist'),
    selectionPrompt: prompt('selection'),
    synthesisPrompt: prompt('synthesis'),
    ruleCheckPrompt: prompt('rule-check'),
    reReviewPrompt: prompt('re-review'),
    verificationPrompt: prompt('verification'),
    reviewers,
    shadowPrompts,
  };
}

// The reviewers whose findings go only to the trace and the check run's shadow section: the charters marked shadow,
// and the names CODE_REVIEW_SHADOW adds.
export function shadowReviewers(charters: Charters, override = shadowOverride()): Set<string> {
  return new Set([...[...charters.reviewers].filter(([, charter]) => charter.shadow).map(([name]) => name), ...override]);
}

const uint32Range = 2 ** 32;

// Whether this review runs the shadow prompts: the share given by the rate, picked by the pull request's number and
// head, so a re-run of the same commit samples the same way and tests are stable.
export function shadowSampled(number: number, headSha: string, rate: number): boolean {
  if (rate <= 0) return false;
  if (rate >= 1) return true;
  return createHash('sha256').update(`${number}:${headSha}`).digest().readUInt32BE(0) / uint32Range < rate;
}

function shadowPromptRun(prompts: PromptName[], role: string, live: AgentResult<unknown>, shadow: AgentResult<unknown>): ShadowPromptRun {
  const output = (result: AgentResult<unknown>) => (result.error ? { error: result.error } : result.output);
  return { prompts, role, live: output(live), shadow: output(shadow) };
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

// The pull request as every stage sees it. Whether it has a description is stated either way, so no reviewer takes a
// description it wasn't shown for a missing one.
export function pullRequestBlock(gathered: Gathered): string {
  const pr = gathered.pullRequest;
  const description = pr.body
    ? `\nDescription:\n${pr.body}`
    : pr.bodyWithheld
      ? "\n(The pull request has a description, left out because its author lacks write access. Don't report it as missing, or anything as absent from it.)"
      : '\n(The pull request has no description.)';
  const issues = (pr.issues ?? []).map((i) => `\nIssue #${i.number}, which it closes: ${i.title}\n${i.body}`).join('');
  const unread = closedIssues(pr.body).filter((n) => !(pr.issues ?? []).some((i) => i.number === n));
  const unreadIssues = unread.length ? `\nIt also closes ${unread.map((n) => `#${n}`).join(', ')}, whose text isn't shown.` : '';
  const commits = gathered.commits.length ? `\nCommits:\n${gathered.commits.map((c) => `- ${c}`).join('\n')}` : '';
  return `<pull_request>\n#${pr.number}: ${pr.title}\nAuthor: ${pr.author}${description}${issues}${unreadIssues}${commits}\n</pull_request>`;
}

// Every file the pull request changes. Given the files a diff holds, it marks the others that have a diff as `elsewhere`.
export function fileList(gathered: Pick<Gathered, 'files'>, inDiff?: Set<string>, elsewhere = ''): string {
  return gathered.files
    .map((f) => {
      const notShown = !f.shown ? ' [diff not shown: over the size budget]' : inDiff && !inDiff.has(f.path) ? ` [${elsewhere}]` : '';
      return `${f.path} (+${f.additions} -${f.deletions})${f.generated ? ' [generated]' : ''}${f.templateOwned ? ' [template-owned]' : ''}${notShown}`;
    })
    .join('\n');
}

export const completeList = 'Changed files, every file this pull request changes, each changed whether or not its hunks are in the diff below:';

function changeContext(gathered: Gathered, diff: string, part: number, parts: number): string {
  const scope = parts > 1
    ? ` This pull request is too large for one review, so its diff is reviewed in ${parts} parts and this is part ${part + 1}. Review the files in this part's diff; other reviewers have the rest. Read any other file when you need its context.`
    : '';
  const inPart = parts > 1 ? new Set(splitDiff(diff).keys()) : undefined;
  return [
    pullRequestBlock(gathered),
    `${completeList}\n${fileList(gathered, inPart, 'diff in another part')}`,
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
export function sharedContext(gathered: Gathered, decisions: Decision[], diff: string, part: number, parts: number): string {
  return `Conventions of this repository, from its default branch:\n<conventions>\n${gathered.conventions || '(none)'}\n</conventions>${decisionsBlock(decisions)}${templateBlock(gathered)}\n\n${changeContext(gathered, diff, part, parts)}`;
}

// The limit on posted findings: higher for a pull request reviewed in parts.
export function findingLimit(parts: number): number {
  return Math.min(maxFindingsCap, maxFindings + findingsPerExtraChunk * Math.max(0, parts - 1));
}

// What synthesis sees of the diff: the files the findings name first, then every other file that fits the budget, and
// the files it holds. Synthesis sees every changed file it can, or it can wrongly say one isn't in the diff (issue #32).
export function synthesisDiff(gathered: Pick<Gathered, 'diff'>, files: string[], budget: number): { diff: string; files: Set<string> } {
  const sections = splitDiff(gathered.diff);
  let out = '';
  const shown = new Set<string>();
  for (const file of new Set([...files, ...sections.keys()])) {
    const section = sections.get(file);
    if (section && out.length + section.length <= budget) {
      out += section;
      shown.add(file);
    }
  }
  return out ? { diff: out, files: shown } : { diff: gathered.diff.slice(0, budget), files: shown };
}

// Synthesis merges and ranks but never drops: a reviewer's finding no merged finding names as a source is added back
// after them, most severe first, so the maintainer sees it and decides. A source in another file isn't a duplicate, so
// naming it doesn't count. Without a limit, it keeps every finding.
export function mergeSynthesis(
  merged: (Finding & { sources: string[] })[],
  raw: (Finding & { id: string; reviewer: string })[],
  limit?: number,
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

type SynthesisOutput = { summary: string; verdict: Verdict; findings: (Finding & { sources: string[] })[] };

const verdictRank: Record<Verdict, number> = { approve: 0, comment: 1, 'request-changes': 2 };

function verdictFor(findings: Pick<Finding, 'severity'>[]): Verdict {
  return findings.some((f) => f.severity === 'blocker') ? 'request-changes' : findings.length ? 'comment' : 'approve';
}

// Synthesis gave its verdict with the dropped findings in view, so a verdict they carried gives way to the one the kept
// findings call for. Its request-changes on should-fixes that together make the change unsafe stands while one is kept
// and no blocker was dropped. Without synthesis's verdict there is none to settle: review() derives one from the
// findings it posts, after verification.
function settleVerdict(verdict: Verdict | undefined, findings: Pick<Finding, 'severity'>[], dropped: DroppedFinding[]): Verdict | undefined {
  if (!verdict || !dropped.length) return verdict;
  if (verdict === 'request-changes' && findings.length && !dropped.some((d) => d.finding.severity === 'blocker')) return verdict;
  const fromFindings = verdictFor(findings);
  return verdictRank[fromFindings] < verdictRank[verdict] ? fromFindings : verdict;
}

// What a review posts from synthesis's answer, or from the reviewers' own findings when synthesis failed: the findings
// that say a changed file isn't changed are dropped before the limit, so each frees its place, and the rest are numbered.
export function settleFindings(
  synthesis: Pick<AgentResult<SynthesisOutput>, 'output' | 'error'>,
  raw: (Finding & { id: string; reviewer: string })[],
  changedFiles: string[],
  limit: number,
): SynthesizedReview & Pick<Review, 'dropped'> {
  // Without synthesis, fall back to the reviewers' own findings, most severe first.
  const merged = mergeSynthesis(synthesis.output?.findings ?? [], raw);
  const { kept, dropped } = dropContradicted(merged, changedFiles);
  const findings = kept.slice(0, limit).map((f, i) => ({ ...f, id: `F${i + 1}` }));
  return {
    summary: synthesis.output?.summary ?? `Synthesis failed (${synthesis.error}); these are the reviewers' unmerged findings.`,
    verdict: settleVerdict(synthesis.output?.verdict, findings, dropped),
    findings,
    dropped,
  };
}

// The review's verdict after settling upstream: synthesis's when it gave one, else what the findings call for. When
// settling moved some of synthesis's findings upstream, its verdict may rest on them, so it's capped at what the findings
// left here call for.
export function settledVerdict(synthesized: Verdict | undefined, movedUpstream: boolean, findings: Pick<Finding, 'severity'>[]): Verdict {
  const called = verdictFor(findings);
  if (!synthesized) return called;
  return movedUpstream && verdictRank[called] < verdictRank[synthesized] ? called : synthesized;
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

type Selection = { add: { reviewer: string; reason: string }[] };

// Why a reviewer call that never started was skipped, in the check run.
export const runBudgetReason = 'run budget';

// The agent runs through a function the caller can replace, so a test can review with a stub that makes no model call.
export async function review(
  run: AgentRun,
  gathered: Gathered,
  charters: Charters,
  log: (line: string) => void,
  agent: typeof runAgent = runAgent,
): Promise<Review> {
  const calls: CallRecord[] = [];
  const spent = () => totalCost(calls);
  const roster = [...charters.reviewers.keys()];
  const shadow = shadowReviewers(charters);
  const variants = shadowSampled(gathered.pullRequest.number, gathered.pullRequest.headSha, shadowPromptRate()) ? charters.shadowPrompts : {};
  const shadowPrompts: ShadowPromptRun[] = [];
  if (Object.keys(variants).length) log(`Shadow prompts: ${Object.keys(variants).join(', ')}`);

  // Context: the rules and decisions that bear on this change.
  const catalog = [...guidanceRules(gathered.guidance), ...repositoryRules(gathered.reviewRules)];
  const { context, result: contextResult } = await selectContext(
    run,
    gathered,
    catalog,
    gathered.decisions,
    (g) => `${pullRequestBlock(g)}\n\nChanged files:\n${fileList(g)}\n\n<diff>\n${g.diff.slice(0, 80_000)}\n</diff>`,
    agent,
  );
  if (contextResult) calls.push(...contextResult.records);
  const picked = [...new Set([...context.rulesFor.values()].flat())].length;
  log(`Context: ${picked} of ${catalog.length} rules, ${context.decisions.length} of ${gathered.decisions.length} decisions${contextResult?.error ? ` (failed: ${contextResult.error})` : ''}`);

  // Selection only routes, so Sonnet is enough, at about half Opus's cost.
  const hasRules = (context.rulesFor.get('conventions')?.length ?? 0) > 0;
  const floor = selectionFloor(gathered.files, Boolean(gathered.pullRequest.body), hasRules && charters.reviewers.has('conventions'));
  const selected = new Set(floor);
  const oneShot = withoutTools(run);
  const selectionRequest = (role: string, systemPrompt: string): AgentRequest => ({
    role,
    tier: 'sonnet',
    systemPrompt,
    prompt: `Roster: ${roster.join(', ')}\nAlready chosen: ${floor.join(', ')}\n\n${pullRequestBlock(gathered)}\n\nChanged files:\n${fileList(gathered)}\n\n<diff>\n${gathered.diff.slice(0, 60_000)}\n</diff>`,
    schema: selectionSchema,
    maxTurns: 3,
    budgetUsd: budgets.selection,
    cache: false,
  });
  const [selection, shadowSelection] = await Promise.all([
    agent<Selection>(oneShot, selectionRequest('selection', charters.selectionPrompt)),
    variants.selection === undefined ? undefined : agent<Selection>(oneShot, selectionRequest('shadow-prompt:selection', variants.selection)),
  ]);
  calls.push(...selection.records);
  if (shadowSelection) {
    calls.push(...shadowSelection.records);
    shadowPrompts.push(shadowPromptRun(['selection'], 'selection', selection, shadowSelection));
  }
  for (const addition of selection.output?.add ?? []) {
    if (charters.reviewers.has(addition.reviewer)) selected.add(addition.reviewer);
  }
  log(`Reviewers: ${[...selected].map((name) => (shadow.has(name) ? `${name} (shadow)` : name)).join(', ')}${selection.error ? ` (selection failed: ${selection.error})` : ''}`);

  // Specialists, each with the picked rules for its charter, and each part of the diff with its own set of them: a rule
  // learned for some files reaches only the parts that change them. The part of the prompt they share is its first
  // block; one reviewer per model and part goes first and caches it, and the rest read the cache instead of each
  // writing it again.
  const parts = gathered.chunks.length ? gathered.chunks : [gathered.diff];
  const reviewRun: AgentRun = { ...run, workdir: mkdtempSync(path.join(tmpdir(), 'code-review-work-')) };
  const batches = ruleChecksOn() ? ruleBatches(catalog, context.rulesFor, rulesPerCheck) : [];
  const sharedBlocks = parts.map((diff, part) => `${sharedContext(gathered, context.decisions, diff, part, parts.length)}\n\nThe checkout is at: ${run.checkout}`);
  interface Job extends ReviewJob { role: string; systemPrompt: string; charter: string; twinOf?: Job; prompts?: PromptName[] }
  const jobs: Job[] = reviewJobs(parts, gathered.files, [...selected], context.rulesFor, batches, reviewerTiers()).map((job) => ({
    ...job,
    role: `reviewer:${job.name}`,
    systemPrompt: charters.specialistPrompt,
    charter: job.name === ruleCheckName ? charters.ruleCheckPrompt : charters.reviewers.get(job.name)!.text,
  }));
  // A sampled review runs each job again with the shadow prompts, after the live jobs have written the shared cache.
  const twins: Job[] = jobs.flatMap((job) => {
    const charter = job.name === ruleCheckName ? variants['rule-check'] : undefined;
    const prompts: PromptName[] = [...(variants.specialist !== undefined ? ['specialist' as const] : []), ...(charter !== undefined ? ['rule-check' as const] : [])];
    if (!prompts.length) return [];
    return [{ ...job, role: `shadow-prompt:${job.role}`, systemPrompt: variants.specialist ?? job.systemPrompt, charter: charter ?? job.charter, twinOf: job, prompts }];
  });
  const first = jobs.filter((job, i) => jobs.findIndex((other) => other.tier === job.tier && other.part === job.part) === i);
  const outcomeOf = new Map<Job, ReviewerOutcome>();
  // A runaway guard only: calls already running finish, and each call's own cap bounds how far they go past it.
  const ceiling = runCeiling(parts.length, undefined, (message) => log(`::warning::${message}`));
  const reviewOne = async (job: Job): Promise<void> => {
    const { name, part, label, tier } = job;
    const where = [parts.length > 1 ? `part ${part + 1}` : '', label, shadow.has(name) ? 'shadow' : '', job.twinOf ? 'shadow prompt' : ''].filter(Boolean).join(', ');
    if (spent() >= ceiling) {
      log(`  ${name}${where ? ` (${where})` : ''}: skipped (${runBudgetReason})`);
      outcomeOf.set(job, { name, status: 'skipped', findings: [], error: runBudgetReason });
      return;
    }
    const result = await agent<{ findings: Finding[] }>(reviewRun, {
      role: job.role,
      tier,
      systemPrompt: job.systemPrompt,
      prompt: [sharedBlocks[job.part]!, `${rulesBlock(job.rules).trimStart()}\n\nYour charter:\n${job.charter}`],
      schema: specialistSchema,
      maxTurns: maxTurns.specialist,
      budgetUsd: budgets.specialist[tier],
    });
    calls.push(...result.records);
    const cost = totalCost(result.records);
    const reported = result.output?.findings ?? [];
    const kept = reported.filter((f) => f.confidence >= minConfidence);
    log(`  ${name}${where ? ` (${where})` : ''}: ${result.error ? `failed (${result.error})` : `${kept.length} findings${reported.length > kept.length ? ` (${reported.length - kept.length} below ${minConfidence} confidence dropped)` : ''}`} $${cost.toFixed(3)}`);
    outcomeOf.set(job, result.error ? { name, status: 'failed', findings: [], error: result.error } : { name, status: 'ran', findings: kept });
  };
  const concurrency = 6;
  // The twins start after every live job, so the cost ceiling skips a twin before it skips a live call.
  await mapWithConcurrency(first, concurrency, reviewOne);
  await mapWithConcurrency([...jobs.filter((job) => !first.includes(job)), ...twins], concurrency, reviewOne);
  for (const twin of twins) {
    const output = (o: ReviewerOutcome) => (o.error ? { error: o.error } : { findings: o.findings });
    shadowPrompts.push({ prompts: twin.prompts!, role: `${twin.twinOf!.role}${parts.length > 1 ? ` part ${twin.part + 1}` : ''}${twin.label ? ` ${twin.label}` : ''}`, live: output(outcomeOf.get(twin.twinOf!)!), shadow: output(outcomeOf.get(twin)!) });
  }
  const perJob = jobs.map((job) => outcomeOf.get(job)!);
  // One outcome per reviewer across the parts and rule batches: it ran if any of its calls ran, and was skipped only if
  // all of them were.
  const outcomes: ReviewerOutcome[] = outcomeNames([...selected], jobs).map((name) => {
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
  // A shadow reviewer's findings stop here: they never reach synthesis, the threads, the summary or the verdict.
  const live = outcomes.filter((o) => !shadow.has(o.name));
  const shadowOutcomes = outcomes.filter((o) => shadow.has(o.name));
  if (shadowOutcomes.length) log(`Shadow reviewers (not posted): ${shadowOutcomes.map((o) => `${o.name} ${o.findings.length} findings`).join(', ')}`);
  // Only a skipped live call leaves the posted review incomplete.
  const liveJobs = perJob.filter((o) => !shadow.has(o.name));
  const skippedJobs = liveJobs.filter((o) => o.status === 'skipped');
  let ceilingWarning = '';
  if (skippedJobs.length) {
    const names = [...new Set(skippedJobs.map((o) => o.name))].join(', ');
    ceilingWarning = `This review reached its $${ceiling.toFixed(2)} cost ceiling ($${spent().toFixed(2)} spent) and skipped ${skippedJobs.length} of ${liveJobs.length} reviewer calls (${names}), so it is incomplete.`;
    log(`::warning::${ceilingWarning}`);
  }

  // Synthesis.
  const limit = findingLimit(parts.length);
  // Findings on the template's files skip synthesis: they're listed for the template's repository instead.
  const split = byOwner(live.flatMap((o) => o.findings.map((f) => ({ reviewer: o.name, ...f }))), gathered.template);
  const raw = split.own.map((f, i) => ({ id: `R${i + 1}`, ...f }));
  const upstreamRaw: (Finding & { reviewers: string[] })[] = split.upstream.map(({ reviewer, ...f }) => ({ ...f, reviewers: [reviewer] }));
  let summary = '';
  let verdict: Verdict | undefined;
  let findings: ReviewedFinding[] = [];
  const changedFiles = gathered.files.map((f) => f.path);
  // The claims guard reads the template's findings too: they're listed in the summary comment.
  const guardedUpstream = dropContradicted(upstreamRaw, changedFiles);
  let dropped: DroppedFinding[] = guardedUpstream.dropped;
  if (raw.length) {
    const excerpt = synthesisDiff(gathered, raw.map((f) => f.file), 120_000);
    const synthesisRequest = (role: string, systemPrompt: string): AgentRequest => ({
      role,
      tier: 'opus',
      systemPrompt,
      prompt: `Limit: ${limit} findings.\n\n${pullRequestBlock(gathered)}\n\n${completeList}\n${fileList(gathered, excerpt.files, 'diff not in this excerpt')}\n\n<diff>\n${excerpt.diff}\n</diff>\n\nFindings from the reviewers:\n<findings>\n${JSON.stringify(raw, null, 1)}\n</findings>`,
      schema: synthesisSchema,
      maxTurns: 3,
      budgetUsd: budgets.synthesis,
      cache: false,
    });
    const [synthesis, shadowSynthesis] = await Promise.all([
      agent<SynthesisOutput>(oneShot, synthesisRequest('synthesis', charters.synthesisPrompt)),
      variants.synthesis === undefined ? undefined : agent<SynthesisOutput>(oneShot, synthesisRequest('shadow-prompt:synthesis', variants.synthesis)),
    ]);
    calls.push(...synthesis.records);
    if (shadowSynthesis) {
      calls.push(...shadowSynthesis.records);
      shadowPrompts.push(shadowPromptRun(['synthesis'], 'synthesis', synthesis, shadowSynthesis));
    }
    const settledFindings = settleFindings(synthesis, raw, changedFiles, limit);
    ({ summary, verdict, findings } = settledFindings);
    dropped = [...settledFindings.dropped, ...dropped];
  } else {
    summary = 'No findings.';
  }
  if (dropped.length) log(`Dropped ${dropped.length} finding${dropped.length === 1 ? '' : 's'} saying a changed file isn't changed: ${[...new Set(dropped.map((d) => d.file))].join(', ')}`);
  // Synthesis may still place a finding in a template's file. Its verdict is capped when that moved some of its findings
  // upstream; without one, the verdict comes from the findings verification leaves.
  const settled = settleUpstream(findings, guardedUpstream.kept, gathered.template, summary);
  if (verdict) verdict = settledVerdict(verdict, settled.findings.length < findings.length, settled.findings);
  ({ summary, findings } = settled);

  // Verification of the merged blockers and should-fixes, with the checkout. Off unless CODE_REVIEW_VERIFICATION=on.
  // Only the live reviewers' findings reach it: a shadow reviewer's findings never went to synthesis, so they are never
  // verified, and its charter isn't given to the verifier.
  const liveCharters = [...charters.reviewers].filter(([name]) => !shadow.has(name)).map(([name, charter]) => [name, charter.text] as const);
  const verified = await verifyReview({ summary, verdict, findings }, {
    run: reviewRun,
    diff: gathered.diff,
    pullRequest: pullRequestBlock(gathered),
    systemPrompt: charters.verificationPrompt,
    charters: new Map([...liveCharters, ...(shadow.has(ruleCheckName) ? [] : [[ruleCheckName, charters.ruleCheckPrompt] as const])]),
    log,
    enabled: verificationOn(),
    agent,
  });
  calls.push(...verified.calls);
  ({ summary, verdict, findings } = verified);

  const notSelected = roster.filter((name) => !selected.has(name));
  verdict ??= verdictFor(findings);
  if (ceilingWarning) {
    summary = `${summary}\n\n⚠️ ${ceilingWarning}`;
    // A review cut short hasn't seen enough of the change to approve it.
    if (verdict === 'approve') verdict = 'comment';
  }
  return {
    reviewers: live,
    shadow: shadowOutcomes,
    shadowSkipped: notSelected.filter((name) => shadow.has(name)),
    shadowPrompts,
    summary,
    verdict,
    findings,
    upstream: settled.upstream,
    upstreamOmitted: settled.upstreamOmitted,
    dropped,
    refuted: verified.refuted,
    verification: verified.trace,
    calls,
    skipped: notSelected.filter((name) => !shadow.has(name)),
  };
}

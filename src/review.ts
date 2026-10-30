// Stages 2, 3 and 6 of the baseline: selection, specialists and synthesis.

import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { runAgent, type AgentRun, type CallRecord } from './agent.ts';
import { budgets, maxFindings, maxTurns, reviewerTiers, type ModelTier } from './config.ts';
import { batchRules, type ChangedFile, type Gathered } from './gather.ts';

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

export interface Review {
  reviewers: ReviewerOutcome[];
  summary: string;
  findings: ReviewedFinding[];
  calls: CallRecord[];
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
  required: ['summary', 'findings'],
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
  return [...floor];
}

function pullRequestBlock(gathered: Gathered): string {
  const pr = gathered.pullRequest;
  const description = pr.body ? `\nDescription:\n${pr.body}` : '\n(No description, or its author lacks write access.)';
  const commits = gathered.commits.length ? `\nCommits:\n${gathered.commits.map((c) => `- ${c}`).join('\n')}` : '';
  return `<pull_request>\n#${pr.number}: ${pr.title}\nAuthor: ${pr.author}${description}${commits}\n</pull_request>`;
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

// The part every specialist shares, so the provider can cache it; each charter comes after it.
function sharedContext(gathered: Gathered): string {
  return `Conventions of this repository, from its default branch:\n<conventions>\n${gathered.conventions || '(none)'}\n</conventions>\n\n${changeContext(gathered, gathered.diff)}`;
}

// Haiku 5.5 costs five times as much once a prompt passes 100K tokens. Identity's rules, full of code, markdown and
// emoji, measured about 2.1 characters a token, and the agent's own system prompt and tool definitions add a few
// thousand more, so a conventions call stays under about 180,000 characters: rules first, then as much of the diff as
// fits. The agent reads the rest of the changed files from the checkout.
const conventionsPromptChars = 180_000;
export const conventionsRuleChars = 140_000;

export function conventionsPrompt(gathered: Gathered, checkout: string, charter: string, rules: string, limit = conventionsPromptChars): string {
  const rulesBlock = `The repository's review rules for the changed files, from its default branch. Rules the build already enforces have been left out.\n<review_rules>\n${rules}\n</review_rules>`;
  const tail = `\n\nThe checkout is at: ${checkout}\n\nYour charter:\n${charter}`;
  const note = '\n[diff cut to fit; read the remaining changed files from the checkout]';
  const room = limit - rulesBlock.length - tail.length - changeContext(gathered, '').length - 2;
  const diff = gathered.diff.length <= room ? gathered.diff : `${gathered.diff.slice(0, Math.max(0, room - note.length))}${note}`;
  return `${changeContext(gathered, diff)}\n\n${rulesBlock}${tail}`;
}

async function mapWithConcurrency<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
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
  const shared = sharedContext(gathered);
  const roster = [...charters.reviewers.keys()];

  // Selection only routes, so Sonnet is enough, at about half Opus's cost.
  const floor = selectionFloor(gathered.files, Boolean(gathered.pullRequest.body), gathered.reviewRules.length > 0 && charters.reviewers.has('conventions'));
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

  // Specialists, in parallel. On Haiku, the conventions reviewer runs once per batch of rule files, to stay under its
  // long-prompt premium; on Sonnet, which has none, it gets every rule and the whole diff in one call.
  const tiers = reviewerTiers();
  const jobs: { name: string; tier: ModelTier; prompt: string }[] = [];
  for (const reviewer of selected) {
    const charter = charters.reviewers.get(reviewer)!;
    const tier = tiers[reviewer] ?? 'haiku';
    if (reviewer !== 'conventions') {
      jobs.push({ name: reviewer, tier, prompt: `${shared}\n\nThe checkout is at: ${run.checkout}\n\nYour charter:\n${charter}` });
      continue;
    }
    if (tier !== 'haiku') {
      const rules = gathered.reviewRules.map((r) => r.text).join('\n\n');
      jobs.push({ name: reviewer, tier, prompt: conventionsPrompt(gathered, run.checkout ?? '', charter, rules, Number.MAX_SAFE_INTEGER) });
      continue;
    }
    const batches = batchRules(gathered.reviewRules, conventionsRuleChars);
    batches.forEach((rules, i) => {
      jobs.push({
        name: batches.length > 1 ? `conventions-${i + 1}` : 'conventions',
        tier,
        prompt: conventionsPrompt(gathered, run.checkout ?? '', charter, rules),
      });
    });
  }
  const outcomes = await mapWithConcurrency(jobs, 4, async ({ name, tier, prompt }): Promise<ReviewerOutcome> => {
    const result = await runAgent<{ findings: Finding[] }>(run, {
      role: `reviewer:${name}`,
      tier,
      systemPrompt: charters.specialistPrompt,
      prompt,
      schema: specialistSchema,
      maxTurns: maxTurns.specialist,
      budgetUsd: budgets.specialist,
    });
    calls.push(result.record);
    const reported = result.output?.findings ?? [];
    const kept = reported.filter((f) => f.confidence >= 0.5);
    log(`  ${name}: ${result.error ? `failed (${result.error})` : `${kept.length} findings${reported.length > kept.length ? ` (${reported.length - kept.length} below 0.5 confidence dropped)` : ''}`} $${result.record.costUsd.toFixed(3)}`);
    return result.error ? { name, status: 'failed', findings: [], error: result.error } : { name, status: 'ran', findings: kept };
  });

  // Synthesis.
  const raw = outcomes.flatMap((o) => o.findings.map((f) => ({ reviewer: o.name, ...f })));
  let summary = '';
  let findings: ReviewedFinding[] = [];
  if (raw.length) {
    const synthesis = await runAgent<{ summary: string; findings: (Finding & { reviewers: string[] })[] }>(
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

  return { reviewers: outcomes, summary, findings, calls };
}

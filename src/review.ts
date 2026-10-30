// Stages 2, 3 and 6 of the baseline: selection, specialists and synthesis.

import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { runAgent, type AgentRun, type CallRecord } from './agent.ts';
import { budgets, maxFindings, maxTurns } from './config.ts';
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
export function selectionFloor(files: ChangedFile[], hasDescription: boolean): string[] {
  const reviewed = files.filter((f) => !f.generated);
  const code = reviewed.filter((f) => productCode.test(f.path) && !testPath.test(f.path));
  const floor = new Set<string>(['hygiene']);
  if (code.length) floor.add('correctness');
  if (code.some((f) => securityPath.test(f.path))) floor.add('security');
  if (reviewed.some((f) => /(^|\/)PublicAPI\.[A-Za-z]+\.txt$/.test(f.path))) floor.add('api-compat');
  if (code.length && !reviewed.some((f) => testPath.test(f.path))) floor.add('tests');
  if (/(^|\/)Migrations\/|\.sql$/i.test(reviewed.map((f) => f.path).join('\n'))) floor.add('data-model');
  if (hasDescription && code.length) floor.add('intent');
  return [...floor];
}

function pullRequestBlock(gathered: Gathered): string {
  const pr = gathered.pullRequest;
  const description = pr.body ? `\nDescription:\n${pr.body}` : '\n(No description, or its author lacks write access.)';
  return `<pull_request>\n#${pr.number}: ${pr.title}\nAuthor: ${pr.author}${description}\n</pull_request>`;
}

function fileList(gathered: Gathered): string {
  return gathered.files
    .map((f) => `${f.path} (+${f.additions} -${f.deletions})${f.generated ? ' [generated]' : ''}${f.shown ? '' : ' [diff not shown: over the size budget]'}`)
    .join('\n');
}

// The part every specialist shares, so the provider can cache it; each charter comes after it.
function sharedContext(gathered: Gathered): string {
  return [
    `Conventions of this repository, from its default branch:\n<conventions>\n${gathered.conventions || '(none)'}\n</conventions>`,
    pullRequestBlock(gathered),
    `Changed files:\n${fileList(gathered)}`,
    `The diff against the merge base. The pull request's head is checked out at the path given below; use it to read whole files.\n<diff>\n${gathered.diff}\n</diff>`,
  ].join('\n\n');
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

  // Selection.
  const floor = selectionFloor(gathered.files, Boolean(gathered.pullRequest.body));
  const selected = new Set(floor);
  const selection = await runAgent<{ add: { reviewer: string; reason: string }[] }>(
    { provider: run.provider, proxyUrl: run.proxyUrl },
    {
      role: 'selection',
      tier: 'opus',
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

  // Specialists, in parallel.
  const outcomes = await mapWithConcurrency([...selected], 4, async (name): Promise<ReviewerOutcome> => {
    const result = await runAgent<{ findings: Finding[] }>(run, {
      role: `reviewer:${name}`,
      tier: 'haiku',
      systemPrompt: charters.specialistPrompt,
      prompt: `${shared}\n\nThe checkout is at: ${run.checkout}\n\nYour charter:\n${charters.reviewers.get(name)}`,
      schema: specialistSchema,
      maxTurns: maxTurns.specialist,
      budgetUsd: budgets.specialist,
    });
    calls.push(result.record);
    log(`  ${name}: ${result.error ? `failed (${result.error})` : `${result.output?.findings.length ?? 0} findings`} $${result.record.costUsd.toFixed(3)}`);
    return result.error
      ? { name, status: 'failed', findings: [], error: result.error }
      : { name, status: 'ran', findings: (result.output?.findings ?? []).filter((f) => f.confidence >= 0.5) };
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

// Teaches the review bot NCodeGroup-wide rules from a repository's own decisions, conventions, standards, review
// prompts and its maintainer's review comments.
//
//   node training/run.ts --repo NCodeGroup/Identity --checkout C:\GitHub\NCode\Identity [--maintainer polewskm]
//   node training/run.ts --generalize-only [--holdout-only] [--no-taught-rules]
//   node training/run.ts --retag
//
// 1. Extract: Opus reads each source and lists the rules a reviewer could check, phrased in general terms. The bot's own
//    findings that the maintainer answered are a source too, one per pull request, with the replies and whether the
//    finding was fixed or declined. The result
//    is saved under training/extracted/<repository>/ with the source's content hash, so a rerun reads only sources that
//    changed. An instruction file's rules also keep the file's applyTo globs.
// 2. Generalize: Opus merges every repository's extracted rules, topic by topic, into guidance/<topic>.md, which the
//    engine gives the conventions reviewer in every repository. training/feedback.md holds the maintainer's
//    corrections, and every generalization follows them. First, the rules of the closed `review-guidance` issues that
//    `/review teach org` opened in NCodeGroup/code-review, closed as completed, are copied into its "Taught with
//    /review teach" section (`--no-taught-rules` skips this). Each rule learned only from instruction files is tagged
//    with the files they apply to ("*Applies to:* `**/*.cs`"), and the engine gives it only to reviews that change such
//    a file. --retag rewrites those tags in guidance/ and guidance-holdout/ from the rules' sources, without a model.
// 3. Hold out: the same generalization, without the review comments and decision records of the eval cases' pull
//    requests, into guidance-holdout/. The evals use it, so a catch shows what the bot learned in general rather than
//    the answer to that case. Production uses guidance/.
//
// Runs on Bedrock with AWS_BEARER_TOKEN_BEDROCK. Review the guidance in a pull request before it's merged.

import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runAgent, totalCost, type AgentRun, type CallRecord } from '../src/agent.ts';
import { mapWithConcurrency } from '../src/concurrency.ts';
import { applyToGlobs } from '../src/gather.ts';
import { bulletGlobs, formatBullet, parseBullet, type GuidanceRule } from '../src/guidance.ts';
import { isDeclining } from '../src/outcomes.ts';
import { startProxy } from '../src/proxy.ts';
import { botLogin } from '../src/results.ts';
import { orgGuidanceRepository } from '../src/teach.ts';
import { findingBody, findingTitle, parseFindingComment } from '../src/threads.ts';
import { fetchGuidanceIssues, taughtRules, withTaughtRules } from './guidance-issues.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const topics = [
  'allocations-and-buffers', 'text-and-encoding', 'async-and-concurrency', 'public-api', 'errors-and-validation',
  'security-and-crypto', 'protocols', 'testing', 'logging-and-telemetry', 'configuration-and-options',
  'dependency-injection', 'persistence', 'code-organization', 'documentation', 'performance',
] as const;

// applyTo: the globs of the instruction file a source comes from, as its frontmatter lists them.
export interface Source { kind: string; id: string; label: string; text: string; applyTo?: string[] }
interface Rule {
  statement: string;
  why: string;
  check: string;
  scope: 'general' | 'domain' | 'repository';
  domain?: string;
  topic: string;
  applies_to: string[];
  enforced_by_tools: boolean;
}
interface Extracted { hash: string; promptHash: string; label: string; applyTo?: string[]; rules: Rule[] }

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

// The source labels the eval cases draw on: the review and the answered bot findings of each pull request a case names,
// and each decision record its source cites. Labels look like "Identity review of #341", "Identity outcomes of #341"
// and "Identity ADR-0266".
export function holdoutLabels(cases: { id: string; repository: string; pullRequest?: number; source?: string }[]): Set<string> {
  const labels = new Set<string>();
  for (const c of cases) {
    const repo = c.repository.split('/')[1]!;
    const text = `${c.id} ${c.source ?? ''}`;
    const pulls = new Set<number>(c.pullRequest ? [c.pullRequest] : []);
    for (const m of text.matchAll(/(?:\/pull\/|#|^comments-)(\d+)/g)) pulls.add(Number(m[1]));
    for (const pull of pulls) {
      labels.add(`${repo} review of #${pull}`);
      labels.add(`${repo} outcomes of #${pull}`);
    }
    for (const m of text.matchAll(/ADR-(\d{4})/g)) labels.add(`${repo} ADR-${m[1]}`);
  }
  return labels;
}

const sha = (text: string) => createHash('sha256').update(text).digest('hex').slice(0, 16);
const slug = (text: string) => text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 80);

// Splits a long document at its ## headings into pieces of at most `size` characters.
export function chunkByHeading(text: string, size = 30_000): string[] {
  const chunks: string[] = [];
  let current = '';
  for (const section of text.split(/^(?=## )/m)) {
    if (current && current.length + section.length > size) {
      chunks.push(current);
      current = '';
    }
    for (let i = 0; i < section.length; i += size) current += section.slice(i, i + size);
  }
  if (current.trim()) chunks.push(current);
  return chunks;
}

function decisionRecords(checkout: string, repoName: string): Source[] {
  const sources: Source[] = [];
  for (const folder of ['docs/decisions', 'docs/adr', 'doc/adr', 'adr']) {
    const dir = path.join(checkout, folder);
    if (!existsSync(dir)) continue;
    for (const name of readdirSync(dir).filter((n) => /^\d{4}-.+\.md$/.test(n) && !n.startsWith('0000-')).sort()) {
      const text = readFileSync(path.join(dir, name), 'utf8');
      const status = /\*\*Status:\*\*\s*([A-Za-z]+)/.exec(text)?.[1] ?? 'Accepted';
      if (status !== 'Accepted') continue;
      sources.push({ kind: 'adr', id: name.slice(0, -3), label: `${repoName} ADR-${name.slice(0, 4)}`, text });
    }
  }
  return sources;
}

function conventionFiles(checkout: string, repoName: string): Source[] {
  const sources: Source[] = [];
  const instructions = path.join(checkout, '.github', 'instructions');
  if (existsSync(instructions)) {
    for (const name of readdirSync(instructions).filter((n) => n.endsWith('.instructions.md')).sort()) {
      const file = readFileSync(path.join(instructions, name), 'utf8');
      const applyTo = applyToGlobs(file);
      chunkByHeading(file).forEach((text, i) =>
        sources.push({ kind: 'instructions', id: `${name.replace('.instructions.md', '')}-${i + 1}`, label: `${repoName} ${name}`, text, ...(applyTo.length ? { applyTo } : {}) }),
      );
    }
  }
  const agents = path.join(checkout, 'AGENTS.md');
  if (existsSync(agents)) {
    const section = readFileSync(agents, 'utf8').split(/^(?=## )/m).find((s) => s.startsWith('## Coding conventions'));
    if (section) sources.push({ kind: 'agents', id: 'coding-conventions', label: `${repoName} AGENTS.md`, text: section });
  }
  for (const folder of ['.claude/commands', '.github/agents']) {
    const dir = path.join(checkout, folder);
    if (!existsSync(dir)) continue;
    for (const name of readdirSync(dir).filter((n) => /review/i.test(n) && n.endsWith('.md'))) {
      sources.push({ kind: 'prompt', id: slug(`${folder}-${name}`), label: `${repoName} ${folder}/${name}`, text: readFileSync(path.join(dir, name), 'utf8') });
    }
  }
  const docs = path.join(checkout, 'docs');
  if (existsSync(docs)) {
    for (const name of readdirSync(docs).filter((n) => n.endsWith('.md') && n !== 'README.md').sort()) {
      chunkByHeading(readFileSync(path.join(docs, name), 'utf8')).forEach((text, i) =>
        sources.push({ kind: 'doc', id: `${name.slice(0, -3)}-${i + 1}`, label: `${repoName} docs/${name}`, text }),
      );
    }
  }
  return sources;
}

// Every review comment on a repository's pull requests, as GitHub's REST API lists them. It asks for each page by number
// instead of following GitHub's next-page links, which name the repository by its numeric id, a path that some
// proxies refuse, such as a Claude Code cloud session's.
function fetchPullComments(repository: string): PullComment[] {
  const comments: PullComment[] = [];
  for (let page = 1; ; page++) {
    const raw = execFileSync('gh', ['api', `repos/${repository}/pulls/comments?per_page=100&page=${page}`], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    const batch = JSON.parse(raw) as PullComment[];
    comments.push(...batch);
    if (batch.length < 100) return comments;
  }
}

// The maintainer's top-level review comments with the diff they were on and the replies, one source per pull request.
export function maintainerComments(comments: PullComment[], repoName: string, maintainer: string): Source[] {
  const replies = new Map<number, PullComment[]>();
  for (const c of comments) if (c.in_reply_to_id) replies.set(c.in_reply_to_id, [...(replies.get(c.in_reply_to_id) ?? []), c]);
  const byPull = new Map<string, string[]>();
  for (const c of comments.filter((c) => c.user?.login === maintainer && !c.in_reply_to_id)) {
    const pull = String(c.pull_request_url).split('/').pop()!;
    const hunk = String(c.diff_hunk ?? '').split('\n').slice(-12).join('\n');
    const answers = (replies.get(c.id) ?? []).map((r) => `Reply from ${r.user?.login}: ${String(r.body).slice(0, 700)}`).join('\n');
    byPull.set(pull, [...(byPull.get(pull) ?? []), `File ${c.path}, line ${c.original_line ?? c.line}:\n\`\`\`diff\n${hunk}\n\`\`\`\nMaintainer: ${c.body}\n${answers}`]);
  }
  return [...byPull].map(([pull, threads]) => ({
    kind: 'review-comments',
    id: `pr-${pull}`,
    label: `${repoName} review of #${pull}`,
    text: `Review comments by the maintainer on pull request #${pull}:\n\n${threads.join('\n\n---\n\n')}`,
  }));
}

// How much of a finding's body and of each reply a review-outcomes source keeps, and what separates its threads.
const maxOutcomeFindingChars = 1_500;
const maxOutcomeReplyChars = 1_000;
const threadSeparator = '\n\n---\n\n';

// One review comment as GitHub's REST API lists it for a repository's pull requests.
export interface PullComment { id: number; in_reply_to_id?: number; user?: { login?: string }; body?: string; path?: string; line?: number | null; original_line?: number | null; diff_hunk?: string; pull_request_url?: string }

// The bot's findings that the maintainer replied to, one source per pull request, with the replies and a verdict read
// from the last reply: fixed, declined or answered. Only the maintainer's replies count. A pull request whose threads
// exceed `size` characters is split into several sources that share one label.
export function outcomeSources(comments: PullComment[], repoName: string, maintainer: string, size = 30_000): Source[] {
  const replies = new Map<number, PullComment[]>();
  for (const c of comments) {
    if (c.in_reply_to_id && c.user?.login?.toLowerCase() === maintainer.toLowerCase()) replies.set(c.in_reply_to_id, [...(replies.get(c.in_reply_to_id) ?? []), c]);
  }
  const byPull = new Map<string, string[]>();
  for (const c of comments) {
    if (c.in_reply_to_id || c.user?.login !== botLogin) continue;
    const body = c.body ?? '';
    const finding = parseFindingComment(body);
    const answers = replies.get(c.id);
    if (!finding || !answers?.length) continue;
    const last = answers.at(-1)!.body ?? '';
    const verdict = /^\s*Autopilot:\s*fixed in\b/i.test(last) ? 'fixed' : /^\s*Autopilot:\s*(not changed|nothing to change)\b/i.test(last) || isDeclining(last) ? 'declined' : 'answered';
    const thread = [
      `Finding ${finding.id} (${finding.severity}, by ${finding.reviewers.join(', ')}) on ${c.path}, line ${c.original_line ?? c.line}: ${findingTitle(body)}`,
      findingBody(body).slice(0, maxOutcomeFindingChars),
      `Outcome: ${verdict}`,
      ...answers.map((r) => `Maintainer: ${(r.body ?? '').slice(0, maxOutcomeReplyChars)}`),
    ].join('\n');
    const pull = String(c.pull_request_url).split('/').pop()!;
    byPull.set(pull, [...(byPull.get(pull) ?? []), thread]);
  }
  const sources: Source[] = [];
  for (const [pull, threads] of byPull) {
    const pieces: string[] = [];
    let current = '';
    for (const thread of threads) {
      if (current && current.length + threadSeparator.length + thread.length > size) {
        pieces.push(current);
        current = '';
      }
      current = current ? `${current}${threadSeparator}${thread}` : thread;
    }
    if (current) pieces.push(current);
    pieces.forEach((piece, i) => sources.push({
      kind: 'review-outcomes',
      id: pieces.length === 1 ? `outcomes-${pull}` : `outcomes-${pull}-${i + 1}`,
      label: `${repoName} outcomes of #${pull}`,
      text: `The review bot's findings on pull request #${pull} that the maintainer answered, with the replies:\n\n${piece}`,
    }));
  }
  return sources;
}

const ruleSchema = {
  type: 'object',
  properties: {
    statement: { type: 'string' },
    why: { type: 'string' },
    check: { type: 'string' },
    scope: { type: 'string', enum: ['general', 'domain', 'repository'] },
    domain: { type: 'string' },
    topic: { type: 'string', enum: [...topics] },
    applies_to: { type: 'array', items: { type: 'string' } },
    enforced_by_tools: { type: 'boolean' },
  },
  required: ['statement', 'why', 'check', 'scope', 'topic', 'applies_to', 'enforced_by_tools'],
  additionalProperties: false,
};
const extractSchema = { type: 'object', properties: { rules: { type: 'array', items: ruleSchema } }, required: ['rules'], additionalProperties: false };
const guidanceSchema = {
  type: 'object',
  properties: {
    description: { type: 'string' },
    applies_to: { type: 'array', items: { type: 'string' } },
    rules: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          statement: { type: 'string' },
          why: { type: 'string' },
          check: { type: 'string' },
          sources: { type: 'array', items: { type: 'string' } },
          note: { type: 'string' },
        },
        required: ['statement', 'why', 'check', 'sources'],
        additionalProperties: false,
      },
    },
  },
  required: ['description', 'applies_to', 'rules'],
  additionalProperties: false,
};

export function saveExtracted(file: string, { hash, promptHash, label, applyTo, rules }: Extracted): void {
  mkdirSync(path.dirname(file), { recursive: true });
  const saved: Extracted = { hash, promptHash, label, ...(applyTo?.length ? { applyTo } : {}), rules };
  writeFileSync(file, `${JSON.stringify(saved, null, 2)}\n`);
}

// A saved extraction a rerun reuses instead of calling the model: one whose source text and prompt are unchanged. It
// takes the source's current applyTo, so an instruction file whose globs changed and whose text didn't keeps its rules
// with the new globs; changed says it differs from what was saved. Undefined when the source must be extracted again.
export function reuseExtraction(saved: Extracted | undefined, hash: string, promptHash: string, applyTo: string[] | undefined): { saved: Extracted; changed: boolean } | undefined {
  if (!saved || saved.hash !== hash || saved.promptHash !== promptHash) return undefined;
  const { applyTo: before, ...rest } = saved;
  const changed = (before ?? []).join(',') !== (applyTo ?? []).join(',');
  return { saved: { ...rest, ...(applyTo?.length ? { applyTo } : {}) }, changed };
}

// A repository's extraction folder under `base`: the existing folder whose name equals owner-repository ignoring case,
// with the repository name spelled as that folder spells it, so the source labels stay the same; otherwise the folder
// a first run creates, with the repository name as given.
export function extractedFolder(base: string, repository: string): { dir: string; repoName: string } {
  const owner = repository.split('/')[0]!;
  const wanted = repository.replace('/', '-');
  const found = existsSync(base) ? readdirSync(base, { withFileTypes: true }).find((e) => e.isDirectory() && e.name.toLowerCase() === wanted.toLowerCase()) : undefined;
  if (found) return { dir: path.join(base, found.name), repoName: found.name.slice(owner.length + 1) };
  return { dir: path.join(base, wanted), repoName: repository.split('/')[1]! };
}

// The saved extractions under `dir` whose source no longer exists: the .json files at <dir>/<kind>/<id>.json that no
// source names, sorted.
export function staleExtractions(dir: string, sources: Pick<Source, 'kind' | 'id'>[]): string[] {
  if (!existsSync(dir)) return [];
  const current = new Set(sources.map((s) => path.join(dir, s.kind, `${s.id}.json`)));
  const stale: string[] = [];
  for (const kind of readdirSync(dir, { withFileTypes: true })) {
    if (!kind.isDirectory()) continue;
    for (const name of readdirSync(path.join(dir, kind.name))) {
      const file = path.join(dir, kind.name, name);
      if (name.endsWith('.json') && !current.has(file)) stale.push(file);
    }
  }
  return stale.sort();
}

// The request the model reads for one source: its label, the files it applies to when it is an instruction file, and
// its text.
export function extractRequest(source: Pick<Source, 'label' | 'text' | 'applyTo'>): string {
  const applies = source.applyTo?.length ? `Applies to: ${source.applyTo.join(', ')}\n` : '';
  return `Source: ${source.label}\n${applies}\n<source>\n${source.text}\n</source>`;
}

async function extract(run: AgentRun, sources: Source[], outDir: string, calls: CallRecord[], prune: boolean): Promise<void> {
  const prompt = readFileSync(path.join(root, 'training', 'prompts', 'extract.md'), 'utf8');
  const promptHash = sha(prompt);
  let reused = 0, failed = 0;
  await mapWithConcurrency(sources, 6, async (source) => {
    const file = path.join(outDir, source.kind, `${source.id}.json`);
    const hash = sha(source.text);
    // Read it directly rather than checking first, so the file can't change between the check and the read.
    let text: string | undefined;
    try { text = readFileSync(file, 'utf8'); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    const reuse = reuseExtraction(text === undefined ? undefined : (JSON.parse(text) as Extracted), hash, promptHash, source.applyTo);
    if (reuse) {
      if (reuse.changed) saveExtracted(file, reuse.saved);
      reused++;
      return;
    }
    const result = await runAgent<{ rules: Rule[] }>(run, {
      role: `extract:${source.kind}`,
      tier: 'opus',
      systemPrompt: prompt,
      prompt: extractRequest(source),
      schema: extractSchema,
      maxTurns: 3,
      budgetUsd: 3,
      cache: false,
    });
    calls.push(...result.records);
    if (!result.output) { failed++; console.log(`  ${source.label}: failed (${result.error})`); return; }
    saveExtracted(file, { hash, promptHash, label: source.label, ...(source.applyTo ? { applyTo: source.applyTo } : {}), rules: result.output.rules });
    console.log(`  ${source.label}: ${result.output.rules.length} rules, $${totalCost(result.records).toFixed(3)}`);
  });
  console.log(`Extracted ${sources.length - reused - failed} sources, reused ${reused}, failed ${failed}.`);
  if (prune) {
    const stale = staleExtractions(outDir, sources);
    for (const file of stale) rmSync(file);
    if (stale.length) console.log(`Removed ${stale.length} extractions of sources that no longer exist.`);
  }
}

function readExtracted(): Extracted[] {
  const all: Extracted[] = [];
  const base = path.join(root, 'training', 'extracted');
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.json')) all.push(JSON.parse(readFileSync(full, 'utf8')) as Extracted);
    }
  };
  if (existsSync(base)) walk(base);
  return all;
}

function loadExtracted(): { rule: Rule; source: string }[] {
  return readExtracted().flatMap((saved) => saved.rules.map((rule) => ({ rule, source: saved.label })));
}

// The files each instruction-file source applies to, by its label, as globs for any NCodeGroup repository.
export function sourceScopes(extracted: Pick<Extracted, 'label' | 'applyTo'>[] = readExtracted()): Map<string, string[]> {
  const scopes = new Map<string, string[]>();
  for (const { label, applyTo } of extracted) if (applyTo?.length) scopes.set(label, applyTo.map(generalGlob));
  return scopes;
}

// One repository's folders don't carry over to another, so a glob keeps only its file pattern: src/**/*.cs and
// tests/**/*.cs both become **/*.cs.
export function generalGlob(glob: string): string {
  const name = glob.split('/').pop()!;
  return name === '**' || name === '' ? '**' : `**/${name}`;
}

// The globs a learned rule applies to: those of the instruction files it was learned from. A rule with any source that
// applies to every file, or isn't an instruction file (a decision record, a review, a document), applies to every file,
// and gets no globs.
export function ruleScope(sources: string[], scopes: Map<string, string[]>): string[] {
  const globs = new Set<string>();
  for (const source of sources) {
    const scope = scopes.get(source);
    if (!scope || scope.includes('**')) return [];
    for (const glob of scope) globs.add(glob);
  }
  return [...globs].sort();
}

// Rewrites each bullet's "*Applies to:*" tag in a guidance file from its sources, with the same formatter a training
// run uses, and changes nothing else. Refuses a bullet the formatter wouldn't write back exactly as it was.
export function retagGuidance(text: string, scopes: Map<string, string[]>): string {
  return text
    .split('\n')
    .map((line) => {
      if (!line.startsWith('- **')) return line;
      const rule = parseBullet(line);
      if (!rule || formatBullet(rule, bulletGlobs(line)) !== line) throw new Error(`Can't retag this bullet: ${line.slice(0, 120)}`);
      return formatBullet(rule, ruleScope(rule.sources, scopes));
    })
    .join('\n');
}

function retag(folders: string[]): void {
  const scopes = sourceScopes();
  for (const folder of folders) {
    const dir = path.join(root, folder);
    if (!existsSync(dir)) continue;
    for (const name of readdirSync(dir).filter((n) => n.endsWith('.md')).sort()) {
      const file = path.join(dir, name);
      const text = readFileSync(file, 'utf8');
      const retagged = retagGuidance(text, scopes);
      if (retagged !== text) writeFileSync(file, retagged);
      console.log(`  ${folder}/${name}: ${retagged.split('\n').filter((l) => l.startsWith('- **') && bulletGlobs(l).length).length} tagged rules`);
    }
  }
}

const titles: Record<string, string> = {
  'allocations-and-buffers': 'Allocations and buffers', 'text-and-encoding': 'Text and encoding', 'async-and-concurrency': 'Async and concurrency',
  'public-api': 'Public API', 'errors-and-validation': 'Errors and validation', 'security-and-crypto': 'Security and cryptography',
  protocols: 'Protocols', testing: 'Testing', 'logging-and-telemetry': 'Logging and telemetry', 'configuration-and-options': 'Configuration and options',
  'dependency-injection': 'Dependency injection', persistence: 'Persistence', 'code-organization': 'Code organization',
  documentation: 'Documentation', performance: 'Performance',
};

async function generalize(run: AgentRun, calls: CallRecord[], folder: string, exclude = new Set<string>()): Promise<void> {
  const prompt = readFileSync(path.join(root, 'training', 'prompts', 'generalize.md'), 'utf8');
  const feedbackFile = path.join(root, 'training', 'feedback.md');
  const feedback = existsSync(feedbackFile) ? readFileSync(feedbackFile, 'utf8') : '';
  const usable = loadExtracted().filter(({ rule, source }) => rule.scope !== 'repository' && !rule.enforced_by_tools && !exclude.has(source));
  const scopes = sourceScopes();
  console.log(`${folder}/: ${usable.length} rules${exclude.size ? `, holding out ${exclude.size} sources` : ''}`);
  const out = path.join(root, folder);
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });
  await mapWithConcurrency([...topics], 4, async (topic) => {
    const rules = usable.filter(({ rule }) => rule.topic === topic);
    if (!rules.length) return;
    const input = rules.map(({ rule, source }) => ({ ...rule, source }));
    const result = await runAgent<{ description: string; applies_to: string[]; rules: GuidanceRule[] }>(run, {
      role: `generalize:${topic}`,
      tier: 'opus',
      systemPrompt: prompt,
      prompt: `Topic: ${titles[topic]}\n\n${feedback ? `The maintainer's corrections. Follow them:\n<feedback>\n${feedback}\n</feedback>\n\n` : ''}Extracted rules (${rules.length}):\n<rules>\n${JSON.stringify(input, null, 1)}\n</rules>`,
      schema: guidanceSchema,
      maxTurns: 3,
      budgetUsd: 15,
      cache: false,
    });
    calls.push(...result.records);
    if (!result.output) { console.log(`  ${folder}/${topic}: failed (${result.error})`); return; }
    const { description, applies_to, rules: final } = result.output;
    const lines = [
      '---',
      `description: ${JSON.stringify(description)}`,
      `applyTo: ${JSON.stringify(applies_to.join(', '))}`,
      '---',
      '',
      `# ${titles[topic]}`,
      '',
      '<!-- Generated by `npm run train` from the sources each rule cites. To change a rule for good, change its source or say so in training/feedback.md; the next training run regenerates this file. -->',
      '',
      ...final.map((r) => formatBullet(r, ruleScope(r.sources, scopes))),
      '',
    ];
    writeFileSync(path.join(out, `${topic}.md`), lines.join('\n'));
    console.log(`  ${folder}/${topic}: ${rules.length} extracted rules -> ${final.length}, $${totalCost(result.records).toFixed(2)}`);
  });
}

// Copies the rules of the closed `review-guidance` issues `/review teach org` opened into training/feedback.md, before
// the generalization reads it. GitHub is read with GH_TOKEN, GITHUB_TOKEN or gh's login, or without a token.
async function updateFeedback(): Promise<void> {
  let token = process.env['GH_TOKEN'] || process.env['GITHUB_TOKEN'];
  if (!token) {
    try { token = execFileSync('gh', ['auth', 'token'], { encoding: 'utf8' }).trim() || undefined; } catch { token = undefined; console.warn('No GitHub token from GH_TOKEN, GITHUB_TOKEN or `gh auth token`; reading the guidance issues without one.'); }
  }
  const rules = taughtRules(await fetchGuidanceIssues(orgGuidanceRepository, token));
  const file = path.join(root, 'training', 'feedback.md');
  const before = existsSync(file) ? readFileSync(file, 'utf8') : '';
  const after = withTaughtRules(before, rules);
  if (after !== before.replace(/\r\n/g, '\n')) writeFileSync(file, after);
  console.log(`training/feedback.md: ${rules.length} rules taught with /review teach org`);
}

async function main(): Promise<void> {
  if (process.argv.includes('--retag')) {
    retag(['guidance', 'guidance-holdout']);
    return;
  }
  const key = process.env['CODE_REVIEW_BEDROCK_KEY'] ?? process.env['AWS_BEARER_TOKEN_BEDROCK'];
  if (!key) throw new Error('Set AWS_BEARER_TOKEN_BEDROCK to train on Bedrock.');
  const proxy = await startProxy({ bedrockKey: key });
  const run: AgentRun = { provider: 'bedrock', proxyUrl: proxy.url };
  const calls: CallRecord[] = [];
  try {
    const repository = arg('repo');
    if (repository && !process.argv.includes('--generalize-only')) {
      const checkout = arg('checkout');
      if (!checkout) throw new Error('Pass --checkout with a clone of the repository at its default branch.');
      const { dir: extractedDir, repoName } = extractedFolder(path.join(root, 'training', 'extracted'), repository);
      const only = arg('only')?.split(',');
      const maintainer = arg('maintainer') ?? 'polewskm';
      const comments = fetchPullComments(repository);
      const sources = [
        ...decisionRecords(checkout, repoName),
        ...conventionFiles(checkout, repoName),
        ...maintainerComments(comments, repoName, maintainer),
        ...outcomeSources(comments, repoName, maintainer),
      ].filter((s) => !only || only.some((o) => s.id.includes(o)));
      console.log(`${sources.length} sources from ${repository}`);
      if (process.argv.includes('--list')) {
        const kinds = new Map<string, number>();
        for (const s of sources) kinds.set(s.kind, (kinds.get(s.kind) ?? 0) + 1);
        console.log([...kinds].map(([k, n]) => `${k}: ${n}`).join(', '), `| ${Math.round(sources.reduce((n, s) => n + s.text.length, 0) / 1000)}K characters`);
        return;
      }
      await extract(run, sources, extractedDir, calls, !only);
    }
    // The maintainer's own sources, such as review prompts that have worked well, belong to no one repository.
    if (!process.argv.includes('--generalize-only') && !process.argv.includes('--list')) {
      const dir = path.join(root, 'training', 'sources');
      const own: Source[] = existsSync(dir)
        ? readdirSync(dir).filter((n) => n.endsWith('.md')).map((name) => ({
            kind: 'maintainer', id: name.slice(0, -3), label: `NCodeGroup maintainer: ${name.slice(0, -3)}`, text: readFileSync(path.join(dir, name), 'utf8'),
          }))
        : [];
      if (own.length) await extract(run, own, path.join(root, 'training', 'extracted', 'NCodeGroup-maintainer'), calls, true);
    }
    if (!process.argv.includes('--extract-only')) {
      if (!process.argv.includes('--no-taught-rules')) await updateFeedback();
      const cases = JSON.parse(readFileSync(path.join(root, 'evals', 'cases.json'), 'utf8')) as Parameters<typeof holdoutLabels>[0];
      if (!process.argv.includes('--holdout-only')) await generalize(run, calls, 'guidance');
      await generalize(run, calls, 'guidance-holdout', holdoutLabels(cases));
    }
  } finally {
    await proxy.close();
  }
  console.log(`Training cost $${totalCost(calls).toFixed(2)} over ${calls.length} calls.`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}

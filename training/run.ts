// Teaches the review bot NCodeGroup-wide rules from a repository's own decisions, conventions, standards, review
// prompts and its maintainer's review comments.
//
//   node training/run.ts --repo NCodeGroup/Identity --checkout C:\GitHub\NCode\Identity [--maintainer polewskm]
//   node training/run.ts --generalize-only [--holdout-only]
//
// 1. Extract: Opus reads each source and lists the rules a reviewer could check, phrased in general terms. The result
//    is saved under training/extracted/<repository>/ with the source's content hash, so a rerun reads only sources that
//    changed.
// 2. Generalize: Opus merges every repository's extracted rules, topic by topic, into guidance/<topic>.md, which the
//    engine gives the conventions reviewer in every repository. training/feedback.md holds the maintainer's
//    corrections, and every generalization follows them.
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
import { runAgent, type AgentRun, type CallRecord } from '../src/agent.ts';
import { startProxy } from '../src/proxy.ts';
import { mapWithConcurrency } from '../src/review.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const topics = [
  'allocations-and-buffers', 'text-and-encoding', 'async-and-concurrency', 'public-api', 'errors-and-validation',
  'security-and-crypto', 'protocols', 'testing', 'logging-and-telemetry', 'configuration-and-options',
  'dependency-injection', 'persistence', 'code-organization', 'documentation', 'performance',
] as const;

interface Source { kind: string; id: string; label: string; text: string }
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
interface Extracted { hash: string; promptHash: string; label: string; rules: Rule[] }

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

// The source labels the eval cases draw on: the review of each pull request a case names, and each decision record its
// source cites. Labels look like "Identity review of #341" and "Identity ADR-0266".
export function holdoutLabels(cases: { id: string; repository: string; pullRequest?: number; source?: string }[]): Set<string> {
  const labels = new Set<string>();
  for (const c of cases) {
    const repo = c.repository.split('/')[1]!;
    const text = `${c.id} ${c.source ?? ''}`;
    const pulls = new Set<number>(c.pullRequest ? [c.pullRequest] : []);
    for (const m of text.matchAll(/(?:\/pull\/|#|^comments-)(\d+)/g)) pulls.add(Number(m[1]));
    for (const pull of pulls) labels.add(`${repo} review of #${pull}`);
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
      chunkByHeading(readFileSync(path.join(instructions, name), 'utf8')).forEach((text, i) =>
        sources.push({ kind: 'instructions', id: `${name.replace('.instructions.md', '')}-${i + 1}`, label: `${repoName} ${name}`, text }),
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

// The maintainer's top-level review comments with the diff they were on and the replies, one source per pull request.
function reviewComments(repository: string, repoName: string, maintainer: string): Source[] {
  const raw = execFileSync('gh', ['api', '--paginate', '--slurp', `repos/${repository}/pulls/comments?per_page=100`], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  const comments = (JSON.parse(raw) as any[][]).flat();
  const replies = new Map<number, any[]>();
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

async function extract(run: AgentRun, sources: Source[], outDir: string, calls: CallRecord[]): Promise<void> {
  const prompt = readFileSync(path.join(root, 'training', 'prompts', 'extract.md'), 'utf8');
  const promptHash = sha(prompt);
  let reused = 0, failed = 0;
  await mapWithConcurrency(sources, 6, async (source) => {
    const file = path.join(outDir, source.kind, `${source.id}.json`);
    const hash = sha(source.text);
    // Read it directly rather than checking first, so the file can't change between the check and the read.
    let text: string | undefined;
    try { text = readFileSync(file, 'utf8'); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    if (text !== undefined) {
      const saved = JSON.parse(text) as Extracted;
      if (saved.hash === hash && saved.promptHash === promptHash) { reused++; return; }
    }
    const result = await runAgent<{ rules: Rule[] }>(run, {
      role: `extract:${source.kind}`,
      tier: 'opus',
      systemPrompt: prompt,
      prompt: `Source: ${source.label}\n\n<source>\n${source.text}\n</source>`,
      schema: extractSchema,
      maxTurns: 3,
      budgetUsd: 3,
      cache: false,
    });
    calls.push(...result.records);
    if (!result.output) { failed++; console.log(`  ${source.label}: failed (${result.error})`); return; }
    mkdirSync(path.dirname(file), { recursive: true });
    const saved: Extracted = { hash, promptHash, label: source.label, rules: result.output.rules };
    writeFileSync(file, `${JSON.stringify(saved, null, 2)}\n`);
    console.log(`  ${source.label}: ${result.output.rules.length} rules, $${result.records.reduce((sum, r) => sum + r.costUsd, 0).toFixed(3)}`);
  });
  console.log(`Extracted ${sources.length - reused - failed} sources, reused ${reused}, failed ${failed}.`);
}

function loadExtracted(): { rule: Rule; source: string }[] {
  const all: { rule: Rule; source: string }[] = [];
  const base = path.join(root, 'training', 'extracted');
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.json')) {
        const saved = JSON.parse(readFileSync(full, 'utf8')) as Extracted;
        for (const rule of saved.rules) all.push({ rule, source: saved.label });
      }
    }
  };
  if (existsSync(base)) walk(base);
  return all;
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
  console.log(`${folder}/: ${usable.length} rules${exclude.size ? `, holding out ${exclude.size} sources` : ''}`);
  const out = path.join(root, folder);
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });
  await mapWithConcurrency([...topics], 4, async (topic) => {
    const rules = usable.filter(({ rule }) => rule.topic === topic);
    if (!rules.length) return;
    const input = rules.map(({ rule, source }) => ({ ...rule, source }));
    const result = await runAgent<{ description: string; applies_to: string[]; rules: { statement: string; why: string; check: string; sources: string[]; note?: string }[] }>(run, {
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
      ...final.map((r) => `- **${r.statement}** ${r.why} *Check:* ${r.check}${r.note ? ` *Note:* ${r.note}` : ''} <sub>${r.sources.join('; ')}</sub>`),
      '',
    ];
    writeFileSync(path.join(out, `${topic}.md`), lines.join('\n'));
    console.log(`  ${folder}/${topic}: ${rules.length} extracted rules -> ${final.length}, $${result.records.reduce((sum, r) => sum + r.costUsd, 0).toFixed(2)}`);
  });
}

async function main(): Promise<void> {
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
      const repoName = repository.split('/')[1]!;
      const only = arg('only')?.split(',');
      const sources = [
        ...decisionRecords(checkout, repoName),
        ...conventionFiles(checkout, repoName),
        ...reviewComments(repository, repoName, arg('maintainer') ?? 'polewskm'),
      ].filter((s) => !only || only.some((o) => s.id.includes(o)));
      console.log(`${sources.length} sources from ${repository}`);
      if (process.argv.includes('--list')) {
        const kinds = new Map<string, number>();
        for (const s of sources) kinds.set(s.kind, (kinds.get(s.kind) ?? 0) + 1);
        console.log([...kinds].map(([k, n]) => `${k}: ${n}`).join(', '), `| ${Math.round(sources.reduce((n, s) => n + s.text.length, 0) / 1000)}K characters`);
        return;
      }
      await extract(run, sources, path.join(root, 'training', 'extracted', repository.replace('/', '-')), calls);
    }
    // The maintainer's own sources, such as review prompts that have worked well, belong to no one repository.
    if (!process.argv.includes('--generalize-only') && !process.argv.includes('--list')) {
      const dir = path.join(root, 'training', 'sources');
      const own: Source[] = existsSync(dir)
        ? readdirSync(dir).filter((n) => n.endsWith('.md')).map((name) => ({
            kind: 'maintainer', id: name.slice(0, -3), label: `NCodeGroup maintainer: ${name.slice(0, -3)}`, text: readFileSync(path.join(dir, name), 'utf8'),
          }))
        : [];
      if (own.length) await extract(run, own, path.join(root, 'training', 'extracted', 'NCodeGroup-maintainer'), calls);
    }
    if (!process.argv.includes('--extract-only')) {
      const cases = JSON.parse(readFileSync(path.join(root, 'evals', 'cases.json'), 'utf8')) as Parameters<typeof holdoutLabels>[0];
      if (!process.argv.includes('--holdout-only')) await generalize(run, calls, 'guidance');
      await generalize(run, calls, 'guidance-holdout', holdoutLabels(cases));
    }
  } finally {
    await proxy.close();
  }
  console.log(`Training cost $${calls.reduce((sum, c) => sum + c.costUsd, 0).toFixed(2)} over ${calls.length} calls.`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}

// Stage 0: everything the reviewers see, read from the checkouts without running anything from them.

import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { maxConventionChars, maxDiffChars, maxPullRequestTextChars } from './config.ts';

export interface PullRequest {
  repository: string;
  number: number;
  title: string;
  // Present only when the author has write access; anyone else's text stays out of the prompts.
  body?: string;
  author: string;
  authorAssociation: string;
  draft: boolean;
  baseRef: string;
  baseSha: string;
  headSha: string;
}

export interface ChangedFile {
  path: string;
  additions: number;
  deletions: number;
  generated: boolean;
  shown: boolean;
}

export interface Gathered {
  pullRequest: PullRequest;
  mergeBase: string;
  files: ChangedFile[];
  diff: string;
  conventions: string;
  // Only the conventions reviewer gets these: they're large.
  reviewRules: RuleFile[];
  // Commit subjects, present only when the author has write access.
  commits: string[];
}

const writers = new Set(['OWNER', 'MEMBER', 'COLLABORATOR']);

const generatedPatterns = [
  /(^|\/)(package-lock\.json|pnpm-lock\.yaml|yarn\.lock|packages\.lock\.json|Cargo\.lock|poetry\.lock|uv\.lock)$/,
  /\.Designer\.cs$/,
  /ModelSnapshot\.cs$/,
  /\.g\.(cs|ts|js)$/,
  /\.min\.(js|css)$/,
  /\.(snap|svg|png|jpg|jpeg|gif|ico|pdf|zip|dll|exe|nupkg)$/i,
  /(^|\/)(dist|node_modules|bin|obj)\//,
];

export function isGenerated(file: string): boolean {
  return generatedPatterns.some((pattern) => pattern.test(file));
}

const docPattern = /(\.md|\.txt|\.rst)$|(^|\/)docs?\//i;
const testPattern = /(^|\/)(tests?|__tests__|spec)\/|\.(test|spec|tests)\.[a-z]+$|Tests?\.cs$/i;

// Product code first, then tests, then everything else: when the diff is over budget, what's left out is the least risky.
export function reviewOrder(file: string): number {
  if (docPattern.test(file)) return 3;
  if (testPattern.test(file)) return 1;
  if (/^(\.github|\.template|\.claude|build)\//.test(file)) return 2;
  return 0;
}

function git(repository: string, args: string[]): string {
  return execFileSync('git', ['-C', repository, '-c', 'core.quotePath=false', ...args], {
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_EXTERNAL_DIFF: '', GIT_PAGER: 'cat' },
  });
}

// Splits a unified diff into per-file sections keyed by the new path (the old one for a deletion).
export function splitDiff(diff: string): Map<string, string> {
  const sections = new Map<string, string>();
  const parts = diff.split(/^(?=diff --git )/m).filter((part) => part.startsWith('diff --git '));
  for (const part of parts) {
    const plus = /^\+\+\+ b\/(.+)$/m.exec(part)?.[1];
    const minus = /^--- a\/(.+)$/m.exec(part)?.[1];
    const header = /^diff --git a\/.+ b\/(.+)$/m.exec(part)?.[1];
    const file = plus ?? minus ?? header;
    if (file) sections.set(file.trim(), part);
  }
  return sections;
}

export function budgetDiff(files: ChangedFile[], sections: Map<string, string>, budget: number): string {
  let used = 0;
  const out: string[] = [];
  const ordered = [...files].sort((a, b) => reviewOrder(a.path) - reviewOrder(b.path) || a.path.localeCompare(b.path));
  for (const file of ordered) {
    const section = sections.get(file.path);
    if (file.generated) {
      out.push(`diff --git a/${file.path} b/${file.path}\n[generated file: ${file.additions + file.deletions} changed lines not shown]\n`);
      file.shown = true;
      continue;
    }
    if (!section) continue;
    if (used + section.length > budget) continue;
    out.push(section);
    used += section.length;
    file.shown = true;
  }
  return out.join('');
}

function parseNumstat(numstat: string): ChangedFile[] {
  const files: ChangedFile[] = [];
  for (const line of numstat.split('\n')) {
    const match = /^(\d+|-)\t(\d+|-)\t(.+)$/.exec(line);
    if (!match) continue;
    let file = match[3]!;
    // A rename shows as "dir/{old => new}/file" or "old => new".
    file = file.replace(/\{[^{}]* => ([^{}]*)\}/, '$1').replace(/^.* => /, '').replace(/\/\//g, '/');
    const binary = match[1] === '-';
    files.push({
      path: file,
      additions: binary ? 0 : Number(match[1]),
      deletions: binary ? 0 : Number(match[2]),
      generated: binary || isGenerated(file),
      shown: false,
    });
  }
  return files;
}

// Every reviewer gets these: the sections of AGENTS.md that state conventions, from the default branch.
export function readConventions(basePath: string): string {
  const parts: string[] = [];
  const agents = path.join(basePath, 'AGENTS.md');
  if (existsSync(agents)) {
    const text = readFileSync(agents, 'utf8');
    for (const section of text.split(/^(?=## )/m)) {
      if (/^## (Layout|Coding conventions|Known pending work)\b/.test(section)) parts.push(`From AGENTS.md:\n${section.trim()}`);
    }
  }
  const joined = parts.join('\n\n');
  return joined.length > maxConventionChars ? `${joined.slice(0, maxConventionChars)}\n[conventions truncated]` : joined;
}

// A glob as Copilot's applyTo and Claude Code's paths use them: ** spans folders, * and ? stay within one.
export function globToRegExp(glob: string): RegExp {
  let pattern = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!;
    if (c === '*' && glob[i + 1] === '*') {
      i++;
      if (glob[i + 1] === '/') {
        i++;
        pattern += '(?:.*/)?';
      } else {
        pattern += '.*';
      }
    } else if (c === '*') pattern += '[^/]*';
    else if (c === '?') pattern += '[^/]';
    else pattern += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${pattern}$`);
}

function frontmatter(text: string): { fields: Map<string, string>; body: string } {
  const fields = new Map<string, string>();
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
  if (!match) return { fields, body: text };
  for (const line of match[1]!.split(/\r?\n/)) {
    const field = /^([A-Za-z]+):\s*(.*)$/.exec(line);
    if (field) fields.set(field[1]!, field[2]!.trim().replace(/^["']|["']$/g, ''));
  }
  return { fields, body: text.slice(match[0].length) };
}

// Drops rules marked ✅ (tool-enforced: the build already fails on them) with their continuation lines. Rules marked
// 👁 (review-only) and ⏳ (rolling out) stay, because only a reviewer catches them.
export function dropToolEnforced(text: string): string {
  const out: string[] = [];
  let skipIndent = -1;
  for (const line of text.split('\n')) {
    if (skipIndent >= 0) {
      const indent = /^\s*/.exec(line)![0].length;
      if (line.trim() === '' || indent > skipIndent) continue;
      skipIndent = -1;
    }
    const tool = /^(\s*)- ✅(?!\/)/.exec(line);
    if (tool) {
      skipIndent = tool[1]!.length;
      continue;
    }
    out.push(line);
  }
  return out.join('\n');
}

export interface RuleFile {
  name: string;
  globs: string[];
  text: string;
}

// The repository's review rules for the files this pull request changes, from the default branch: each
// .github/instructions/*.instructions.md whose applyTo matches a changed file, without its tool-enforced rules. The
// most specific files come first; ones that apply to everything (**) come last.
export function readReviewRules(basePath: string, changed: string[]): RuleFile[] {
  const folder = path.join(basePath, '.github', 'instructions');
  if (!existsSync(folder)) return [];
  const files: RuleFile[] = [];
  for (const name of readdirSync(folder).filter((n) => n.endsWith('.instructions.md')).sort()) {
    const { fields, body } = frontmatter(readFileSync(path.join(folder, name), 'utf8'));
    const globs = (fields.get('applyTo') ?? '').split(',').map((g) => g.trim()).filter(Boolean);
    const patterns = globs.map(globToRegExp);
    if (!changed.some((file) => patterns.some((p) => p.test(file)))) continue;
    files.push({ name, globs, text: `From .github/instructions/${name} (applies to ${globs.join(', ')}):\n${dropToolEnforced(body).trim()}` });
  }
  const general = (f: RuleFile) => (f.globs.every((g) => g === '**') ? 1 : 0);
  return files.sort((a, b) => general(a) - general(b));
}

// Packs rule files into batches of at most `budget` characters, one conventions call each. A file bigger than the
// budget gets a batch of its own, cut to fit.
export function batchRules(files: RuleFile[], budget: number): string[] {
  const batches: string[][] = [];
  let size = budget;
  for (const file of files) {
    const text = file.text.length > budget ? `${file.text.slice(0, budget - 40)}\n[rules cut to fit]` : file.text;
    if (size + text.length > budget) {
      batches.push([]);
      size = 0;
    }
    batches.at(-1)!.push(text);
    size += text.length + 2;
  }
  return batches.map((b) => b.join('\n\n'));
}

export function readPullRequest(event: any, repository: string): PullRequest {
  const pr = event.pull_request ?? event.issue;
  if (!pr) throw new Error('The event has no pull request.');
  const association = String(pr.author_association ?? '');
  const body = typeof pr.body === 'string' ? pr.body.slice(0, maxPullRequestTextChars) : undefined;
  return {
    repository,
    number: Number(pr.number),
    title: String(pr.title ?? ''),
    ...(writers.has(association) && body ? { body } : {}),
    author: String(pr.user?.login ?? ''),
    authorAssociation: association,
    draft: Boolean(pr.draft),
    baseRef: String(pr.base?.ref ?? ''),
    baseSha: String(pr.base?.sha ?? ''),
    headSha: String(pr.head?.sha ?? ''),
  };
}

export function gather(pullRequest: PullRequest, prPath: string, basePath: string): Gathered {
  // Review exactly what's checked out. For a /review comment, the pull request may have moved between the API read and
  // the checkout, and the check run belongs on the commit that was reviewed.
  pullRequest.headSha = git(prPath, ['rev-parse', 'HEAD']).trim();
  const mergeBase = git(prPath, ['merge-base', pullRequest.baseSha, pullRequest.headSha]).trim();
  const range = [mergeBase, pullRequest.headSha];
  const files = parseNumstat(git(prPath, ['diff', '--numstat', '-M', '--no-ext-diff', '--no-textconv', ...range]));
  const fullDiff = git(prPath, ['diff', '-M', '--no-ext-diff', '--no-textconv', '--no-color', '--unified=5', ...range]);
  const diff = budgetDiff(files, splitDiff(fullDiff), maxDiffChars);
  const reviewed = files.filter((f) => !f.generated).map((f) => f.path);
  const commits = writers.has(pullRequest.authorAssociation)
    ? git(prPath, ['log', '--format=%s', '--no-merges', '-n', '60', `${mergeBase}..${pullRequest.headSha}`]).split('\n').filter(Boolean)
    : [];
  return { pullRequest, mergeBase, files, diff, conventions: readConventions(basePath), reviewRules: readReviewRules(basePath, reviewed), commits };
}

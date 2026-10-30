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

// The sections of AGENTS.md that state conventions, plus .claude/rules, all from the default branch.
export function readConventions(basePath: string): string {
  const parts: string[] = [];
  const agents = path.join(basePath, 'AGENTS.md');
  if (existsSync(agents)) {
    const text = readFileSync(agents, 'utf8');
    for (const section of text.split(/^(?=## )/m)) {
      if (/^## (Layout|Coding conventions|Known pending work)\b/.test(section)) parts.push(`From AGENTS.md:\n${section.trim()}`);
    }
  }
  const rules = path.join(basePath, '.claude', 'rules');
  if (existsSync(rules)) {
    for (const name of readdirSync(rules).filter((n) => n.endsWith('.md')).sort()) {
      parts.push(`From .claude/rules/${name}:\n${readFileSync(path.join(rules, name), 'utf8').trim()}`);
    }
  }
  const joined = parts.join('\n\n');
  return joined.length > maxConventionChars ? `${joined.slice(0, maxConventionChars)}\n[conventions truncated]` : joined;
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
  const mergeBase = git(prPath, ['merge-base', pullRequest.baseSha, pullRequest.headSha]).trim();
  const range = [mergeBase, pullRequest.headSha];
  const files = parseNumstat(git(prPath, ['diff', '--numstat', '-M', '--no-ext-diff', '--no-textconv', ...range]));
  const fullDiff = git(prPath, ['diff', '-M', '--no-ext-diff', '--no-textconv', '--no-color', '--unified=5', ...range]);
  const diff = budgetDiff(files, splitDiff(fullDiff), maxDiffChars);
  return { pullRequest, mergeBase, files, diff, conventions: readConventions(basePath) };
}

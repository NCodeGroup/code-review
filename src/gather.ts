// Stage 0: everything the reviewers see, read from the checkouts without running anything from them.

import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { maxChunkChars, maxChunks, maxConventionChars, maxPullRequestTextChars, type ModelTier } from './config.ts';
import { readDecisions, readProposedDecisions, type Decision } from './context.ts';
import { bulletGlobs } from './guidance.ts';
import { globList, readProjectSettings, settingsFolder, splitFrontmatter, type ProjectCharter } from './settings.ts';
import { answersFile, isTemplateOwned, readTemplate, type Template } from './template.ts';
export { maxIssueChars } from './config.ts';

export interface PullRequest {
  repository: string;
  number: number;
  title: string;
  // Present only when the author has write access; anyone else's text stays out of the prompts.
  body?: string;
  // Issues the description says it closes, each present only when its author has write access.
  issues?: { number: number; title: string; body: string }[];
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
  // The project template's file, which a template update replaces: findings on it belong upstream.
  templateOwned?: boolean;
}

export interface Gathered {
  pullRequest: PullRequest;
  mergeBase: string;
  files: ChangedFile[];
  // Every part of the diff, joined.
  diff: string;
  // The diff in the parts the reviewers get, one set of reviewers per part.
  chunks: string[];
  conventions: string;
  // Only the conventions reviewer gets these: they're large.
  reviewRules: RuleFile[];
  // NCodeGroup-wide guidance the training learned, one file per topic, for the changed files.
  guidance: RuleFile[];
  // The repository's accepted decision records from the default branch, after the ones the pull request adds or changes.
  decisions: Decision[];
  // Commit subjects, present only when the author has write access.
  commits: string[];
  // From the repository's .github/code-review/ on the default branch, never the pull request's copy:
  // path globs config.yml marks sensitive, for deeper review (issue #42);
  sensitive: string[];
  // changed files config.yml's skip: leaves out of the review, listed in the check run;
  skippedByConfig: string[];
  // the policies config.yml names that reached the conventions, by path;
  policies: string[];
  // each reviewer's model, from config.yml's tiers:;
  tiers: Record<string, ModelTier>;
  // the project's own reviewers, which join the roster as project:<name>;
  projectReviewers: ProjectCharter[];
  // and what in those settings couldn't be used, for the check run.
  warnings: string[];
  // The project template the repository is made from, when it's one whose files the engine knows.
  template?: Template;
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

export function isDocumentation(file: string): boolean {
  return docPattern.test(file);
}

// Product code first, then tests, then everything else: when the diff is over budget, what's left out is the least risky.
export function reviewOrder(file: string): number {
  if (docPattern.test(file)) return 3;
  if (testPattern.test(file)) return 1;
  if (/^(\.github|\.template|\.claude|build)\//.test(file)) return 2;
  return 0;
}

// After every rank reviewOrder gives: the template's files go last, so they're the first left out of an oversized diff.
const templateOrder = Number.MAX_SAFE_INTEGER;

export function git(repository: string, args: string[]): string {
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

// Packs the per-file sections into parts of at most chunkChars, in review order so neighbouring files share a part, with
// the template's files last. Generated files get a one-line stub in the first part. A file too big for any part, or past
// the last part, is left out.
export function chunkDiff(files: ChangedFile[], sections: Map<string, string>, chunkChars: number, maxChunks: number): string[] {
  const chunks: string[][] = [[]];
  const used = [0];
  const order = (file: ChangedFile) => (file.templateOwned ? templateOrder : reviewOrder(file.path));
  const ordered = [...files].sort((a, b) => order(a) - order(b) || a.path.localeCompare(b.path));
  for (const file of ordered) {
    const section = sections.get(file.path);
    if (file.generated) {
      chunks[0]!.push(`diff --git a/${file.path} b/${file.path}\n[generated file: ${file.additions + file.deletions} changed lines not shown]\n`);
      file.shown = true;
      continue;
    }
    if (!section || section.length > chunkChars) continue;
    let index = used[used.length - 1]! + section.length <= chunkChars ? used.length - 1 : -1;
    if (index === -1 && chunks.length < maxChunks) {
      chunks.push([]);
      used.push(0);
      index = chunks.length - 1;
    }
    // Every part is full: fit the file into any part with room left.
    if (index === -1) index = used.findIndex((u) => u + section.length <= chunkChars);
    if (index === -1) continue;
    chunks[index]!.push(section);
    used[index]! += section.length;
    file.shown = true;
  }
  return chunks.map((chunk) => chunk.join(''));
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

export function matchesAnyFile(globs: string[], files: string[]): boolean {
  const patterns = globs.map(globToRegExp);
  return files.some((file) => patterns.some((p) => p.test(file)));
}

// The instruction files' frontmatter, read leniently line by line: they come from the template and other tools, in
// YAML the settings parser would refuse. The split and the glob lists are shared with the project reviewers' paths:.
function frontmatter(text: string): { fields: Map<string, string>; body: string } {
  const fields = new Map<string, string>();
  const { frontmatter: yaml, body } = splitFrontmatter(text);
  for (const line of yaml?.split(/\r?\n/) ?? []) {
    const field = /^([A-Za-z]+):\s*(.*)$/.exec(line);
    if (field) fields.set(field[1]!, field[2]!.trim().replace(/^["']|["']$/g, ''));
  }
  return { fields, body };
}

// The globs an instruction file's frontmatter applyTo lists.
export function applyToGlobs(text: string): string[] {
  return globList(frontmatter(text).fields.get('applyTo') ?? '');
}

// Drops the bullets tagged for files this pull request doesn't change. Untagged bullets and other lines stay.
export function keepBulletsFor(text: string, changed: string[]): string {
  return text
    .split('\n')
    .filter((line) => {
      if (!line.startsWith('- **')) return true;
      const globs = bulletGlobs(line);
      return !globs.length || matchesAnyFile(globs, changed);
    })
    .join('\n');
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
  return readRuleFolder(path.join(basePath, '.github', 'instructions'), '.instructions.md', changed, '.github/instructions');
}

// NCodeGroup-wide rules the training learned (guidance/*.md in the engine), for the files this pull request changes:
// a topic file whose applyTo matches a changed file, without the bullets tagged for files the pull request doesn't
// change, so a rule learned from C# conventions never reaches a review of TypeScript.
export function readGuidance(guidanceDir: string, changed: string[]): RuleFile[] {
  return readRuleFolder(guidanceDir, '.md', changed, 'NCodeGroup guidance', (body) => keepBulletsFor(body, changed))
    .filter((file) => file.text.split('\n').some((line) => line.startsWith('- **')));
}

function readRuleFolder(folder: string, suffix: string, changed: string[], label: string, filter = (body: string) => body): RuleFile[] {
  if (!existsSync(folder)) return [];
  const files: RuleFile[] = [];
  for (const name of readdirSync(folder).filter((n) => n.endsWith(suffix)).sort()) {
    const file = ruleFile(name, label, readFileSync(path.join(folder, name), 'utf8'), changed, [], filter);
    if (file) files.push(file);
  }
  const general = (f: RuleFile) => (f.globs.every((g) => g === '**') ? 1 : 0);
  return files.sort((a, b) => general(a) - general(b));
}

// A rule file when its applyTo (or, without one, defaultGlobs) matches a changed file.
function ruleFile(name: string, label: string, text: string, changed: string[], defaultGlobs: string[] = [], filter = (body: string) => body): RuleFile | undefined {
  const { body } = frontmatter(text);
  const applyTo = applyToGlobs(text);
  const globs = applyTo.length ? applyTo : defaultGlobs;
  if (!matchesAnyFile(globs, changed)) return undefined;
  return { name, globs, text: `From ${label}/${name} (applies to ${globs.join(', ')}):\n${filter(dropToolEnforced(body)).trim()}` };
}

// The project's rules in .github/code-review/guidance.md, which join the catalog like the instruction files. Without
// an applyTo, they apply to every file.
export function projectGuidanceRules(text: string | undefined, changed: string[]): RuleFile[] {
  const file = text === undefined ? undefined : ruleFile('guidance.md', settingsFolder, text, changed, ['**']);
  return file ? [file] : [];
}

// The conventions with the policies config.yml names after them, each with its path.
export function withPolicies(conventions: string, policies: { path: string; text: string }[]): string {
  return [conventions, ...policies.map((p) => `From ${p.path} (a policy named in ${settingsFolder}/config.yml):\n${p.text}`)].filter(Boolean).join('\n\n');
}

// The issue numbers a description closes ("Closes #12", "fixes #3", "Resolves #7").
export function closedIssues(body: string | undefined): number[] {
  const numbers = [...(body ?? '').matchAll(/\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s+#(\d+)\b/gi)].map((m) => Number(m[1]));
  return [...new Set(numbers)].slice(0, 5);
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

// The template whose files the review leaves to the template's repository, only for a pull request that adopts or
// updates the template, which changes the answers file, from an author with write access. Anywhere else a change to
// one of the template's files is an edit by hand, which the review treats as the project's. The default branch's answers
// count; an adoption adds the answers file, so the default branch has none, and then the head's count.
export function templateOf(pullRequest: PullRequest, files: ChangedFile[], prPath: string, basePath: string): Template | undefined {
  if (!writers.has(pullRequest.authorAssociation) || !files.some((f) => f.path === answersFile)) return undefined;
  return existsSync(path.join(basePath, answersFile)) ? readTemplate(basePath) : readTemplate(prPath);
}

// guidanceDir, when given, adds the NCodeGroup-wide guidance the training learned ahead of the repository's own rules.
export function gather(pullRequest: PullRequest, prPath: string, basePath: string, guidanceDir?: string): Gathered {
  // Review exactly what's checked out. For a /review comment, the pull request may have moved between the API read and
  // the checkout, and the check run belongs on the commit that was reviewed.
  pullRequest.headSha = git(prPath, ['rev-parse', 'HEAD']).trim();
  const mergeBase = git(prPath, ['merge-base', pullRequest.baseSha, pullRequest.headSha]).trim();
  const range = [mergeBase, pullRequest.headSha];
  // The repository's settings come from the default branch only, so a pull request can't soften its own review.
  const settings = readProjectSettings(basePath);
  const skip = settings.config.skip.map(globToRegExp);
  const changed = parseNumstat(git(prPath, ['diff', '--numstat', '-M', '--no-ext-diff', '--no-textconv', ...range]));
  // Whether the pull request adopts or updates the template doesn't depend on what skip: leaves out.
  const template = templateOf(pullRequest, changed, prPath, basePath);
  const skippedByConfig = changed.filter((f) => skip.some((p) => p.test(f.path))).map((f) => f.path);
  const files = changed.filter((f) => !skippedByConfig.includes(f.path));
  for (const file of files) if (isTemplateOwned(file.path, template)) file.templateOwned = true;
  const fullDiff = git(prPath, ['diff', '-M', '--no-ext-diff', '--no-textconv', '--no-color', '--unified=5', ...range]);
  const chunks = chunkDiff(files, splitDiff(fullDiff), maxChunkChars, maxChunks);
  const reviewed = files.filter((f) => !f.generated).map((f) => f.path);
  // The repository's rules and the guidance are for its own files, not the template's.
  const own = files.filter((f) => !f.generated && !f.templateOwned).map((f) => f.path);
  // A decision record the pull request adds or changes comes from its head, and outranks the default branch's copy.
  const proposed = readProposedDecisions(prPath, reviewed);
  const decisions = [...proposed, ...readDecisions(basePath).filter((d) => !proposed.some((p) => p.id === d.id))];
  const commits = writers.has(pullRequest.authorAssociation)
    ? git(prPath, ['log', '--format=%s', '--no-merges', '-n', '60', `${mergeBase}..${pullRequest.headSha}`]).split('\n').filter(Boolean)
    : [];
  return {
    pullRequest,
    mergeBase,
    files,
    diff: chunks.join(''),
    chunks,
    conventions: withPolicies(readConventions(basePath), settings.policies),
    reviewRules: [...readReviewRules(basePath, own), ...projectGuidanceRules(settings.guidance, own)],
    guidance: guidanceDir ? readGuidance(guidanceDir, own) : [],
    decisions,
    commits,
    sensitive: settings.config.sensitive,
    skippedByConfig,
    policies: settings.policies.map((p) => p.path),
    tiers: settings.config.tiers,
    projectReviewers: settings.reviewers,
    warnings: settings.warnings,
    ...(template ? { template } : {}),
  };
}

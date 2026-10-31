// Stage 0: everything the reviewers see, read from the checkouts without running anything from them.

import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { maxChunkChars, maxChunks, maxConventionChars, maxPullRequestTextChars, type ModelTier } from './config.ts';
import { readDecisions, readProposedDecisions, type Decision } from './context.ts';
import { bulletGlobs } from './guidance.ts';
import { globList, readProjectSettings, settingsFolder, splitFrontmatter, type ProjectCharter } from './settings.ts';
import { answersFile, isTemplateOwned, readTemplate, type Template } from './template.ts';

export interface PullRequest {
  repository: string;
  number: number;
  title: string;
  // Present only when the author has write access; anyone else's text stays out of the prompts.
  body?: string;
  // The pull request has a description, left out because its author lacks write access.
  bodyWithheld?: boolean;
  // Issues the description says it closes, each present only when its author has write access.
  issues?: { number: number; title: string; body: string }[];
  author: string;
  authorAssociation: string;
  // Whether the author has write access: the event's association, or failing that the repository's permissions.
  authorCanWrite: boolean;
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
  // A .cs file in a project the default branch packs: PublicAPI.Shipped.txt beside its .csproj, or IsPackable true in it.
  packable?: boolean;
  // A .cs file whose diff declares, removes or changes a public or protected member, judged from the file at the head.
  publicMember?: boolean;
  // A .cs file whose diff touches a serialized or persisted contract: JSON or data-contract names, a DbContext.
  serializedContract?: boolean;
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
  // The repository's open issues opened by people with write access, for synthesis to mark a finding one already tracks.
  openIssues?: { number: number; title: string }[];
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

const generatedPatterns = [
  /(^|\/)(package-lock\.json|pnpm-lock\.yaml|yarn\.lock|packages\.lock\.json|Cargo\.lock|poetry\.lock|uv\.lock)$/,
  /\.Designer\.cs$/,
  /ModelSnapshot\.cs$/,
  /\.g\.(cs|ts|js)$/,
  /\.min\.(js|css)$/,
  /\.(snap|png|jpg|jpeg|gif|ico|pdf|zip|dll|exe|nupkg)$/i,
  /(^|\/)(dist|node_modules|bin|obj)\//,
];

export function isGenerated(file: string): boolean {
  return generatedPatterns.some((pattern) => pattern.test(file));
}

export const publicApiPath = /(^|\/)PublicAPI\.[A-Za-z]+\.txt$/;

// Documentation, as an allowlist: a Markdown or reStructuredText file anywhere; a text file only at the repository root
// or in a doc/ or docs/ folder, since elsewhere one is as often a fixture, a data input or a license list; and an image
// other than an SVG, or a PDF, in a doc/ or docs/ folder. An SVG can carry script, so it is code wherever it is. Any
// other file, one with no extension included, isn't documentation, wherever it is: a script, a config file or a git hook
// in docs/ or in a template's folders is code. A text file that is a build or dependency list, such as CMakeLists.txt or
// a pip requirements file, isn't documentation, and neither is a public API listing: it is the API. The light review
// and the review order both use this one definition.
const documentationFile = /\.(md|rst)$/i;
const documentationText = /^[^/]+\.txt$|(^|\/)docs?\/.+\.txt$/i;
const documentationAsset = /(^|\/)docs?\/.+\.(png|jpe?g|gif|webp|pdf)$/i;
const listingFile = /(^|\/)(CMakeLists\.txt|(requirements|constraints)[^/]*\.txt)$/i;

export function isDocumentation(file: string): boolean {
  if (publicApiPath.test(file) || listingFile.test(file)) return false;
  return documentationFile.test(file) || documentationText.test(file) || documentationAsset.test(file);
}

const testPattern = /(^|\/)(tests?|__tests__|spec)\/|\.(test|spec|tests)\.[a-z]+$|Tests?\.cs$/i;

// Product code first, then tests, then everything else: when the diff is over budget, what's left out is the least risky.
export function reviewOrder(file: string): number {
  if (isDocumentation(file)) return 3;
  if (testPattern.test(file)) return 1;
  if (/^(\.github|\.template|\.claude|build)\//.test(file)) return 2;
  return 0;
}

const gitOptions = () => ({
  maxBuffer: 256 * 1024 * 1024,
  env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_EXTERNAL_DIFF: '', GIT_PAGER: 'cat' },
});
// After every rank reviewOrder gives: the template's files go last, so they're the first left out of an oversized diff.
const templateOrder = Number.MAX_SAFE_INTEGER;

export function git(repository: string, args: string[]): string {
  return execFileSync('git', ['-C', repository, '-c', 'core.quotePath=false', ...args], { ...gitOptions(), encoding: 'utf8' });
}

// Reads files at a commit as text, with one git process for all of them. A file git can't read is left out.
export function readBlobs(repository: string, commit: string, files: string[]): Map<string, string> {
  const blobs = new Map<string, string>();
  // One request per line: a path with a line break can't be asked for.
  const asked = files.filter((f) => !/[\r\n]/.test(f));
  if (!asked.length) return blobs;
  const input = asked.map((f) => `${commit}:${f}\n`).join('');
  let out: Buffer;
  try {
    out = execFileSync('git', ['-C', repository, 'cat-file', '--batch'], { ...gitOptions(), input });
  } catch {
    return blobs;
  }
  let at = 0;
  for (const file of asked) {
    const end = out.indexOf(0x0a, at);
    if (end < 0) break;
    // "<oid> <type> <size>" and the content, or "<name> missing" with none.
    const header = /^[0-9a-f]+ (\w+) (\d+)$/.exec(out.toString('utf8', at, end));
    at = end + 1;
    if (!header) continue;
    const size = Number(header[2]);
    if (header[1] === 'blob') blobs.set(file, out.toString('utf8', at, at + size));
    at += size + 1;
  }
  return blobs;
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

// Whether the .csproj nearest above a file packs it, read from the default branch's checkout only, so a pull request
// can't make its own project count as packed.
export function isPackableProject(basePath: string, file: string, cache = new Map<string, boolean>()): boolean {
  const parts = file.split('/');
  if (parts.some((p) => p === '' || p === '.' || p === '..')) return false;
  // Every folder the walk passes has no project of its own, so it gets the answer of the one it stops at.
  const visited: string[] = [];
  const answer = (packable: boolean) => {
    for (const folder of visited) cache.set(folder, packable);
    return packable;
  };
  for (let depth = parts.length - 1; depth >= 0; depth--) {
    const folder = parts.slice(0, depth).join('/');
    const known = cache.get(folder);
    if (known !== undefined) return answer(known);
    visited.push(folder);
    let names: string[];
    try {
      names = readdirSync(path.join(basePath, folder));
    } catch {
      continue;
    }
    const projects = names.filter((n) => n.endsWith('.csproj'));
    if (!projects.length) continue;
    return answer(names.includes('PublicAPI.Shipped.txt') || projects.some((p) => {
      try {
        return /<IsPackable>\s*true\s*<\/IsPackable>/i.test(readFileSync(path.join(basePath, folder, p), 'utf8'));
      } catch {
        // A project that can't be read counts as packed, so the floor fails closed.
        return true;
      }
    }));
  }
  return answer(false);
}

type Declaration =
  | { kind: 'namespace' }
  | { kind: 'type'; visible: boolean; membersPublic: boolean }
  | { kind: 'member'; visible: boolean };

const modifierRun = /^\s*(?:\[[^\]]*\]\s*)*((?:(?:public|protected|private|internal|static|virtual|override|abstract|sealed|async|extern|unsafe|new|readonly|partial|required|const|volatile|file|ref|event|implicit|explicit)\s+)*)/;
const accessWords = new Set(['public', 'protected', 'private', 'internal']);

// A C# line read as a declaration, from its leading modifiers. Members without an access modifier are private (or a
// statement) and read as nothing.
function declaration(line: string): Declaration | undefined {
  if (/^\s*namespace\b/.test(line)) return { kind: 'namespace' };
  const match = modifierRun.exec(line)!;
  const modifiers = match[1]!.split(/\s+/).filter(Boolean);
  const visible = modifiers.includes('public') || (modifiers.includes('protected') && !modifiers.includes('private'));
  const type = /^(class|struct|interface|enum|record)\s+[A-Za-z_@]/.exec(line.slice(match[0].length));
  if (type) return { kind: 'type', visible, membersPublic: type[1] === 'interface' || type[1] === 'enum' };
  if (modifiers.some((m) => accessWords.has(m))) return { kind: 'member', visible };
  return undefined;
}

const indentOf = (line: string) => /^\s*/.exec(line)![0].length;
const notCode = /^\s*([{}()[\]#]|\/\/|\/\*|\*)/;

interface Enclosing {
  indent: number;
  declaration: Declaration;
}

interface HeadScan {
  // The declarations above line `index` that could enclose it, outermost first: each less indented than the next.
  enclosing(index: number): Enclosing[];
  // The first line at or below `index` that is code, not a blank, a brace, an attribute or a comment.
  codeFrom(index: number): string | undefined;
}

// Reads a file at the head for the changed lines of its diff. Asked about lines in order, as a diff's hunks come, it
// reads each line once, so a large file costs its length and not its length times its changes.
function scanHead(lines: string[]): HeadScan {
  const isCode = (line: string) => line.trim() !== '' && !notCode.test(line);
  const stack: Enclosing[] = [];
  let position = 0;
  // Lines from codeStart up to codeEnd aren't code; codeEnd is, or is the end of the file.
  let codeStart = 0;
  let codeEnd = -1;
  return {
    enclosing(index) {
      if (index < position) {
        stack.length = 0;
        position = 0;
      }
      for (; position < Math.min(index, lines.length); position++) {
        const line = lines[position]!;
        // Not isCode: a declaration can follow an attribute on its line, and declaration() skips the attribute.
        const found = line.trim() !== '' ? declaration(line) : undefined;
        if (!found) continue;
        const indent = indentOf(line);
        while (stack.length && stack[stack.length - 1]!.indent >= indent) stack.pop();
        stack.push({ indent, declaration: found });
      }
      return stack;
    },
    codeFrom(index) {
      if (index < codeStart || index > codeEnd) {
        codeStart = index;
        codeEnd = index;
        while (codeEnd < lines.length && !isCode(lines[codeEnd]!)) codeEnd++;
      }
      return lines[codeEnd];
    },
  };
}

// Whether a changed line declares, or sits inside, a public or protected member of a public type. `above` is the number
// of the head's lines before it; the nearest declaration above with less indentation encloses it.
function inVisibleMember(head: HeadScan, above: number, code: string): boolean {
  let own = declaration(code);
  // An attribute belongs to the declaration below it.
  if (!own && /^\s*\[/.test(code)) {
    const next = head.codeFrom(above);
    own = next === undefined ? undefined : declaration(next);
  }
  if (own?.kind === 'namespace') return false;
  let found = own?.visible;
  if (found === false) return false;
  let indent = indentOf(code);
  const enclosing = head.enclosing(above);
  for (let i = enclosing.length - 1; i >= 0; i--) {
    const { indent: depth, declaration: outer } = enclosing[i]!;
    if (depth >= indent) continue;
    if (outer.kind === 'namespace') break;
    indent = depth;
    // Straight inside a class or struct, outside any member with an access modifier: a private field or a blank.
    if (found === undefined && outer.kind === 'type' && !outer.membersPublic) return false;
    if (!outer.visible) return false;
    found = true;
  }
  return found === true;
}

// Whether a .cs file's diff adds or removes a line that declares, or sits inside, a public or protected member: a
// change to the surface, or to the behavior behind it. head is the file at the pull request's head, '' when deleted.
export function touchesPublicMember(section: string, head: string): boolean {
  const scan = scanHead(head.split(/\r?\n/));
  let next = 0;
  let inHunk = false;
  for (const text of section.split('\n')) {
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(text);
    if (hunk) {
      next = Number(hunk[1]);
      inHunk = true;
      continue;
    }
    if (!inHunk) continue;
    if (text.startsWith(' ')) next++;
    if (!text.startsWith('+') && !text.startsWith('-')) continue;
    const code = text.slice(1).replace(/\r$/, '');
    // An added line is head line `next`; a removed one sits before it.
    const above = next - 1;
    if (text.startsWith('+')) next++;
    if (!code.trim() || /^\s*(\/\/|\/\*|\*)/.test(code)) continue;
    if (inVisibleMember(scan, above, code)) return true;
  }
  return false;
}

// DbContext has no leading \w*: it matches the same names, AppDbContext too, without backtracking through long words.
const contractMarker = /\b(?:JsonPropertyName|DataMember|JsonSerializerContext|IEntityTypeConfiguration)\b|DbContext\b/;

// Whether a file's diff, in its hunks with their context, touches a serialized or persisted contract.
export function touchesSerializedContract(section: string): boolean {
  const hunks = section.indexOf('\n@@');
  return hunks >= 0 && contractMarker.test(section.slice(hunks));
}

// Marks what the selection floor needs to know about each changed .cs file; which of them are tests is the floor's to
// say. Whether its project is packed comes from the default branch; the head's copies, read through readHeads as data,
// only place changed lines. A packed file whose head can't be read counts as a public change, so the floor fails closed.
export function markContracts(files: ChangedFile[], sections: Map<string, string>, basePath: string, readHeads: (files: string[]) => Map<string, string>): void {
  const projects = new Map<string, boolean>();
  const unread: { file: ChangedFile; section: string }[] = [];
  for (const file of files) {
    const section = sections.get(file.path);
    if (file.generated || !section || !/\.cs$/i.test(file.path)) continue;
    if (touchesSerializedContract(section)) file.serializedContract = true;
    if (!isPackableProject(basePath, file.path, projects)) continue;
    file.packable = true;
    if (!/^\+\+\+ \/dev\/null$/m.test(section)) unread.push({ file, section });
    else if (touchesPublicMember(section, '')) file.publicMember = true;
  }
  if (!unread.length) return;
  const heads = readHeads(unread.map(({ file }) => file.path));
  for (const { file, section } of unread) {
    const head = heads.get(file.path);
    if (head === undefined || touchesPublicMember(section, head)) file.publicMember = true;
  }
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

// canWrite is whether the author has write access, from writerCheck. It is required: the event's author_association
// alone reports a private organization member as CONTRIBUTOR.
export function readPullRequest(event: any, repository: string, canWrite: boolean): PullRequest {
  const pr = event.pull_request ?? event.issue;
  if (!pr) throw new Error('The event has no pull request.');
  const association = String(pr.author_association ?? '');
  const body = typeof pr.body === 'string' && pr.body.trim() ? pr.body.slice(0, maxPullRequestTextChars) : undefined;
  return {
    repository,
    number: Number(pr.number),
    title: String(pr.title ?? ''),
    ...(body ? (canWrite ? { body } : { bodyWithheld: true }) : {}),
    author: String(pr.user?.login ?? ''),
    authorAssociation: association,
    authorCanWrite: canWrite,
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
  if (!pullRequest.authorCanWrite || !files.some((f) => f.path === answersFile)) return undefined;
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
  const sections = splitDiff(fullDiff);
  markContracts(files, sections, basePath, (paths) => {
    const heads = readBlobs(prPath, pullRequest.headSha, paths);
    const unread = paths.filter((p) => !heads.has(p));
    // JSON quoting keeps a path with a line break from starting a workflow command of its own.
    if (unread.length) console.log(`::warning::Couldn't read ${unread.length} changed C# file(s) at the head (${unread.slice(0, 5).map((p) => JSON.stringify(p)).join(', ')}), so they count as public API changes.`);
    return heads;
  });
  const chunks = chunkDiff(files, sections, maxChunkChars, maxChunks);
  const reviewed = files.filter((f) => !f.generated).map((f) => f.path);
  // The repository's rules and the guidance are for its own files, not the template's.
  const own = files.filter((f) => !f.generated && !f.templateOwned).map((f) => f.path);
  // A decision record the pull request adds or changes comes from its head, and outranks the default branch's copy.
  const proposed = readProposedDecisions(prPath, reviewed);
  const decisions = [...proposed, ...readDecisions(basePath).filter((d) => !proposed.some((p) => p.id === d.id))];
  const commits = pullRequest.authorCanWrite
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

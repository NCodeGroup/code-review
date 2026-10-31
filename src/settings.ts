// The repository's own review settings, from .github/code-review/ on the default branch's checkout only, so a pull
// request can't soften its own review: config.yml, guidance.md and reviewers/*.md. Everything in them is data from the
// repository. A setting that can't be used is left out with a warning for the check run; it never fails the review.

import { closeSync, fstatSync, openSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { parseCharter } from './charter.ts';
import { maxPolicyChars, maxProjectReviewers, maxSettingsFileChars, minimumSecurityTier, tierRank, type ModelTier } from './config.ts';

export const settingsFolder = '.github/code-review';
const configPath = `${settingsFolder}/config.yml`;
const guidancePath = `${settingsFolder}/guidance.md`;
const reviewersPath = `${settingsFolder}/reviewers`;

export type YamlScalar = string | null;
export type YamlValue = YamlScalar | YamlScalar[] | Record<string, YamlScalar>;

export class YamlError extends Error {}

// The subset of YAML the settings use: top-level keys whose values are a scalar, a list or a mapping of scalars, as
// block or flow collections, with comments and quoted strings. Anchors, tags, multi-line strings and deeper nesting are
// refused, so a file never means something other than what it appears to.
export function parseYaml(text: string): Record<string, YamlValue> {
  const out: Record<string, YamlValue> = {};
  let open: { key: string; kind?: 'list' | 'map'; indent?: number } | undefined;
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const at = (message: string) => new YamlError(`line ${i + 1}: ${message}`);
    const line = stripComment(lines[i]!);
    if (!line.trim()) continue;
    if (line === '---' && !Object.keys(out).length) continue;
    const indent = /^[ \t]*/.exec(line)![0];
    if (indent.includes('\t')) throw at('indent with spaces, not tabs');
    const content = line.slice(indent.length);
    const item = /^-(?:\s+(.*))?$/.exec(content);
    if (item && open && open.kind !== 'map' && (open.indent === undefined || open.indent === indent.length)) {
      const value = item[1]?.trim();
      if (!value) throw at('a list item needs a value');
      if (/^[-[{]/.test(value) || splitKey(value)) throw at('a list item must be a single value');
      open.kind = 'list';
      open.indent = indent.length;
      const list = (out[open.key] ??= []) as YamlScalar[];
      list.push(parseScalar(value, at));
      continue;
    }
    if (indent.length > 0) {
      const entry = splitKey(content);
      if (!open || item || !entry || open.kind === 'list' || (open.indent !== undefined && open.indent !== indent.length)) throw at('unexpected indentation or nesting');
      if (!entry.rest) throw at(`"${entry.key}" needs a value`);
      if (/^[[{]/.test(entry.rest)) throw at('a nested value must be a single value');
      open.kind = 'map';
      open.indent = indent.length;
      const map = (out[open.key] ??= {}) as Record<string, YamlScalar>;
      checkKey(map, entry.key, at);
      map[entry.key] = parseScalar(entry.rest, at);
      continue;
    }
    const entry = splitKey(content);
    if (!entry) throw at('expected "key: value"');
    checkKey(out, entry.key, at);
    out[entry.key] = entry.rest ? parseInline(entry.rest, at) : null;
    open = entry.rest ? undefined : { key: entry.key };
  }
  return out;
}

// "__proto__" would set the parsed object's prototype instead of adding a key, so it is refused like a duplicate.
function checkKey(map: object, key: string, at: (message: string) => YamlError): void {
  if (key === '__proto__') throw at(`"${key}" is not allowed as a key`);
  if (Object.hasOwn(map, key)) throw at(`"${key}" appears twice`);
}

function stripComment(line: string): string {
  let quote = '';
  for (let i = 0; i < line.length; i++) {
    const c = line[i]!;
    if (quote) {
      if (c === '\\' && quote === '"') i++;
      else if (c === quote) quote = '';
    } else if (c === '"' || c === "'") {
      quote = c;
    } else if (c === '#' && (i === 0 || /\s/.test(line[i - 1]!))) {
      return line.slice(0, i).trimEnd();
    }
  }
  return line.trimEnd();
}

// "key: rest" or "key:", where the key may be quoted. "project:oauth: sonnet" has the key "project:oauth".
function splitKey(content: string): { key: string; rest: string } | undefined {
  const quoted = /^("(?:[^"\\]|\\.)*"|'(?:[^']|'')*')\s*:(?:\s+(.*))?$/.exec(content);
  if (quoted) return { key: parseScalar(quoted[1]!, (m) => new YamlError(m)) ?? '', rest: quoted[2]?.trim() ?? '' };
  if (/^["']/.test(content)) return undefined;
  const colon = /:(?:\s|$)/.exec(content);
  if (!colon) return undefined;
  const key = content.slice(0, colon.index).trim();
  if (!key || /^[-[\]{}&*!|>%@`#]/.test(key)) return undefined;
  return { key, rest: content.slice(colon.index + 1).trim() };
}

function parseInline(text: string, at: (message: string) => YamlError): YamlValue {
  if (text.startsWith('[')) {
    if (!text.endsWith(']')) throw at('a list in brackets must end with "]"');
    return splitFlow(text.slice(1, -1), at).map((item) => parseScalar(item, at));
  }
  if (text.startsWith('{')) {
    if (!text.endsWith('}')) throw at('a mapping in braces must end with "}"');
    const map: Record<string, YamlScalar> = {};
    for (const pair of splitFlow(text.slice(1, -1), at)) {
      const entry = splitKey(pair);
      if (!entry?.rest) throw at(`expected "key: value" in braces, not "${pair}"`);
      checkKey(map, entry.key, at);
      map[entry.key] = parseScalar(entry.rest, at);
    }
    return map;
  }
  return parseScalar(text, at);
}

function splitFlow(inner: string, at: (message: string) => YamlError): string[] {
  if (!inner.trim()) return [];
  const items: string[] = [];
  let quote = '';
  let start = 0;
  for (let i = 0; i < inner.length; i++) {
    const c = inner[i]!;
    if (quote) {
      if (c === '\\' && quote === '"') i++;
      else if (c === quote) quote = '';
    } else if (c === '"' || c === "'") {
      quote = c;
    } else if (c === '[' || c === ']' || c === '{' || c === '}') {
      throw at('nested collections are not supported');
    } else if (c === ',') {
      items.push(inner.slice(start, i).trim());
      start = i + 1;
    }
  }
  items.push(inner.slice(start).trim());
  if (items.some((item) => !item)) throw at('an empty item in a list or mapping');
  return items;
}

function parseScalar(text: string, at: (message: string) => YamlError): YamlScalar {
  if (text.startsWith('"')) {
    const match = /^"((?:[^"\\]|\\.)*)"$/.exec(text);
    if (!match) throw at(`unterminated or trailing text after a quoted string: ${text}`);
    return match[1]!.replace(/\\(.)/g, (_, c: string) => {
      const escape = ({ '"': '"', '\\': '\\', '/': '/', n: '\n', t: '\t' } as Record<string, string>)[c];
      if (escape === undefined) throw at(`unsupported escape \\${c}`);
      return escape;
    });
  }
  if (text.startsWith("'")) {
    const match = /^'((?:[^']|'')*)'$/.exec(text);
    if (!match) throw at(`unterminated or trailing text after a quoted string: ${text}`);
    return match[1]!.replace(/''/g, "'");
  }
  if (/^[&*!|>%@`[\]{}]/.test(text)) throw at(`unsupported YAML: ${text}`);
  if (text === '~' || text === 'null') return null;
  return text;
}

export interface RepoConfig {
  // Path globs whose changes get a deeper review (issue #42).
  sensitive: string[];
  // Path globs never reviewed, such as vendored code. They're listed in the check run.
  skip: string[];
  // Files every reviewer gets as conventions, by their path in the repository.
  policies: string[];
  // Each reviewer's model, over the engine's defaults.
  tiers: Record<string, ModelTier>;
}

export const defaultConfig = (): RepoConfig => ({ sensitive: [], skip: [], policies: [], tiers: {} });

const maxPathChars = 256;
const reviewerName = /^[A-Za-z0-9][A-Za-z0-9:_-]*$/;

// The schema: every key optional; the three path lists are lists of strings; tiers maps a reviewer to a model tier.
// Any error drops the whole file for the defaults. A security tier below minimumSecurityTier isn't an error, which would
// drop every other setting too: it is raised to the minimum, with a warning.
export function validateConfig(value: Record<string, YamlValue>): { config: RepoConfig; errors: string[]; warnings: string[] } {
  const config = defaultConfig();
  const errors: string[] = [];
  for (const [key, raw] of Object.entries(value)) {
    if (key === 'sensitive' || key === 'skip' || key === 'policies') {
      if (raw === null) continue;
      if (!Array.isArray(raw)) {
        errors.push(`"${key}" must be a list of paths`);
        continue;
      }
      for (const item of raw) {
        if (typeof item !== 'string' || !item.trim()) errors.push(`"${key}" has an empty item`);
        else if (item.length > maxPathChars || /[\u0000-\u001f]/.test(item)) errors.push(`"${key}" has an item that is too long or has control characters`);
        else config[key].push(item.trim());
      }
    } else if (key === 'tiers') {
      if (raw === null) continue;
      if (typeof raw !== 'object' || Array.isArray(raw)) {
        errors.push('"tiers" must map reviewer names to haiku, sonnet or opus');
        continue;
      }
      for (const [name, tier] of Object.entries(raw)) {
        if (!reviewerName.test(name)) errors.push(`"tiers" has an invalid reviewer name "${name}"`);
        else if (tier !== 'haiku' && tier !== 'sonnet' && tier !== 'opus') errors.push(`"tiers.${name}" must be haiku, sonnet or opus`);
        else config.tiers[name] = tier;
      }
    } else {
      errors.push(`unknown setting "${key}"`);
    }
  }
  if (errors.length) return { config: defaultConfig(), errors, warnings: [] };
  const warnings: string[] = [];
  const security = config.tiers['security'];
  if (security && tierRank[security] < tierRank[minimumSecurityTier]) {
    warnings.push(`"tiers.security" in ${configPath} is ${security}, below the security reviewer's minimum; it runs on ${minimumSecurityTier}.`);
    config.tiers['security'] = minimumSecurityTier;
  }
  return { config, errors, warnings };
}

// Why a path from the settings can't name a file in the repository, or undefined when it can. Absolute paths, ".."
// and backslashes are refused before anything touches the disk.
export function unsafePath(relative: string): string | undefined {
  if (relative.includes('\\')) return 'uses a backslash; write paths with forward slashes';
  if (relative.startsWith('/') || /^[A-Za-z]:/.test(relative)) return 'is absolute; write it relative to the repository root';
  if (relative.split('/').includes('..')) return 'leaves the repository';
  if (/[\u0000-\u001f]/.test(relative)) return 'has control characters';
  return undefined;
}

// Why a file system call failed, in a few words for a warning: the error code, without the runner's paths.
function failure(error: unknown): string {
  return (error as NodeJS.ErrnoException).code ?? 'an unknown error';
}

// The file's real path when it is inside the checkout with every symlink resolved: a symlink to /proc/self/environ
// or another checkout must not be read. missing is set when there is nothing at the path.
function resolveInside(root: string, relative: string): { real?: string; problem?: string; missing?: boolean } {
  let realRoot: string;
  let real: string;
  try {
    realRoot = realpathSync(root);
  } catch {
    return { problem: 'has no checkout to read from', missing: true };
  }
  try {
    real = realpathSync(path.resolve(realRoot, relative));
  } catch (error) {
    const code = failure(error);
    return code === 'ENOENT' || code === 'ENOTDIR' ? { problem: 'does not exist', missing: true } : { problem: `can't be read (${code})` };
  }
  const rel = path.relative(realRoot, real);
  if (rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) return { problem: 'resolves outside the repository' };
  return { real };
}

function readInside(root: string, relative: string, maxChars: number): { text?: string; problem?: string; truncated?: boolean; missing?: boolean } {
  const unsafe = unsafePath(relative);
  if (unsafe) return { problem: unsafe };
  const { real, problem, missing } = resolveInside(root, relative);
  if (!real) return { problem: problem!, ...(missing ? { missing } : {}) };
  // One open file for the checks and the read, so the file can't change between them; any error is a warning.
  let fd: number;
  try {
    fd = openSync(real, 'r');
  } catch (error) {
    return { problem: failure(error) === 'EISDIR' ? 'is not a file' : `can't be read (${failure(error)})` };
  }
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) return { problem: 'is not a file' };
    // Characters are at most four bytes, so a file this large can't fit the budget anyway.
    if (stat.size > maxChars * 4 + 1024) return { problem: `is larger than ${maxChars} characters` };
    const text = readFileSync(fd, 'utf8');
    return text.length > maxChars ? { text: text.slice(0, maxChars), truncated: true } : { text };
  } catch (error) {
    return { problem: `can't be read (${failure(error)})` };
  } finally {
    closeSync(fd);
  }
}

export interface ProjectCharter {
  // Without the "project:" prefix.
  name: string;
  text: string;
  // Globs from the charter's paths: frontmatter; a changed file matching one adds the reviewer to the floor.
  paths: string[];
  // shadow: true in its frontmatter, read as the engine's charters read it: its findings go only to the trace and the
  // check run's shadow section.
  shadow: boolean;
}

export interface ProjectSettings {
  config: RepoConfig;
  // The policies read, in order, within maxPolicyChars.
  policies: { path: string; text: string }[];
  guidance?: string;
  reviewers: ProjectCharter[];
  warnings: string[];
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function readConfig(basePath: string, warnings: string[]): RepoConfig {
  const file = readInside(basePath, configPath, maxSettingsFileChars);
  if (file.missing) return defaultConfig();
  if (file.text === undefined || file.truncated) {
    warnings.push(`${configPath} ${file.problem ?? `is larger than ${maxSettingsFileChars} characters`}; using the defaults.`);
    return defaultConfig();
  }
  let value: Record<string, YamlValue>;
  try {
    value = parseYaml(file.text);
  } catch (error) {
    warnings.push(`${configPath} is not valid: ${oneLine((error as Error).message)}; using the defaults.`);
    return defaultConfig();
  }
  const { config, errors, warnings: notes } = validateConfig(value);
  if (errors.length) warnings.push(`${configPath} is not valid: ${errors.slice(0, 5).map(oneLine).join('; ')}${errors.length > 5 ? `; and ${errors.length - 5} more` : ''}; using the defaults.`);
  else warnings.push(...notes);
  return config;
}

function readPolicies(basePath: string, policies: string[], warnings: string[]): { path: string; text: string }[] {
  const out: { path: string; text: string }[] = [];
  let used = 0;
  for (const policy of [...new Set(policies)]) {
    const left = maxPolicyChars - used;
    if (left <= 0) {
      warnings.push(`Policy ${policy} was left out: the policies are over their budget of ${maxPolicyChars} characters.`);
      continue;
    }
    const file = readInside(basePath, policy, maxSettingsFileChars);
    if (file.text === undefined) {
      warnings.push(`Policy ${policy} ${file.problem}; it was left out.`);
      continue;
    }
    let text = file.text.trim();
    if (file.truncated || text.length > left) {
      text = `${text.slice(0, left)}\n[policy truncated]`;
      warnings.push(`Policy ${policy} was truncated: the policies are over their budget of ${maxPolicyChars} characters.`);
    }
    used += text.length;
    out.push({ path: policy, text });
  }
  return out;
}

// The frontmatter between "---" lines at the top of a Markdown file, and the text after it. The instruction files,
// guidance.md and the project reviewers are all split here.
export function splitFrontmatter(text: string): { frontmatter?: string; body: string } {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
  return match ? { frontmatter: match[1]!, body: text.slice(match[0].length) } : { body: text };
}

// A comma-separated list of globs, as applyTo: and a one-line paths: write them.
export function globList(value: string): string[] {
  return value.split(',').map((g) => g.trim()).filter(Boolean);
}

// A project reviewer's frontmatter: paths:, a list of globs or one comma-separated string, and shadow:, true or false,
// which parseCharter reads as it does for the engine's charters. Anything else is a problem, and the reviewer then loads
// without paths.
export function charterPaths(frontmatter: string): { paths: string[]; problems: string[] } {
  let value: Record<string, YamlValue>;
  try {
    value = parseYaml(frontmatter);
  } catch (error) {
    return { paths: [], problems: [oneLine((error as Error).message)] };
  }
  const problems: string[] = [];
  const paths: string[] = [];
  for (const [key, raw] of Object.entries(value)) {
    if (key === 'shadow') {
      if (typeof raw !== 'string' || !/^(true|false)$/i.test(raw)) problems.push('"shadow" must be true or false');
    } else if (key !== 'paths') {
      problems.push(`unknown key "${key}"`);
    } else if (raw !== null && typeof raw === 'object' && !Array.isArray(raw)) {
      problems.push('"paths" must be a list of globs');
    } else {
      for (const item of typeof raw === 'string' ? globList(raw) : (raw ?? [])) {
        if (typeof item !== 'string' || !item.trim()) problems.push('"paths" has an empty item');
        else if (item.length > maxPathChars || /[\u0000-\u001f]/.test(item)) problems.push('"paths" has an item that is too long or has control characters');
        else paths.push(item.trim());
      }
    }
  }
  return problems.length ? { paths: [], problems } : { paths, problems };
}

const charterName = /^[a-z0-9][a-z0-9-]{0,39}$/;

function readReviewers(basePath: string, warnings: string[]): ProjectCharter[] {
  const folder = resolveInside(basePath, reviewersPath);
  if (folder.missing) return [];
  let names: string[] = [];
  let problem = folder.problem;
  if (folder.real) {
    try {
      names = readdirSync(folder.real);
    } catch (error) {
      problem = failure(error) === 'ENOTDIR' ? 'is not a folder' : `can't be read (${failure(error)})`;
    }
  }
  if (problem) {
    warnings.push(`${reviewersPath} ${problem}; no project reviewers were loaded.`);
    return [];
  }
  const charters: ProjectCharter[] = [];
  for (const file of names.filter((n) => n.endsWith('.md')).sort()) {
    const where = `${reviewersPath}/${file}`;
    const name = file.slice(0, -3);
    if (!charterName.test(name)) {
      warnings.push(`${where} was not loaded: a reviewer's name is lowercase letters, digits and hyphens, at most 40 characters.`);
      continue;
    }
    if (charters.length >= maxProjectReviewers) {
      warnings.push(`${where} was not loaded: at most ${maxProjectReviewers} project reviewers are loaded.`);
      continue;
    }
    const read = readInside(basePath, where, maxSettingsFileChars);
    if (read.text === undefined || read.truncated) {
      warnings.push(`${where} ${read.problem ?? `is larger than ${maxSettingsFileChars} characters`}; it was not loaded.`);
      continue;
    }
    const { frontmatter } = splitFrontmatter(read.text);
    const charter = parseCharter(read.text);
    let paths: string[] = [];
    if (frontmatter !== undefined) {
      const parsed = charterPaths(frontmatter);
      paths = parsed.paths;
      if (parsed.problems.length) warnings.push(`${where} has frontmatter that is not valid (${parsed.problems.slice(0, 5).map(oneLine).join('; ')}); its paths were ignored.`);
    }
    const text = charter.text.trim();
    if (!text) {
      warnings.push(`${where} is empty; it was not loaded.`);
      continue;
    }
    charters.push({ name, text, paths, shadow: charter.shadow });
  }
  return charters;
}

// Reads the settings from the default branch's checkout. Never pass the pull request's checkout: its copy is part of
// the change under review, not the rules it's reviewed by.
export function readProjectSettings(basePath: string): ProjectSettings {
  const warnings: string[] = [];
  const config = readConfig(basePath, warnings);
  const policies = readPolicies(basePath, config.policies, warnings);
  let guidance: string | undefined;
  const read = readInside(basePath, guidancePath, maxSettingsFileChars);
  if (read.text !== undefined) {
    if (read.truncated) warnings.push(`${guidancePath} was truncated to ${maxSettingsFileChars} characters.`);
    guidance = read.text;
  } else if (!read.missing) {
    warnings.push(`${guidancePath} ${read.problem}; it was not loaded.`);
  }
  const reviewers = readReviewers(basePath, warnings);
  return { config, policies, ...(guidance !== undefined ? { guidance } : {}), reviewers, warnings };
}

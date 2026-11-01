// The repository's own review settings, from .github/code-review/ on the default branch's checkout only, so a pull
// request can't soften its own review: config.yml, guidance.md and reviewers/*.md. Everything in them is data from the
// repository. A setting that can't be used is left out with a warning for the check run; it never fails the review.

import { closeSync, fstatSync, openSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { isAlias, isMap, isScalar, isSeq, LineCounter, parseDocument } from 'yaml';
import { parseCharter } from './charter.ts';
import { maxPolicyChars, maxProjectReviewers, maxSettingsFileChars, minimumSecurityTier, tierRank, type ModelTier } from './config.ts';

export const settingsFolder = '.github/code-review';
const configPath = `${settingsFolder}/config.yml`;
const guidancePath = `${settingsFolder}/guidance.md`;
const reviewersPath = `${settingsFolder}/reviewers`;

export type YamlScalar = string | null;
export type YamlValue = YamlScalar | YamlScalar[] | Record<string, YamlScalar>;

export class YamlError extends Error {}

// YAML read with the yaml library's failsafe schema, so every value is a string or null, and only the subset the
// settings use: top-level keys whose values are a single value, a list or a mapping of single values, as block or flow
// collections, with comments and quoted strings. Anchors, aliases, tags, multi-line values, more than one document and
// deeper nesting are refused, so a file never means something other than what it appears to. An error names its line.
export function parseYaml(text: string): Record<string, YamlValue> {
  const lines = new LineCounter();
  const doc = parseDocument(text, { schema: 'failsafe', lineCounter: lines, prettyErrors: false, uniqueKeys: true });
  const at = (offset: number | undefined, message: string) => new YamlError(`line ${lines.linePos(offset ?? 0).line}: ${message}`);
  const problem = doc.errors[0] ?? doc.warnings[0];
  if (problem) throw at(problem.pos[0], problem.message);
  const plain = (node: unknown): string => {
    const where = (node as { range?: [number, number, number] } | null)?.range;
    if (isAlias(node) || (node as { anchor?: string } | null)?.anchor || (node as { tag?: string } | null)?.tag) throw at(where?.[0], 'unsupported YAML: anchors, aliases and tags');
    if (!isScalar(node)) throw at(where?.[0], 'nested lists and mappings are not supported');
    const range = node.range!;
    if (node.type === 'BLOCK_LITERAL' || node.type === 'BLOCK_FOLDED' || text.slice(range[0], range[1]).includes('\n')) throw at(range[0], 'multi-line values are not supported');
    return String(node.value);
  };
  const scalar = (node: unknown): YamlScalar => {
    const value = plain(node);
    return isScalar(node) && node.type === 'PLAIN' && (value === '' || value === '~' || value === 'null') ? null : value;
  };
  // "__proto__" would set the parsed object's prototype instead of adding a key.
  const key = (node: unknown): string => {
    const name = plain(node);
    if (name === '__proto__') throw at((node as { range?: [number, number, number] }).range?.[0], `"${name}" is not allowed as a key`);
    return name;
  };
  const out: Record<string, YamlValue> = {};
  const root = doc.contents;
  if (root === null) return out;
  if (!isMap(root) || root.flow || root.anchor || root.tag) throw at(root.range?.[0], 'expected "key: value"');
  for (const pair of root.items) {
    const name = key(pair.key);
    const value = pair.value;
    if (isSeq(value) && !value.anchor && !value.tag) {
      out[name] = value.items.map(scalar);
    } else if (isMap(value) && !value.anchor && !value.tag) {
      const map: Record<string, YamlScalar> = {};
      for (const entry of value.items) map[key(entry.key)] = scalar(entry.value);
      out[name] = map;
    } else {
      out[name] = value === null ? null : scalar(value);
    }
  }
  return out;
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

// Why one item of a list of paths or globs can't be used, or undefined when it can.
function pathItemProblem(key: string, item: unknown): string | undefined {
  if (typeof item !== 'string' || !item.trim()) return `"${key}" has an empty item`;
  if (item.length > maxPathChars || /[\u0000-\u001f]/.test(item)) return `"${key}" has an item that is too long or has control characters`;
  return undefined;
}

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
        const problem = pathItemProblem(key, item);
        if (problem) errors.push(problem);
        else if (typeof item === 'string') config[key].push(item.trim());
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
        const problem = pathItemProblem('paths', item);
        if (problem) problems.push(problem);
        else if (typeof item === 'string') paths.push(item.trim());
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

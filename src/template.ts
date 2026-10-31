// Which files a repository's project template owns. A repository made from NCodeGroup/project-template records it in
// .copier-answers.yml. A template update replaces the template's files and discards any edit, so a defect in one can
// only be fixed in the template: findings on them belong upstream, not on the pull request.
//
// The engine can't render the template, so it applies a fixed rule instead: `.template/` and the files below, which the
// template renders and replaces on every update, are template-owned; everything else, including the files the template
// writes once (_skip_if_exists), the files it merges with the project's (_merged_files), the answers file, anything
// listed in project_owned_files, and a command, prompt, skill, agent or hook the project adds under a name the template
// doesn't use, is the project's. The rule applies only when _src_path names NCodeGroup/project-template. A name the
// template adds after this list was written counts as the project's, so its findings are posted rather than hidden.

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

export interface Template {
  // The template's repository: NCodeGroup/project-template.
  repository: string;
  // The template version the answers record, such as v0.41.1.
  commit: string;
  projectOwned: string[];
}

export const answersFile = '.copier-answers.yml';
// The files a template update changes that hold only the template's version and the answers it was made with.
export const templateVersionFiles: readonly string[] = [answersFile, '.template-version'];
const templateRepositoryName = 'NCodeGroup/project-template';

// The template's workflow commands, each generated as a Claude Code command, a Copilot prompt file and a skill.
const workflowCommands = [
  'address-feedback', 'analyze-architecture', 'analyze-decision', 'continue-plan', 'execute-step', 'finish-plan', 'handoff-plan',
  'orchestrate-plan', 'plan-bugfix', 'plan-docs', 'plan-feature', 'plan-issue', 'plan-migration', 'plan-performance', 'plan-refactor',
  'plan-security', 'plan-template-update', 'plan-tests', 'replan-step', 'review-code', 'review-plan-diff', 'run-issues', 'ship-plan',
  'triage-issues',
];
const copilotAgents = [
  'copilot-implementer', 'copilot-orchestrator', 'copilot-planner', 'copilot-reviewer', 'hybrid-orchestrator', 'hybrid-planner',
  'hybrid-reviewer', 'local-implementer', 'plan-executor',
];
const templateFolders = ['.template/'];
const templateFiles = new Set([
  'CLAUDE.md',
  '.template-version',
  '.githooks/commit-msg',
  '.githooks/pre-push',
  '.claude/agents/plan-executor.md',
  '.github/instructions/project-template.instructions.md',
  '.github/instructions/csharp.instructions.md',
  '.claude/rules/csharp.md',
  'build/ProjectTemplate.props',
  '.github/prompts/execute-step-local.prompt.md',
  ...workflowCommands.flatMap((name) => [`.claude/commands/${name}.md`, `.github/prompts/${name}.prompt.md`, `.github/skills/${name}/SKILL.md`]),
  ...copilotAgents.map((name) => `.github/agents/${name}.agent.md`),
]);

function unquote(value: string): string {
  const trimmed = value.trim();
  if (/^'.*'$/.test(trimmed)) return trimmed.slice(1, -1).replace(/''/g, "'");
  if (/^".*"$/.test(trimmed)) return trimmed.slice(1, -1);
  return trimmed;
}

// Reads the top-level answers the rule needs. Copier writes the file, so a plain scalar or a list in either YAML form
// is all it holds for these keys.
export function parseAnswers(text: string): { srcPath: string; commit: string; projectOwned: string[] } {
  const lines = text.split(/\r?\n/);
  const scalar = (key: string) => {
    const line = lines.find((l) => l.startsWith(`${key}:`));
    return line ? unquote(line.slice(key.length + 1).replace(/\s+#.*$/, '')) : '';
  };
  const projectOwned: string[] = [];
  const index = lines.findIndex((l) => l.startsWith('project_owned_files:'));
  if (index >= 0) {
    const inline = lines[index]!.slice('project_owned_files:'.length).replace(/\s+#.*$/, '').trim();
    if (inline.startsWith('[')) {
      projectOwned.push(...inline.replace(/^\[|\]$/g, '').split(',').map(unquote).filter(Boolean));
    } else {
      for (const line of lines.slice(index + 1)) {
        const item = /^\s*-\s+(.+)$/.exec(line);
        if (!item) break;
        projectOwned.push(unquote(item[1]!.replace(/\s+#.*$/, '')));
      }
    }
  }
  return { srcPath: scalar('_src_path'), commit: scalar('_commit'), projectOwned: projectOwned.map((p) => p.replace(/\\/g, '/').replace(/^\.\//, '')) };
}

// "https://github.com/NCodeGroup/project-template.git", "gh:NCodeGroup/project-template" and
// "git@github.com:NCodeGroup/project-template.git" all read as "NCodeGroup/project-template".
export function templateRepository(srcPath: string): string {
  const trimmed = srcPath.trim().replace(/[\\/]+$/, '').replace(/\.git$/, '');
  const github = /(?:github\.com[:/]|^gh:)([^/\s]+\/[^/\s]+)$/i.exec(trimmed);
  return github ? github[1]! : trimmed;
}

// Only NCodeGroup/project-template: the rule lists its files, not those of another template, a fork or a local copy.
export function templateFromAnswers(text: string): Template | undefined {
  const answers = parseAnswers(text);
  if (templateRepository(answers.srcPath).toLowerCase() !== templateRepositoryName.toLowerCase()) return undefined;
  return { repository: templateRepositoryName, commit: answers.commit, projectOwned: answers.projectOwned };
}

// The template a checkout's answers file names, or undefined when it has none or names another template.
export function readTemplate(checkout: string): Template | undefined {
  const file = path.join(checkout, answersFile);
  if (!existsSync(file)) return undefined;
  return templateFromAnswers(readFileSync(file, 'utf8'));
}

export function isTemplateOwned(file: string, template: Template | undefined): boolean {
  if (!template || template.projectOwned.includes(file)) return false;
  return templateFiles.has(file) || templateFolders.some((folder) => file.startsWith(folder));
}

// What a pull request that adopts or updates the template would leave to it: the template, the _commit its head's
// answers name, and the changed files the template would own, before they're compared with the template's own copies.
export interface TemplateCandidate {
  template: Template;
  commit: string;
  files: string[];
}

// The ref to read the template at for a _commit. Copier writes `git describe` output, such as v0.41.1-3-gabc1234, for a
// commit past a tag, so that one is read at its abbreviated SHA. Anything that isn't plainly a ref isn't read.
export function templateRef(commit: string): string | undefined {
  const described = /-g([0-9a-f]{7,40})$/i.exec(commit);
  if (described) return described[1]!;
  return /^[A-Za-z0-9._/-]+$/.test(commit) && !commit.includes('..') ? commit : undefined;
}

// The files the template renders, by the path they get in a project, from the template repository's file list. Copier
// renders from the template/ folder; a `{% if … %}name{% endif %}` path part renders as the name when the project has
// the file, and a .jinja source drops its suffix. A path still holding a Jinja expression, such as the answers file's,
// is left out.
export function renderedTemplatePaths(tree: { path?: string; type?: string; sha?: string }[]): Map<string, { sha: string; jinja: boolean }> {
  const rendered = new Map<string, { sha: string; jinja: boolean }>();
  for (const entry of tree) {
    if (entry.type !== 'blob' || !entry.sha || !entry.path?.startsWith('template/')) continue;
    let file = entry.path.slice('template/'.length).replace(/\{%-?\s*if\b[^%]*-?%\}([^{}]*?)\{%-?\s*endif\s*-?%\}/g, '$1');
    if (/\{\{|\{%/.test(file)) continue;
    const jinja = file.endsWith('.jinja');
    if (jinja) file = file.slice(0, -'.jinja'.length);
    if (!rendered.has(file)) rendered.set(file, { sha: entry.sha, jinja });
  }
  return rendered;
}

const jinjaTag = /\{\{[\s\S]*?\}\}|\{%[\s\S]*?%\}|\{#[\s\S]*?#\}/g;
const blockTags = new Set(['if', 'for', 'macro', 'call', 'filter', 'block', 'raw', 'with', 'autoescape']);

// Whether a file could be a rendering of a Jinja source, without rendering it: the source's text outside every tag and
// block appears in the file in order, with each expression and block standing for any text. Whitespace next to a tag
// is left out, since Jinja's whitespace control can remove it. A source whose blocks don't balance matches nothing.
export function matchesTemplateSource(source: string, text: string): boolean {
  const normalized = text.replace(/\r\n/g, '\n');
  const pieces: string[] = [''];
  let depth = 0;
  let at = 0;
  const literal = (piece: string) => {
    if (depth === 0) pieces[pieces.length - 1] += piece;
  };
  const template = source.replace(/\r\n/g, '\n');
  for (const tag of template.matchAll(jinjaTag)) {
    literal(template.slice(at, tag.index));
    at = tag.index + tag[0].length;
    if (depth === 0) pieces.push('');
    const name = /^\{%-?\s*(\w+)/.exec(tag[0])?.[1];
    if (name && (blockTags.has(name) || (name === 'set' && !tag[0].includes('=')))) depth++;
    else if (name?.startsWith('end') && --depth < 0) return false;
  }
  literal(template.slice(at));
  if (depth !== 0) return false;
  if (pieces.length === 1) return normalized === pieces[0];
  const last = pieces.length - 1;
  const trimmed = pieces.map((piece, i) => (i === 0 ? piece.trimEnd() : i === last ? piece.trimStart() : piece.trim()));
  const first = trimmed[0]!;
  const end = trimmed[last]!;
  if (!normalized.startsWith(first) || !normalized.endsWith(end) || first.length + end.length > normalized.length) return false;
  let cursor = first.length;
  const limit = normalized.length - end.length;
  for (const piece of trimmed.slice(1, last)) {
    if (!piece) continue;
    const found = normalized.indexOf(piece, cursor);
    if (found < 0 || found + piece.length > limit) return false;
    cursor = found + piece.length;
  }
  return true;
}
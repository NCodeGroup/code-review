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
  'address-feedback', 'analyze-architecture', 'analyze-decision', 'audit-conventions', 'continue-plan', 'execute-step',
  'finish-plan', 'handoff-plan', 'orchestrate-plan', 'plan-bugfix', 'plan-docs', 'plan-feature', 'plan-issue', 'plan-migration',
  'plan-performance', 'plan-refactor', 'plan-security', 'plan-template-update', 'plan-tests', 'replan-step', 'review-code',
  'review-plan-diff', 'run-issues', 'ship-plan', 'triage-issues',
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

const plainAnswer = /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,79}$/;

// The answers file's top-level keys whose values are plain scalars, as a Jinja expression naming them renders them. A
// list, a mapping, a multi-line string, an alias, a tagged value or an empty one is left out, so an expression naming
// it can't be rendered and its file isn't confirmed.
export function answerValues(text: string): Map<string, string> {
  const values = new Map<string, string>();
  for (const line of text.split(/\r?\n/)) {
    const entry = /^([A-Za-z_]\w*):[ \t]+(.+)$/.exec(line);
    if (!entry) continue;
    const raw = entry[2]!.replace(/\s+#.*$/, '').trim();
    if (!raw || /^[[{|>&*!]/.test(raw)) continue;
    const value = unquote(raw);
    // The pull request writes the answers file, so a value is its author's to choose: only a plain one can't carry code
    // or instructions into a file left to the template.
    if (!plainAnswer.test(value)) continue;
    values.set(entry[1]!, value);
  }
  return values;
}

// Whether a file is the exact rendering of a Jinja source with the head's answers. Rendering Jinja in full would need
// Jinja, and treating a tag as a stand-in for any text would confirm a file edited where the tag was, so only the plain
// case is rendered: no blocks or comments, and every expression a bare answer name. Any other source matches nothing,
// and its file is reviewed as the project's.
export function matchesTemplateSource(source: string, text: string, answers: ReadonlyMap<string, string>): boolean {
  if (source.includes('{%') || source.includes('{#')) return false;
  let rendered = '';
  let at = 0;
  for (const tag of source.matchAll(/\{\{[\s\S]*?\}\}/g)) {
    const name = /^\{\{[ \t]*([A-Za-z_]\w*)[ \t]*\}\}$/.exec(tag[0])?.[1];
    const value = name === undefined ? undefined : answers.get(name);
    if (value === undefined) return false;
    rendered += source.slice(at, tag.index) + value;
    at = tag.index + tag[0].length;
  }
  const rest = source.slice(at);
  // An expression left open is an error in Jinja, so no file renders from it.
  if (rest.includes('{{')) return false;
  return rendered + rest === text;
}

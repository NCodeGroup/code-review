import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { gather, templateOf, type ChangedFile, type Gathered, type PullRequest } from '../src/gather.ts';
import { checkSummary, checkText, summaryComment, type Results } from '../src/results.ts';
import { byOwner, selectionFloor, templateBlock, upstreamFindings, type Finding, type ReviewedFinding } from '../src/review.ts';
import { isTemplateOwned, parseAnswers, readTemplate, templateFromAnswers, templateRepository, type Template } from '../src/template.ts';
import { placeFindings } from '../src/threads.ts';

const made: string[] = [];
after(() => {
  for (const dir of made) rmSync(dir, { recursive: true, force: true });
});

function temp(prefix: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  made.push(dir);
  return dir;
}

function write(root: string, file: string, text: string): void {
  mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
  writeFileSync(path.join(root, file), text);
}

const answers = `# Written by Copier; never edit by hand.
_commit: v0.41.1
_src_path: https://github.com/NCodeGroup/project-template.git
project_description: 'A project: with a colon'
project_name: code-review
workflow_tools:
- claude
- copilot
`;

const template: Template = { repository: 'NCodeGroup/project-template', commit: 'v0.41.1', projectOwned: [] };

test('parseAnswers reads the source, the version and project_owned_files in either list form', () => {
  assert.deepEqual(parseAnswers(answers), { srcPath: 'https://github.com/NCodeGroup/project-template.git', commit: 'v0.41.1', projectOwned: [] });
  const block = parseAnswers(`${answers}project_owned_files:\n- .github/workflows/ci.yml\n- '.github/dependabot.yml'\nstack: node\n`);
  assert.deepEqual(block.projectOwned, ['.github/workflows/ci.yml', '.github/dependabot.yml']);
  const inline = parseAnswers(`project_owned_files: [.github/workflows/ci.yml, ".githooks/pre-push"]\n_src_path: gh:NCodeGroup/project-template\n`);
  assert.deepEqual(inline.projectOwned, ['.github/workflows/ci.yml', '.githooks/pre-push']);
  assert.equal(inline.commit, '');
});

test('templateRepository names a GitHub template by owner and name, in each form Copier accepts', () => {
  assert.equal(templateRepository('https://github.com/NCodeGroup/project-template.git'), 'NCodeGroup/project-template');
  assert.equal(templateRepository('gh:NCodeGroup/project-template'), 'NCodeGroup/project-template');
  assert.equal(templateRepository('git@github.com:NCodeGroup/project-template.git'), 'NCodeGroup/project-template');
  assert.equal(templateRepository('C:\\src\\project-template\\'), 'C:\\src\\project-template');
});

test('templateFromAnswers knows only project-template, whose files the rule lists', () => {
  assert.deepEqual(templateFromAnswers(answers), template);
  assert.equal(templateFromAnswers('_src_path: https://github.com/someone/other-template.git\n'), undefined);
  assert.equal(templateFromAnswers('project_name: x\n'), undefined);
});

test('isTemplateOwned covers the files the template replaces, and none the project owns or merges', () => {
  for (const file of ['.template/Get-PlanState.ps1', '.githooks/pre-push', '.claude/commands/ship-plan.md', '.claude/agents/plan-executor.md', '.github/prompts/ship-plan.prompt.md', '.github/skills/ship-plan/SKILL.md', '.github/agents/copilot-planner.agent.md', '.github/instructions/project-template.instructions.md', 'CLAUDE.md', '.template-version']) {
    assert.ok(isTemplateOwned(file, template), file);
  }
  // Written once (_skip_if_exists), merged (_merged_files), the answers, and the project's own files.
  for (const file of ['AGENTS.md', 'README.md', '.github/workflows/code-review.yml', '.gitignore', '.gitattributes', '.editorconfig', '.vscode/settings.json', '.claude/settings.json', '.github/workflows/ci.yml', '.github/dependabot.yml', '.copier-answers.yml', 'CHANGELOG.md', 'src/main.ts', '.github/instructions/typescript.instructions.md', 'tools/.template/x.ps1']) {
    assert.ok(!isTemplateOwned(file, template), file);
  }
  assert.ok(!isTemplateOwned('.githooks/pre-push', { ...template, projectOwned: ['.githooks/pre-push'] }));
  assert.ok(!isTemplateOwned('.template/Get-PlanState.ps1', undefined));
});

test('readTemplate reads a checkout\'s answers file, and nothing when there is none', () => {
  const dir = temp('template-answers-');
  assert.equal(readTemplate(dir), undefined);
  write(dir, '.copier-answers.yml', answers);
  assert.deepEqual(readTemplate(dir), template);
});

const pullRequest = (association = 'MEMBER'): PullRequest => ({
  repository: 'o/r', number: 23, title: 'Adopt project-template', author: 'a', authorAssociation: association, draft: false,
  baseRef: 'main', baseSha: '', headSha: '',
});
const changed = (p: string): ChangedFile => ({ path: p, additions: 1, deletions: 0, generated: false, shown: true });

test('templateOf prefers the default branch\'s answers, and reads the head\'s only for an adoption by a writer', () => {
  const base = temp('template-base-');
  const head = temp('template-head-');
  write(head, '.copier-answers.yml', answers);
  const adoption = [changed('.copier-answers.yml'), changed('.template/Get-PlanState.ps1')];
  assert.deepEqual(templateOf(pullRequest(), adoption, head, base), template);
  assert.equal(templateOf(pullRequest('CONTRIBUTOR'), adoption, head, base), undefined);
  assert.equal(templateOf(pullRequest(), [changed('.template/Get-PlanState.ps1')], head, base), undefined);
  write(base, '.copier-answers.yml', `${answers}project_owned_files: [.githooks/pre-push]\n`);
  assert.deepEqual(templateOf(pullRequest('CONTRIBUTOR'), adoption, head, base)?.projectOwned, ['.githooks/pre-push']);
  // A default branch that names another template keeps the head's answers from counting.
  write(base, '.copier-answers.yml', '_src_path: https://github.com/someone/other.git\n');
  assert.equal(templateOf(pullRequest(), adoption, head, base), undefined);
});

// Without the machine's own git configuration, so a default branch name, hooks or signing can't change the result.
const home = temp('template-home-');
function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-C', cwd, '-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', ...args], {
    encoding: 'utf8',
    env: { PATH: process.env['PATH'] ?? '', ...(process.env['SystemRoot'] ? { SystemRoot: process.env['SystemRoot'] } : {}), HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: home, GIT_CONFIG_NOSYSTEM: '1' },
  }).trim();
}

test('gather marks the template\'s files in an adoption, orders them last and keeps them from rule matching', () => {
  const repo = temp('template-repo-');
  git(repo, 'init', '-q', '-b', 'main');
  write(repo, 'src/a.ps1', 'Write-Output 1\n');
  write(repo, '.github/instructions/powershell.instructions.md', '---\napplyTo: ".template/**"\n---\n- 👁 A rule for scripts.\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-q', '-m', 'base');
  const baseSha = git(repo, 'rev-parse', 'HEAD');
  write(repo, '.copier-answers.yml', answers);
  write(repo, '.template/Get-PlanState.ps1', 'try { } catch { }\n');
  write(repo, 'AGENTS.md', '## Landing\n\n- draft: no\n');
  write(repo, 'src/a.ps1', 'Write-Output 2\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-q', '-m', 'adopt');
  const base = temp('template-basetree-');
  rmSync(base, { recursive: true });
  git(repo, 'worktree', 'add', '-q', '--detach', base, baseSha);

  const gathered = gather({ ...pullRequest(), baseSha }, repo, base);
  assert.deepEqual(gathered.template, template);
  const owned = gathered.files.filter((f) => f.templateOwned).map((f) => f.path);
  assert.deepEqual(owned, ['.template/Get-PlanState.ps1']);
  assert.ok(gathered.diff.lastIndexOf('diff --git a/.template/Get-PlanState.ps1') > gathered.diff.lastIndexOf('diff --git a/src/a.ps1'));
  assert.deepEqual(gathered.reviewRules, []);
});

test('selectionFloor leaves the template\'s scripts out of the reviewers they would call', () => {
  const script = { ...changed('.template/Get-PlanState.ps1'), additions: 400, templateOwned: true };
  assert.deepEqual(selectionFloor([script, changed('AGENTS.md')], true), ['hygiene']);
  assert.ok(selectionFloor([{ ...script, templateOwned: false }], true).includes('tests'));
});

test('templateBlock tells the reviewers which files are the template\'s, only when the change has some', () => {
  const gathered = { template, files: [{ ...changed('.template/Get-PlanState.ps1'), templateOwned: true }, changed('AGENTS.md')] } as unknown as Gathered;
  const block = templateBlock(gathered);
  assert.match(block, /project template NCodeGroup\/project-template \(v0\.41\.1\)/);
  assert.match(block, /\[template-owned\]/);
  assert.match(block, /AGENTS\.md/);
  assert.equal(templateBlock({ ...gathered, files: [changed('AGENTS.md')] } as unknown as Gathered), '');
  assert.equal(templateBlock({ files: gathered.files } as unknown as Gathered), '');
});

const finding = (file: string, line: number, severity: Finding['severity'] = 'nit', title = 'A problem'): Finding => ({
  severity, file, line, title, problem: 'p', consequence: 'c', fix: 'f', evidence: 'e', confidence: 0.6,
});

test('a finding on the template\'s script belongs upstream, and one on AGENTS.md\'s Landing section stays a thread', () => {
  const split = byOwner([finding('.template/Get-PlanState.ps1', 155, 'should-fix', 'Empty catch'), finding('AGENTS.md', 28, 'should-fix', 'draft: no')], template);
  assert.deepEqual(split.own.map((f) => f.file), ['AGENTS.md']);
  assert.deepEqual(split.upstream.map((f) => f.file), ['.template/Get-PlanState.ps1']);
  const own = split.own.map((f, i) => ({ ...f, id: `F${i + 1}`, reviewers: ['conventions'] }));
  const placement = placeFindings(own, { 'AGENTS.md': [28] }, []);
  assert.deepEqual(placement.inline.map((p) => p.finding.file), ['AGENTS.md']);
  assert.deepEqual(byOwner([finding('.template/Get-PlanState.ps1', 1)], undefined).upstream, []);
});

test('upstreamFindings lists each place once, most severe first, naming every reviewer', () => {
  const upstream = upstreamFindings([
    { ...finding('.githooks/pre-push', 25), reviewers: ['tests'] },
    { ...finding('.template/Get-PlanState.ps1', 155, 'nit', 'Empty catch'), reviewers: ['rule-check'] },
    { ...finding('.template/Get-PlanState.ps1', 155, 'should-fix', 'Empty catch hides failures'), reviewers: ['hygiene'] },
  ]);
  assert.deepEqual(upstream.map((f) => [f.id, f.file, f.line, f.severity, f.reviewers]), [
    ['U1', '.template/Get-PlanState.ps1', 155, 'should-fix', ['hygiene', 'rule-check']],
    ['U2', '.githooks/pre-push', 25, 'nit', ['tests']],
  ]);
});

test('the summary lists the template\'s findings once, under the template\'s repository, with file and line', () => {
  const upstream: ReviewedFinding[] = [{ ...finding('.template/Get-PlanState.ps1', 155, 'should-fix', 'Empty catch'), id: 'U1', reviewers: ['hygiene'] }];
  const results = {
    repository: 'o/r', pullRequest: 23, headSha: 'a'.repeat(40), provider: 'bedrock', providerReason: '', summary: 'Adopts the template.',
    verdict: 'comment', findings: [], upstream, template: 'NCodeGroup/project-template', reviewers: [], skipped: [], synthesisModel: '',
    calls: [], costUsd: 0, durationMs: 0, notShown: [], changedLines: {},
  } as Results;
  const body = summaryComment(results, 'https://check', 'https://help');
  assert.match(body, /<summary>Belongs upstream, in NCodeGroup\/project-template \(1\)<\/summary>/);
  assert.match(body, /- 🟠 `\.template\/Get-PlanState\.ps1:155`: Empty catch/);
  assert.match(checkText(results), /### Belongs upstream, in NCodeGroup\/project-template\n\n- \*\*U1 Should fix\*\* `\.template\/Get-PlanState\.ps1:155`/);
  assert.match(checkSummary(results), /1 finding in the template's files belongs upstream, in NCodeGroup\/project-template/);
  assert.doesNotMatch(summaryComment({ ...results, upstream: [] }, 'https://check', 'https://help'), /Belongs upstream/);
});

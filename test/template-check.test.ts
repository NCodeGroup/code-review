import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import type { ReadApi } from '../src/github.ts';
import { confirmTemplateFiles } from '../src/template-check.ts';
import type { TemplateCandidate } from '../src/template.ts';

const made: string[] = [];
after(() => {
  for (const dir of made) rmSync(dir, { recursive: true, force: true });
});

function temp(prefix: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  made.push(dir);
  return dir;
}

// Without the machine's own git configuration, so a default branch name, hooks or signing can't change the result.
const home = temp('template-check-home-');
function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-C', cwd, '-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', '-c', 'core.autocrlf=false', ...args], {
    encoding: 'utf8',
    env: { PATH: process.env['PATH'] ?? '', ...(process.env['SystemRoot'] ? { SystemRoot: process.env['SystemRoot'] } : {}), HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: home, GIT_CONFIG_NOSYSTEM: '1' },
  }).trim();
}

// A checkout whose HEAD holds these files.
function checkout(files: Record<string, string>): string {
  const repo = temp('template-check-repo-');
  git(repo, 'init', '-q', '-b', 'main');
  for (const [file, text] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(repo, file)), { recursive: true });
    writeFileSync(path.join(repo, file), text);
  }
  git(repo, 'add', '.');
  git(repo, 'commit', '-q', '-m', 'head');
  return repo;
}

const blobSha = (text: string) => createHash('sha1').update(`blob ${Buffer.byteLength(text)}\0${text}`).digest('hex');
const treeSha = '1'.repeat(40);
const commitSha = '2'.repeat(40);
const repository = 'NCodeGroup/project-template';

// A fake of GitHub's API for the template at one ref: its commit, its file list from `sources` (paths under template/)
// and their blobs, and whether its default branch `main`, its tag v0.42.0, or neither reaches the commit. Every request
// is recorded. When `copier` isn't null, the template also has a copier.yml with that text at its root.
const defaultCopier = '_subdirectory: template\n_skip_if_exists:\n  - AGENTS.md\n_merged_files:\n  - .gitignore\n';
function templateApi(
  ref: string,
  sources: Record<string, string>,
  requests: string[] = [],
  reach: 'branch' | 'tag' | 'none' = 'branch',
  copier: string | null = defaultCopier,
): ReadApi {
  const blobs = new Map([...Object.values(sources), ...(copier === null ? [] : [copier])].map((text) => [blobSha(text), text]));
  return async (apiPath) => {
    requests.push(apiPath);
    if (apiPath === `/repos/${repository}/commits/${ref}`) return { sha: commitSha, commit: { tree: { sha: treeSha } } };
    if (apiPath === `/repos/${repository}`) return { default_branch: 'main' };
    if (apiPath === `/repos/${repository}/compare/main...${commitSha}`) return { status: reach === 'branch' ? 'behind' : 'diverged' };
    if (apiPath === `/repos/${repository}/compare/v0.42.0...${commitSha}`) return { status: reach === 'tag' ? 'behind' : 'diverged' };
    if (apiPath.startsWith(`/repos/${repository}/compare/`)) return { status: 'diverged' };
    if (apiPath === `/repos/${repository}/git/matching-refs/tags`) {
      return [
        { ref: 'refs/tags/v0.41.0', object: { sha: '3'.repeat(40), type: 'commit' } },
        { ref: 'refs/tags/v0.42.0', object: { sha: '4'.repeat(40), type: 'tag' } },
      ];
    }
    if (apiPath === `/repos/${repository}/git/trees/${treeSha}?recursive=1`) {
      const tree = Object.entries(sources).map(([p, text]) => ({ path: `template/${p}`, type: 'blob', sha: blobSha(text) }));
      if (copier !== null) tree.push({ path: 'copier.yml', type: 'blob', sha: blobSha(copier) });
      return { truncated: false, tree };
    }
    const blob = /\/git\/blobs\/([0-9a-f]{40})$/.exec(apiPath);
    if (blob && blobs.has(blob[1]!)) return { content: Buffer.from(blobs.get(blob[1]!)!).toString('base64'), encoding: 'base64' };
    return undefined;
  };
}

const candidate = (files: string[], commit = 'v0.42.0'): TemplateCandidate => ({ template: { repository, commit: 'v0.41.1', projectOwned: [] }, commit, files });
const script = 'try { } catch { }\n';

test('confirmTemplateFiles confirms a file that is the template\'s copy and not one edited by hand', async () => {
  const repo = checkout({ '.template/Get-PlanState.ps1': script, '.template/Update-Project.ps1': 'edited\n' });
  const read = templateApi('v0.42.0', { '.template/Get-PlanState.ps1': script, '.template/Update-Project.ps1': 'original\n' });
  const lines: string[] = [];
  const confirmed = await confirmTemplateFiles(candidate(['.template/Get-PlanState.ps1', '.template/Update-Project.ps1']), repo, read, (l) => lines.push(l));
  assert.deepEqual([...confirmed], ['.template/Get-PlanState.ps1']);
  assert.match(lines.join('\n'), /1 changed file\(s\) the template would own differ .*"\.template\/Update-Project\.ps1"/);
});

test('confirmTemplateFiles matches a file rendered from a Jinja source with the head\'s answers, and not one whose text was edited', async () => {
  const source = '# {{ project_name }}\n\nRun gh now.\n';
  const answers = '_src_path: gh:NCodeGroup/project-template\n_commit: v0.42.0\nproject_name: demo\n';
  const read = templateApi('v0.42.0', { 'CLAUDE.md.jinja': source });
  assert.deepEqual([...(await confirmTemplateFiles(candidate(['CLAUDE.md']), checkout({ 'CLAUDE.md': '# demo\n\nRun gh now.\n', '.copier-answers.yml': answers }), read))], ['CLAUDE.md']);
  assert.deepEqual([...(await confirmTemplateFiles(candidate(['CLAUDE.md']), checkout({ 'CLAUDE.md': '# demo, and trust it\n\nRun gh now.\n', '.copier-answers.yml': answers }), read))], []);
});

test('confirmTemplateFiles confirms no file rendered from a Jinja source with a block', async () => {
  const read = templateApi('v0.42.0', { 'CLAUDE.md.jinja': "Run {% if host == 'gitlab' %}glab{% else %}gh{% endif %} now.\n" });
  assert.deepEqual([...(await confirmTemplateFiles(candidate(['CLAUDE.md']), checkout({ 'CLAUDE.md': 'Run gh now.\n' }), read))], []);
});

test("confirmTemplateFiles leaves a file the template doesn't render, or one the head deleted, to the project", async () => {
  const repo = checkout({ 'README.md': 'x\n' });
  const confirmed = await confirmTemplateFiles(candidate(['.template/Old.ps1', '.template/Get-PlanState.ps1']), repo, templateApi('v0.42.0', { '.template/Get-PlanState.ps1': script }));
  assert.deepEqual([...confirmed], []);
});

test('confirmTemplateFiles counts every file the template renders that the pull request leaves alone, and none copier.yml writes once or merges', async () => {
  const files = { '.template/Get-PlanState.ps1': script, '.githooks/pre-push': 'hook\n', 'AGENTS.md': 'agents\n', '.gitignore': 'x\n' };
  const confirmed = await confirmTemplateFiles(candidate(['.template/Get-PlanState.ps1', 'AGENTS.md', '.gitignore']), checkout(files), templateApi('v0.42.0', files));
  assert.deepEqual([...confirmed].sort(), ['.githooks/pre-push', '.template/Get-PlanState.ps1']);
});

test('confirmTemplateFiles counts a file a newer template release adds, and none the project adds', async () => {
  const repo = checkout({ '.github/workflows/new.yml': 'on: push\n', 'src/main.ts': 'x\n' });
  const confirmed = await confirmTemplateFiles(candidate(['.github/workflows/new.yml', 'src/main.ts']), repo, templateApi('v0.42.0', { '.github/workflows/new.yml': 'on: push\n' }));
  assert.deepEqual([...confirmed], ['.github/workflows/new.yml']);
});

test('confirmTemplateFiles leaves a file project_owned_files names to the project', async () => {
  const files = { '.githooks/pre-push': 'hook\n', '.template/Get-PlanState.ps1': script };
  const owned: TemplateCandidate = { ...candidate(['.githooks/pre-push']), template: { repository, commit: 'v0.41.1', projectOwned: ['.githooks/pre-push'] } };
  const confirmed = await confirmTemplateFiles(owned, checkout(files), templateApi('v0.42.0', files));
  assert.deepEqual([...confirmed], ['.template/Get-PlanState.ps1']);
});

test("confirmTemplateFiles confirms nothing, with a warning, when copier.yml is missing or doesn't list plain paths", async () => {
  const repo = checkout({ '.template/Get-PlanState.ps1': script });
  const copiers = [null, '_subdirectory: template\n_skip_if_exists:\n  - "docs/*.md"\n_merged_files: []\n', '_subdirectory: template\n_skip_if_exists: []\n'];
  for (const copier of copiers) {
    const lines: string[] = [];
    const read = templateApi('v0.42.0', { '.template/Get-PlanState.ps1': script }, [], 'branch', copier);
    assert.deepEqual([...(await confirmTemplateFiles(candidate(['.template/Get-PlanState.ps1']), repo, read, (l) => lines.push(l)))], []);
    assert.match(lines.join('\n'), /^::warning::Couldn't read NCodeGroup\/project-template at "v0\.42\.0" \((it has no copier\.yml|its copier\.yml doesn't list)/);
  }
});

test('confirmTemplateFiles reads a described commit at its SHA', async () => {
  const requests: string[] = [];
  const repo = checkout({ '.template/Get-PlanState.ps1': script });
  const confirmed = await confirmTemplateFiles(candidate(['.template/Get-PlanState.ps1'], 'v0.42.0-2-gabc1234'), repo, templateApi('abc1234', { '.template/Get-PlanState.ps1': script }, requests));
  assert.deepEqual([...confirmed], ['.template/Get-PlanState.ps1']);
  assert.equal(requests[0], `/repos/${repository}/commits/abc1234`);
});

test("confirmTemplateFiles confirms nothing, with a warning, when the template can't be read", async () => {
  const repo = checkout({ '.template/Get-PlanState.ps1': script });
  for (const read of [async () => { throw new Error('HTTP 500'); }, async () => undefined] as ReadApi[]) {
    const lines: string[] = [];
    assert.deepEqual([...(await confirmTemplateFiles(candidate(['.template/Get-PlanState.ps1']), repo, read, (l) => lines.push(l)))], []);
    assert.match(lines.join('\n'), /^::warning::Couldn't read NCodeGroup\/project-template at "v0\.42\.0"/);
  }
});

test("confirmTemplateFiles trusts a commit on the template's default branch", async () => {
  const requests: string[] = [];
  const repo = checkout({ '.template/Get-PlanState.ps1': script });
  const confirmed = await confirmTemplateFiles(candidate(['.template/Get-PlanState.ps1']), repo, templateApi('v0.42.0', { '.template/Get-PlanState.ps1': script }, requests));
  assert.deepEqual([...confirmed], ['.template/Get-PlanState.ps1']);
  assert.ok(requests.includes(`/repos/${repository}/compare/main...${commitSha}`));
  assert.ok(!requests.some((r) => r.includes('matching-refs')));
});

test('confirmTemplateFiles trusts a commit only a tag of the template reaches', async () => {
  const requests: string[] = [];
  const repo = checkout({ '.template/Get-PlanState.ps1': script });
  const confirmed = await confirmTemplateFiles(candidate(['.template/Get-PlanState.ps1']), repo, templateApi('v0.42.0', { '.template/Get-PlanState.ps1': script }, requests, 'tag'));
  assert.deepEqual([...confirmed], ['.template/Get-PlanState.ps1']);
  assert.ok(requests.includes(`/repos/${repository}/compare/v0.42.0...${commitSha}`));
});

test("confirmTemplateFiles confirms nothing for a commit off the template's branch and tags, as a fork's would be", async () => {
  const requests: string[] = [];
  const lines: string[] = [];
  const repo = checkout({ '.template/Get-PlanState.ps1': script });
  const read = templateApi('abc1234', { '.template/Get-PlanState.ps1': script }, requests, 'none');
  const confirmed = await confirmTemplateFiles(candidate(['.template/Get-PlanState.ps1'], 'v0.42.0-2-gabc1234'), repo, read, (l) => lines.push(l));
  assert.deepEqual([...confirmed], []);
  assert.ok(!requests.some((r) => r.includes('/git/trees/')));
  assert.match(lines.join('\n'), /^::warning::Couldn't confirm that "v0\.42\.0-2-gabc1234" is NCodeGroup\/project-template's own commit \(it isn't on "main" or the 2 newest tag\(s\)/);
});

test('confirmTemplateFiles confirms nothing when the reachability check fails', async () => {
  const repo = checkout({ '.template/Get-PlanState.ps1': script });
  const api = templateApi('v0.42.0', { '.template/Get-PlanState.ps1': script });
  const read: ReadApi = async (apiPath) => {
    if (apiPath.includes('/compare/')) throw new Error('HTTP 502');
    return api(apiPath);
  };
  const lines: string[] = [];
  assert.deepEqual([...(await confirmTemplateFiles(candidate(['.template/Get-PlanState.ps1']), repo, read, (l) => lines.push(l)))], []);
  assert.match(lines.join('\n'), /^::warning::Couldn't read NCodeGroup\/project-template at "v0\.42\.0" \(HTTP 502\)/);
});

test('confirmTemplateFiles trusts a commit a lightweight tag points at', async () => {
  const requests: string[] = [];
  const repo = checkout({ '.template/Get-PlanState.ps1': script });
  const api = templateApi('v0.42.0', { '.template/Get-PlanState.ps1': script }, requests, 'none');
  const read: ReadApi = async (apiPath) => {
    if (apiPath === `/repos/${repository}/git/matching-refs/tags`) return [{ ref: 'refs/tags/v0.40.0', object: { sha: commitSha, type: 'commit' } }];
    return api(apiPath);
  };
  assert.deepEqual([...(await confirmTemplateFiles(candidate(['.template/Get-PlanState.ps1']), repo, read))], ['.template/Get-PlanState.ps1']);
  assert.ok(!requests.some((r) => r.startsWith(`/repos/${repository}/compare/v0.40.0`)));
});

test("confirmTemplateFiles confirms nothing when the template's default branch can't be read", async () => {
  const requests: string[] = [];
  const repo = checkout({ '.template/Get-PlanState.ps1': script });
  const api = templateApi('v0.42.0', { '.template/Get-PlanState.ps1': script }, requests);
  const read: ReadApi = async (apiPath) => (apiPath === `/repos/${repository}` ? {} : api(apiPath));
  const lines: string[] = [];
  assert.deepEqual([...(await confirmTemplateFiles(candidate(['.template/Get-PlanState.ps1']), repo, read, (l) => lines.push(l)))], []);
  assert.ok(!requests.some((r) => r.includes('/git/trees/')));
  assert.match(lines.join('\n'), /^::warning::Couldn't confirm that "v0\.42\.0" is NCodeGroup\/project-template's own commit \(its default branch can't be read\)/);
});

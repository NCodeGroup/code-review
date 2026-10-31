import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

// tools/Enable-CodeReview.ps1 is PowerShell, and how `pwsh -File` binds its arguments is part of what's under test, so
// these tests run it in a real pwsh process. The only gh on its PATH is a stand-in that records each call and answers
// from a scenario, so nothing reaches GitHub.

const script = path.resolve(import.meta.dirname, '..', 'tools', 'Enable-CodeReview.ps1');

function findPwsh(): string | undefined {
  try {
    return execFileSync('pwsh', ['-NoProfile', '-NonInteractive', '-Command', '(Get-Process -Id $PID).Path'], { encoding: 'utf8' }).trim();
  } catch {
    return undefined;
  }
}
const pwsh = findPwsh();
const skip = pwsh ? false : 'pwsh is not installed';

const made: string[] = [];
after(() => {
  for (const dir of made) rmSync(dir, { recursive: true, force: true });
});

const fakeGh = String.raw`
$call = [ordered]@{ args = @($args); stdin = (@($input) -join '') -ne '' }
$call | ConvertTo-Json -Compress -Depth 5 | Add-Content -LiteralPath $env:FAKE_GH_LOG
$line = $args -join ' '
foreach ($answer in (Get-Content -Raw -LiteralPath $env:FAKE_GH_SCENARIO | ConvertFrom-Json)) {
    if ($line -match $answer.match) {
        if ($null -ne $answer.stdout) { $answer.stdout }
        exit [int]$answer.exit
    }
}
exit 0
`;

type Answer = { match: string; stdout?: string; exit?: number };
type Call = { args: string[]; stdin: boolean };

const org = 'NCodeGroup';
const appKey = 'NCODE_REVIEW_APP_PRIVATE_KEY';
const bedrock = 'AWS_BEARER_TOKEN_BEDROCK';

// An organization with the app installed on all repositories, the repositories alpha (id 101) and beta (id 102), and
// the app key limited to code-review. The Bedrock key exists, limited to code-review, unless withBedrock is false.
function scenario(withBedrock = true): Answer[] {
  const secret = (name: string): Answer[] => [
    { match: `^api orgs/${org}/actions/secrets/${name}/repositories\\?`, stdout: `${org}/code-review` },
    { match: `^api orgs/${org}/actions/secrets/${name}$`, stdout: JSON.stringify({ name, visibility: 'selected' }) },
  ];
  return [
    { match: `^api orgs/${org}/installations`, stdout: JSON.stringify({ installations: [{ id: 5, app_slug: 'ncode-review', repository_selection: 'all' }] }) },
    { match: `^api repos/${org}/alpha$`, stdout: JSON.stringify({ id: 101, full_name: `${org}/alpha`, default_branch: 'main' }) },
    { match: `^api repos/${org}/beta$`, stdout: JSON.stringify({ id: 102, full_name: `${org}/beta`, default_branch: 'main' }) },
    { match: '^api repos/[^ ]+$', exit: 1 },
    ...secret(appKey),
    ...(withBedrock ? secret(bedrock) : [{ match: `^api orgs/${org}/actions/secrets/${bedrock}$`, exit: 1 }]),
  ];
}

function run(args: string[], answers: Answer[]): { status: number | null; output: string; calls: Call[] } {
  const dir = mkdtempSync(path.join(tmpdir(), 'enable-code-review-'));
  made.push(dir);
  writeFileSync(path.join(dir, 'gh.ps1'), fakeGh);
  const scenarioPath = path.join(dir, 'scenario.json');
  writeFileSync(scenarioPath, JSON.stringify(answers));
  const log = path.join(dir, 'calls.jsonl');
  // Only the stand-in on PATH, and no Bedrock key in the environment, so the script can't reach the real gh or a real key.
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!/^(path|aws_bearer_token_bedrock|gh_token|github_token)$/i.test(key)) env[key] = value;
  }
  env['PATH'] = dir;
  env['FAKE_GH_LOG'] = log;
  env['FAKE_GH_SCENARIO'] = scenarioPath;
  const result = spawnSync(pwsh ?? 'pwsh', ['-NoProfile', '-NonInteractive', '-File', script, ...args], {
    encoding: 'utf8',
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 60_000,
  });
  const calls = existsSync(log)
    ? readFileSync(log, 'utf8').split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line) as Call)
    : [];
  return { status: result.status, output: `${result.stdout}${result.stderr}`, calls };
}

const joined = (calls: Call[]): string[] => calls.map((call) => call.args.join(' '));
const grant = (name: string, id: number): string => `api -X PUT orgs/${org}/actions/secrets/${name}/repositories/${id} --silent`;

test('-SkipBedrock gives the opted-in repositories access to the existing Bedrock key, without setting it', { skip }, () => {
  const { status, output, calls } = run(['-Repo', 'alpha', '-SkipBedrock'], scenario());
  assert.equal(status, 0, output);
  const lines = joined(calls);
  assert.ok(lines.includes(grant(bedrock, 101)), lines.join('\n'));
  assert.ok(lines.includes(grant(appKey, 101)), lines.join('\n'));
  assert.ok(!lines.some((line) => line.startsWith('secret set')), lines.join('\n'));
  assert.match(output, /Gave NCodeGroup\/alpha access to AWS_BEARER_TOKEN_BEDROCK\./);
});

test('-SkipBedrock skips the Bedrock key, without prompting, when the organization has none', { skip }, () => {
  const { status, output, calls } = run(['-Repo', 'alpha', '-SkipBedrock'], scenario(false));
  assert.equal(status, 0, output);
  const lines = joined(calls);
  assert.ok(!lines.some((line) => line.includes(bedrock) && (line.startsWith('secret set') || line.includes('-X PUT'))), lines.join('\n'));
  assert.ok(lines.includes(grant(appKey, 101)), lines.join('\n'));
  assert.match(output, /Skipped AWS_BEARER_TOKEN_BEDROCK: NCodeGroup doesn't have it yet/);
});

test('-Repo takes a comma-separated list as one value, as pwsh -File passes it', { skip }, () => {
  for (const value of ['alpha,beta', 'alpha, beta']) {
    const { status, output, calls } = run(['-Repo', value, '-SkipBedrock'], scenario());
    assert.equal(status, 0, output);
    const lines = joined(calls);
    for (const id of [101, 102]) {
      assert.ok(lines.includes(grant(appKey, id)), `${value}\n${lines.join('\n')}`);
      assert.ok(lines.includes(grant(bedrock, id)), `${value}\n${lines.join('\n')}`);
    }
  }
});

test('-Repo a, b through pwsh -File fails before any change, instead of binding b to another parameter', { skip }, () => {
  const { status, output, calls } = run(['-Repo', 'alpha,', 'beta', '-SkipBedrock'], scenario());
  assert.notEqual(status, 0, output);
  assert.match(output, /positional parameter cannot be found/i);
  assert.deepEqual(calls, []);
});

test('-UpdateBedrockKey and -SkipBedrock together are refused before any change', { skip }, () => {
  const { status, output, calls } = run(['-Repo', 'alpha', '-UpdateBedrockKey', '-SkipBedrock'], scenario());
  assert.notEqual(status, 0, output);
  assert.match(output, /Pass -UpdateBedrockKey or -SkipBedrock, not both\./);
  assert.deepEqual(calls, []);
});

import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, describe, test } from 'node:test';

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
// Skipped locally without pwsh; in CI the tests run, and fail, so a runner without it can't pass them unchecked.
const skip = pwsh || process.env['CI'] ? false : 'pwsh is not installed';

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
        if ($null -ne $answer.stderr) { Write-Error $answer.stderr }
        exit [int]$answer.exit
    }
}
exit 0
`;

type Answer = { match: string; stdout?: string; stderr?: string; exit?: number };
type Call = { args: string[]; stdin: boolean };

const org = 'NCodeGroup';
const appKey = 'NCODE_REVIEW_APP_PRIVATE_KEY';
const bedrock = 'AWS_BEARER_TOKEN_BEDROCK';

// An organization with the app installed on all repositories, the repositories alpha (id 101) and beta (id 102), and
// the app key limited to code-review. The Bedrock key is limited to code-review, visible to all repositories, or
// missing (gh answers 404).
function scenario(bedrockKey: 'selected' | 'all' | 'missing' = 'selected'): Answer[] {
  const secret = (name: string, visibility = 'selected'): Answer[] => [
    { match: `^api orgs/${org}/actions/secrets/${name}/repositories\\?`, stdout: `${org}/code-review` },
    { match: `^api orgs/${org}/actions/secrets/${name}$`, stdout: JSON.stringify({ name, visibility }) },
  ];
  return [
    { match: `^api orgs/${org}/installations`, stdout: JSON.stringify({ installations: [{ id: 5, app_slug: 'ncode-review', repository_selection: 'all' }] }) },
    { match: `^api repos/${org}/alpha$`, stdout: JSON.stringify({ id: 101, full_name: `${org}/alpha`, default_branch: 'main' }) },
    { match: `^api repos/${org}/beta$`, stdout: JSON.stringify({ id: 102, full_name: `${org}/beta`, default_branch: 'main' }) },
    { match: '^api repos/[^ ]+$', exit: 1 },
    ...secret(appKey),
    ...(bedrockKey === 'missing'
      ? [{ match: `^api orgs/${org}/actions/secrets/${bedrock}$`, stdout: '{"message":"Not Found","status":"404"}', stderr: 'gh: Not Found (HTTP 404)', exit: 1 }]
      : secret(bedrock, bedrockKey)),
  ];
}

function tempDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'enable-code-review-'));
  made.push(dir);
  return dir;
}

async function run(args: string[], answers: Answer[]): Promise<{ status: number | null; output: string; calls: Call[] }> {
  assert.ok(pwsh, 'pwsh is not installed, and CI needs it to test tools/Enable-CodeReview.ps1');
  const command = pwsh;
  const dir = tempDir();
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
  const result = await new Promise<{ status: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(command, ['-NoProfile', '-NonInteractive', '-File', script, ...args], {
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 60_000,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
    });
    child.on('error', reject);
    child.on('close', (status) => resolve({ status, stdout, stderr }));
  });
  const calls = existsSync(log)
    ? readFileSync(log, 'utf8').split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line) as Call)
    : [];
  // pwsh's error view colours the message and wraps it across lines that start with "|"; join them back up.
  const output = `${result.stdout}${result.stderr}`.replace(/\x1b\[[0-9;]*m/g, '').replace(/\s*\r?\n {5}\| /g, ' ');
  return { status: result.status, output, calls };
}

const joined = (calls: Call[]): string[] => calls.map((call) => call.args.join(' '));
const grant = (name: string, id: number): string => `api -X PUT orgs/${org}/actions/secrets/${name}/repositories/${id} --silent`;

// Each test waits on its own pwsh processes, so they run together.
describe('tools/Enable-CodeReview.ps1', { concurrency: true }, () => {
  test('-SkipBedrock gives the opted-in repositories access to the existing Bedrock key, without setting it', { skip }, async () => {
    const { status, output, calls } = await run(['-Repo', 'alpha', '-SkipBedrock'], scenario());
    assert.equal(status, 0, output);
    const lines = joined(calls);
    assert.ok(lines.includes(grant(bedrock, 101)), lines.join('\n'));
    assert.ok(lines.includes(grant(appKey, 101)), lines.join('\n'));
    assert.ok(!lines.some((line) => line.startsWith('secret set')), lines.join('\n'));
    assert.match(output, /Gave NCodeGroup\/alpha access to AWS_BEARER_TOKEN_BEDROCK\./);
  });

  test('-SkipBedrock skips the Bedrock key, without prompting, when the organization has none', { skip }, async () => {
    const { status, output, calls } = await run(['-Repo', 'alpha', '-SkipBedrock'], scenario('missing'));
    assert.equal(status, 0, output);
    const lines = joined(calls);
    assert.ok(!lines.some((line) => line.includes(bedrock) && (line.startsWith('secret set') || line.includes('-X PUT'))), lines.join('\n'));
    assert.ok(lines.includes(grant(appKey, 101)), lines.join('\n'));
    assert.match(output, /Skipped AWS_BEARER_TOKEN_BEDROCK: NCodeGroup doesn't have it yet/);
  });

  test('-Repo takes a comma-separated list as one value, as pwsh -File passes it', { skip }, async () => {
    for (const value of ['alpha,beta', 'alpha, beta']) {
      const { status, output, calls } = await run(['-Repo', value, '-SkipBedrock'], scenario());
      assert.equal(status, 0, output);
      const lines = joined(calls);
      for (const id of [101, 102]) {
        assert.ok(lines.includes(grant(appKey, id)), `${value}\n${lines.join('\n')}`);
        assert.ok(lines.includes(grant(bedrock, id)), `${value}\n${lines.join('\n')}`);
      }
    }
  });

  test('-Repo a, b through pwsh -File fails before any change, instead of binding b to another parameter', { skip }, async () => {
    const { status, output, calls } = await run(['-Repo', 'alpha,', 'beta', '-SkipBedrock'], scenario());
    assert.notEqual(status, 0, output);
    assert.match(output, /positional parameter cannot be found/i);
    assert.deepEqual(calls, []);
  });

  test('-UpdateBedrockKey and -SkipBedrock together are refused before any change', { skip }, async () => {
    const { status, output, calls } = await run(['-Repo', 'alpha', '-UpdateBedrockKey', '-SkipBedrock'], scenario());
    assert.notEqual(status, 0, output);
    assert.match(output, /Pass -UpdateBedrockKey or -SkipBedrock, not both\./);
    assert.deepEqual(calls, []);
  });

  test('-SkipBedrock sends no Bedrock grant when the Bedrock key is visible to all repositories', { skip }, async () => {
    const { status, output, calls } = await run(['-Repo', 'alpha', '-SkipBedrock'], scenario('all'));
    assert.equal(status, 0, output);
    const lines = joined(calls);
    assert.ok(!lines.some((line) => line.includes(bedrock) && (line.startsWith('secret set') || line.includes('-X PUT'))), lines.join('\n'));
    assert.ok(lines.includes(grant(appKey, 101)), lines.join('\n'));
  });

  test('-SkipBedrock stops, instead of skipping the Bedrock key, when gh fails to read it for another reason than 404', { skip }, async () => {
    const failing: Answer = { match: `^api orgs/${org}/actions/secrets/${bedrock}$`, stderr: 'gh: Server Error (HTTP 500)', exit: 1 };
    const { status, output, calls } = await run(['-Repo', 'alpha', '-SkipBedrock'], [failing, ...scenario()]);
    assert.notEqual(status, 0, output);
    assert.match(output, /Couldn't read the organization secret AWS_BEARER_TOKEN_BEDROCK/);
    assert.match(output, /HTTP 500/);
    assert.doesNotMatch(output, /doesn't have it yet/);
    assert.ok(!joined(calls).some((line) => line.includes(bedrock) && line.includes('-X PUT')), joined(calls).join('\n'));
  });

  test('-Repo takes <org>/<name> and ignores empty entries', { skip }, async () => {
    const { status, output, calls } = await run(['-Repo', `${org}/alpha,,beta,`, '-SkipBedrock'], scenario());
    assert.equal(status, 0, output);
    const lines = joined(calls);
    assert.deepEqual(lines.filter((line) => line.startsWith('api repos/') && !line.includes('/environments/')), [`api repos/${org}/alpha`, `api repos/${org}/beta`]);
    const grants = lines.filter((line) => line.includes('-X PUT') && line.includes('/actions/secrets/'));
    assert.deepEqual(grants.sort(), [grant(appKey, 101), grant(appKey, 102), grant(bedrock, 101), grant(bedrock, 102)].sort());
  });

  test('A failed grant stops the script with gh\'s exit code and the admin:org hint', { skip }, async () => {
    const failing: Answer = { match: `^api -X PUT orgs/${org}/actions/secrets/${appKey}/repositories/101 `, exit: 1 };
    const { status, output, calls } = await run(['-Repo', 'alpha,beta', '-SkipBedrock'], [failing, ...scenario()]);
    assert.notEqual(status, 0, output);
    assert.match(output, /Couldn't give NCodeGroup\/alpha access to NCODE_REVIEW_APP_PRIVATE_KEY/);
    assert.match(output, /exited with code 1/);
    assert.match(output, /admin:org/);
    const lines = joined(calls);
    assert.ok(lines.includes(grant(appKey, 101)), lines.join('\n'));
    assert.ok(!lines.includes(grant(appKey, 102)), lines.join('\n'));
    assert.ok(!lines.some((line) => line.includes(bedrock) && line.includes('-X PUT')), lines.join('\n'));
  });

  test('A failed secret set stops the script with gh\'s exit code and the admin:org hint', { skip }, async () => {
    const pem = path.join(tempDir(), 'app.pem');
    writeFileSync(pem, '-----BEGIN RSA PRIVATE KEY-----\nnot-a-real-key\n-----END RSA PRIVATE KEY-----\n');
    const failing: Answer = { match: `^secret set ${appKey} `, exit: 1 };
    const { status, output, calls } = await run(['-Repo', 'alpha', '-AppPrivateKeyPath', pem, '-SkipBedrock'], [failing, ...scenario()]);
    assert.notEqual(status, 0, output);
    assert.match(output, /Couldn't set NCODE_REVIEW_APP_PRIVATE_KEY/);
    assert.match(output, /exited with code 1/);
    assert.match(output, /admin:org/);
    assert.doesNotMatch(output, /not-a-real-key/);
    const lines = joined(calls);
    const set = calls.find((call) => call.args[0] === 'secret' && call.args[1] === 'set');
    assert.ok(set?.stdin, lines.join('\n'));
    assert.ok(!lines.some((line) => line.includes(bedrock) && line.includes('-X PUT')), lines.join('\n'));
  });
});

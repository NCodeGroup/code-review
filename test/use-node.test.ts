import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, describe, test } from 'node:test';

// tools/Use-Node.ps1 is PowerShell, so these tests run it in a real pwsh process. Each runs a copy of it beside its own
// .node-version, and the only node and nvs on its PATH are stand-ins, so the machine's own Node.js and nvs play no part.

const script = path.resolve(import.meta.dirname, '..', 'tools', 'Use-Node.ps1');

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

// A folder holding a node stand-in that prints `v<version>`.
function nodeAt(base: string, version: string): string {
  const dir = path.join(base, `node-${version}`);
  mkdirSync(dir);
  writeFileSync(path.join(dir, 'node.ps1'), `'v${version}'\n`);
  return dir;
}

// Runs a copy of the script with .node-version naming `wanted` and `node` printing `onPath`. With `nvsHas`, an nvs
// stand-in is on PATH too: it records its arguments and, like `nvs use`, puts that version's node first on PATH.
async function run(wanted: string, onPath: string, nvsHas?: string): Promise<{ status: number | null; output: string; nvsCalls: string[] }> {
  assert.ok(pwsh, 'pwsh is not installed, and CI needs it to test tools/Use-Node.ps1');
  // The same path, kept in a const so the assertion's narrowing to string holds inside the Promise callback below.
  const command = pwsh;
  const base = mkdtempSync(path.join(tmpdir(), 'use-node-'));
  made.push(base);
  mkdirSync(path.join(base, 'tools'));
  copyFileSync(script, path.join(base, 'tools', 'Use-Node.ps1'));
  writeFileSync(path.join(base, '.node-version'), `${wanted}\n`);
  const bin = path.join(base, 'bin');
  mkdirSync(bin);
  const log = path.join(base, 'nvs.log');
  if (nvsHas !== undefined) {
    const switched = nodeAt(base, nvsHas);
    writeFileSync(path.join(bin, 'nvs.ps1'), `Add-Content -LiteralPath '${log}' -Value ($args -join ' ')\n$env:PATH = '${switched}' + [IO.Path]::PathSeparator + $env:PATH\n`);
  }
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!/^path$/i.test(key)) env[key] = value;
  }
  env['PATH'] = [bin, nodeAt(base, onPath)].join(path.delimiter);
  const result = await new Promise<{ status: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    // Dot-sourced, as the Landing section's prelude runs it.
    const child = spawn(command, ['-NoProfile', '-NonInteractive', '-Command', `. '${path.join(base, 'tools', 'Use-Node.ps1')}'`], {
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
  const nvsCalls = existsSync(log) ? readFileSync(log, 'utf8').split(/\r?\n/).filter(Boolean) : [];
  // pwsh's error view colours the message and wraps it across lines that start with "|"; join them back up.
  const output = `${result.stdout}${result.stderr}`.replace(/\x1b\[[0-9;]*m/g, '').replace(/\s*\r?\n {5}\| /g, ' ');
  return { status: result.status, output, nvsCalls };
}

// Each test waits on its own pwsh process, so they run together.
describe('tools/Use-Node.ps1', { concurrency: true }, () => {
  test('accepts a Node.js on PATH whose version is a release of the major version .node-version names', { skip }, async () => {
    const { status, output } = await run('24', '24.15.0');
    assert.equal(status, 0, output);
  });

  test('throws, naming both versions, when the Node.js on PATH is an older major version', { skip }, async () => {
    const { status, output } = await run('24', '22.22.2');
    assert.notEqual(status, 0, output);
    assert.match(output, /Node\.js 22\.22\.2 is on PATH, but \.node-version names 24\./);
  });

  test('throws when the version on PATH only starts with the digits .node-version names', { skip }, async () => {
    const { status, output } = await run('24', '240.0.0');
    assert.notEqual(status, 0, output);
    assert.match(output, /Node\.js 240\.0\.0 is on PATH/);
  });

  test('switches to the version .node-version names with nvs when nvs is on PATH', { skip }, async () => {
    const { status, output, nvsCalls } = await run('24', '22.22.2', '24.15.0');
    assert.equal(status, 0, output);
    assert.deepEqual(nvsCalls, ['use 24']);
  });
});

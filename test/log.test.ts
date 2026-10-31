import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { logText, writeErrorLog, writeLog } from '../src/log.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('logText turns each line break into a space', () => {
  assert.equal(logText('a\nb\r\nc\rd\u2028e'), 'a b c d e');
});

test('logText drops the other control characters', () => {
  assert.equal(logText('x\u001b[31m\u0007y'), 'x[31my');
});

test('logText leaves printable text as it is', () => {
  assert.equal(logText('::warning::src/ok file.ts'), '::warning::src/ok file.ts');
});

test('writeLog writes the cleaned line to the console', (t) => {
  const logged = t.mock.method(console, 'log', () => {});
  writeLog('a\nb');
  assert.equal(logged.mock.callCount(), 1);
  assert.deepEqual(logged.mock.calls[0]!.arguments, ['a b']);
});

test("writeErrorLog writes the cleaned line to the console's errors", (t) => {
  const logged = t.mock.method(console, 'error', () => {});
  writeErrorLog('a\nb');
  assert.equal(logged.mock.callCount(), 1);
  assert.deepEqual(logged.mock.calls[0]!.arguments, ['a b']);
});

test('no file in src/ but log.ts writes to the console', () => {
  const src = path.join(root, 'src');
  for (const file of readdirSync(src).filter((name) => name.endsWith('.ts') && name !== 'log.ts')) {
    assert.doesNotMatch(readFileSync(path.join(src, file), 'utf8'), /\bconsole\b|\bprocess\s*(\?\.|\.|\[\s*['"`])\s*std(out|err)\b|\{[^}]*\bstd(out|err)\b[^}]*\}\s*=\s*process\b/, `src/${file} writes to the console; use writeLog or writeErrorLog from src/log.ts`);
  }
});

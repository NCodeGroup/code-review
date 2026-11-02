import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { logText, writeErrorLog, writeFailure, writeLog } from '../src/log.ts';

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

test('writeFailure writes the message as an ::error:: line, then each stack frame on a line of its own', (t) => {
  const logged = t.mock.method(console, 'error', () => {});
  const error = new Error('a\nb');
  error.stack = 'Error: a\nb\n    at f (/x/src/contracts.ts:95:41)\n    at g (/x/src/gather.ts:497:3)';
  writeFailure(error);
  assert.deepEqual(
    logged.mock.calls.map((call) => call.arguments[0]),
    ['::error::a b', 'at f (/x/src/contracts.ts:95:41)', 'at g (/x/src/gather.ts:497:3)'],
  );
});

test('writeFailure writes an error without a stack as its message alone', (t) => {
  const logged = t.mock.method(console, 'error', () => {});
  const error = new Error('x');
  delete error.stack;
  writeFailure(error);
  assert.deepEqual(
    logged.mock.calls.map((call) => call.arguments[0]),
    ['::error::x'],
  );
});

test("writeFailure writes a thrown value that isn't an Error as text", (t) => {
  const logged = t.mock.method(console, 'error', () => {});
  writeFailure('boom');
  assert.deepEqual(
    logged.mock.calls.map((call) => call.arguments[0]),
    ['::error::boom'],
  );
});

test('the review, publish and finish steps report a crash with writeFailure', () => {
  for (const file of ['main.ts', 'publish.ts', 'finish.ts']) {
    const source = readFileSync(path.join(root, 'src', file), 'utf8');
    assert.match(source, /\bwriteFailure\(error\)/, `src/${file} doesn't report a crash with writeFailure`);
    assert.doesNotMatch(source, /::error::\$\{\(error as Error\)\.message\}/, `src/${file} still writes a crash's message by hand`);
  }
});

test('no file in src/ but log.ts writes to the console', () => {
  const src = path.join(root, 'src');
  for (const file of readdirSync(src).filter((name) => name.endsWith('.ts') && name !== 'log.ts')) {
    assert.doesNotMatch(readFileSync(path.join(src, file), 'utf8'), /\bconsole\b|\bprocess\s*(\?\.|\.|\[\s*['"`])\s*std(out|err)\b|\{[^}]*\bstd(out|err)\b[^}]*\}\s*=\s*process\b/, `src/${file} writes to the console; use writeLog or writeErrorLog from src/log.ts`);
  }
});

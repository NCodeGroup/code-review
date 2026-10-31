import assert from 'node:assert/strict';
import { test } from 'node:test';
import { logText, writeErrorLog, writeLog } from '../src/log.ts';

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

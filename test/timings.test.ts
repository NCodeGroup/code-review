import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { phaseSpans, readTraces, roleSummary, type TimedCall } from '../tools/timings.ts';

function call(role: string, durationMs: number, extra: Partial<TimedCall> = {}): TimedCall {
  return { role, model: 'm', durationMs, turns: 1, costUsd: 0.1, ...extra };
}

test('phaseSpans spans each phase from its first start to its last end, and leaves out phases without start times', () => {
  const spans = phaseSpans([
    call('context', 1000, { startedAt: 100 }),
    call('reviewer:a', 3000, { startedAt: 1100 }),
    call('reviewer:b', 1000, { startedAt: 2000 }),
    call('synthesis', 500),
    call('other', 500, { startedAt: 0 }),
  ]);
  assert.deepEqual(spans, { context: 1000, reviewers: 3000 });
});

test("roleSummary gives each role's median and p90 duration, slowest first", () => {
  const calls = [
    call('fast', 100),
    ...[10, 20, 30, 40, 50, 60, 70, 80, 90, 100].map((ms) => call('slow', ms * 1000, { firstResponseMs: ms })),
  ];
  const [slow, fast] = roleSummary(calls);
  assert.equal(slow?.role, 'slow');
  assert.equal(slow?.calls, 10);
  assert.equal(slow?.medianMs, 60_000);
  assert.equal(slow?.p90Ms, 100_000);
  assert.equal(slow?.medianFirstResponseMs, 60);
  assert.equal(fast?.role, 'fast');
  assert.equal(fast?.medianMs, 100);
  assert.equal(fast?.medianFirstResponseMs, undefined);
});

test('readTraces finds trace.json files in nested folders and skips a trace without calls', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'timings-'));
  try {
    mkdirSync(path.join(dir, '1', 'a'), { recursive: true });
    mkdirSync(path.join(dir, '2'), { recursive: true });
    writeFileSync(
      path.join(dir, '1', 'a', 'trace.json'),
      JSON.stringify({
        results: { durationMs: 5000, costUsd: 1.5, calls: [call('context', 1000, { startedAt: 5 }), { role: 'bad', model: 'm', durationMs: 'x', turns: 1, costUsd: 0 }] },
        timings: { startedAt: 1, prepare: 200 },
      }),
    );
    writeFileSync(path.join(dir, '2', 'trace.json'), JSON.stringify({ explain: {} }));
    const traces = readTraces([dir]);
    assert.equal(traces.length, 1);
    assert.equal(traces[0]?.durationMs, 5000);
    assert.equal(traces[0]?.calls.length, 1);
    assert.equal(traces[0]?.calls[0]?.startedAt, 5);
    assert.deepEqual(traces[0]?.timings, { startedAt: 1, prepare: 200 });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

import assert from 'node:assert/strict';
import test from 'node:test';
import { runLeadersFirst } from '../src/concurrency.ts';

// Items whose calls wait until the test finishes them, recording the order they started in.
function harness() {
  const started: string[] = [];
  const signals = new Map<string, () => void>();
  const finishers = new Map<string, { resolve: () => void; reject: (error: Error) => void }>();
  let running = 0;
  let peak = 0;
  const fn = (item: string, signal: () => void) => {
    started.push(item);
    signals.set(item, signal);
    running++;
    peak = Math.max(peak, running);
    return new Promise<void>((resolve, reject) => {
      finishers.set(item, {
        resolve: () => {
          running--;
          resolve();
        },
        reject,
      });
    });
  };
  return {
    started,
    fn,
    signal: (item: string) => signals.get(item)!(),
    finish: (item: string) => finishers.get(item)!.resolve(),
    fail: (item: string, error: Error) => finishers.get(item)!.reject(error),
    peak: () => peak,
  };
}

const settle = () => new Promise((resolve) => setImmediate(resolve));

test("runLeadersFirst starts a group's rest when its leader calls started, before the leader finishes and whatever the other groups' leaders do", async () => {
  const h = harness();
  const done = runLeadersFirst([['a1', 'a2'], ['b1', 'b2']], [], 4, () => 1, h.fn);
  await settle();
  assert.deepEqual(h.started, ['a1', 'b1']);
  h.signal('a1');
  await settle();
  assert.deepEqual(h.started, ['a1', 'b1', 'a2']);
  h.finish('a1');
  h.finish('a2');
  h.finish('b1');
  await settle();
  h.finish('b2');
  await done;
});

test("runLeadersFirst starts a group's rest when its leader finishes without calling started", async () => {
  const h = harness();
  const done = runLeadersFirst([['a1', 'a2']], [], 4, () => 1, h.fn);
  await settle();
  assert.deepEqual(h.started, ['a1']);
  h.finish('a1');
  await settle();
  assert.deepEqual(h.started, ['a1', 'a2']);
  h.finish('a2');
  await done;
});

test('runLeadersFirst never runs more than limit items at once, and starts waiting leaders before released items', async () => {
  const h = harness();
  const done = runLeadersFirst([['a1', 'a2'], ['b1', 'b2'], ['c1', 'c2']], [], 2, () => 1, h.fn);
  await settle();
  assert.deepEqual(h.started, ['a1', 'b1']);
  h.finish('a1');
  await settle();
  assert.deepEqual(h.started, ['a1', 'b1', 'c1']);
  h.finish('b1');
  await settle();
  assert.deepEqual(h.started, ['a1', 'b1', 'c1', 'a2']);
  h.finish('c1');
  await settle();
  h.finish('a2');
  await settle();
  h.finish('b2');
  await settle();
  h.finish('c2');
  await done;
  assert.equal(h.peak(), 2);
});

test('runLeadersFirst starts released items longest-expected first, and the after items only once every group is released', async () => {
  const h = harness();
  const seconds: Record<string, number> = { a1: 1, b1: 1, a2: 5, b2: 9, z: 100 };
  const done = runLeadersFirst([['a1', 'a2'], ['b1', 'b2']], ['z'], 1, (item) => seconds[item]!, h.fn);
  await settle();
  for (const item of ['a1', 'b1', 'b2', 'a2']) {
    h.finish(item);
    await settle();
  }
  assert.deepEqual(h.started, ['a1', 'b1', 'b2', 'a2', 'z']);
  h.finish('z');
  await done;
});

test('runLeadersFirst keeps the after items waiting while a group is unreleased, even with a free slot', async () => {
  const h = harness();
  const done = runLeadersFirst([['a1', 'a2'], ['b1', 'b2']], ['z'], 4, () => 1, h.fn);
  await settle();
  h.signal('a1');
  await settle();
  // a2 is released and running; b is still unreleased and a slot is free, but z must not start.
  assert.deepEqual(h.started, ['a1', 'b1', 'a2']);
  h.signal('b1');
  await settle();
  assert.deepEqual(h.started, ['a1', 'b1', 'a2', 'b2']);
  h.finish('a1');
  await settle();
  assert.deepEqual(h.started, ['a1', 'b1', 'a2', 'b2', 'z']);
  for (const item of ['b1', 'a2', 'b2', 'z']) h.finish(item);
  await done;
});

test('runLeadersFirst resolves at once with nothing to run', async () => {
  const h = harness();
  await runLeadersFirst([], [], 3, () => 1, h.fn);
  await runLeadersFirst([[]], [], 3, () => 1, h.fn);
  assert.deepEqual(h.started, []);
});

test('runLeadersFirst rejects when an item fails', async () => {
  const h = harness();
  const done = runLeadersFirst([['a1', 'a2']], [], 2, () => 1, h.fn);
  await settle();
  h.fail('a1', new Error('boom'));
  await assert.rejects(done, /boom/);
});

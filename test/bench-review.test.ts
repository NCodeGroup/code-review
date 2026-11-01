import assert from 'node:assert/strict';
import { test } from 'node:test';
import { benchReview } from '../tools/bench-review.ts';

test('benchReview runs the whole review on the fake agent: context, selection, eight reviewers, four rule checks and synthesis', async () => {
  const { calls } = await benchReview({ msPerSecond: 1 });
  const roles = calls.map((c) => c.role);
  for (const role of ['context', 'selection', 'synthesis', 'reviewer:security']) assert.ok(roles.includes(role), `${role} ran`);
  assert.equal(roles.filter((r) => r === 'reviewer:rule-check').length, 4);
  const context = calls.find((c) => c.role === 'context')!;
  assert.ok(calls.filter((c) => c.role.startsWith('reviewer:')).every((c) => context.startMs < c.startMs));
});

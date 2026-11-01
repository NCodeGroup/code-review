import assert from 'node:assert/strict';
import { test } from 'node:test';
import { withLookupLimit, type WriterCheck } from '../src/writers.ts';

function recording(): { asked: (string | undefined)[]; isWriter: WriterCheck } {
  const asked: (string | undefined)[] = [];
  return {
    asked,
    isWriter: async (login) => {
      asked.push(login);
      return true;
    },
  };
}

test('withLookupLimit counts a writer association without a lookup', async () => {
  const { asked, isWriter } = recording();
  assert.equal(await withLookupLimit(isWriter, 2)('a', 'MEMBER'), true);
  assert.deepEqual(asked, []);
});

test('withLookupLimit looks up at most its limit of other logins and counts the rest as non-writers', async () => {
  const { asked, isWriter } = recording();
  const limited = withLookupLimit(isWriter, 2);
  assert.equal(await limited('l0', 'CONTRIBUTOR'), true);
  assert.equal(await limited('l1', 'CONTRIBUTOR'), true);
  assert.equal(await limited('l2', 'CONTRIBUTOR'), false);
  assert.equal(await limited('l0', 'CONTRIBUTOR'), true);
  assert.deepEqual(asked, ['l0', 'l1', 'l0']);
});

test('withLookupLimit counts a reply without an author as a non-writer', async () => {
  const { asked, isWriter } = recording();
  assert.equal(await withLookupLimit(isWriter, 2)(undefined, 'NONE'), false);
  assert.deepEqual(asked, []);
});

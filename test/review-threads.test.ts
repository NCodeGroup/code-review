import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readThreadPages } from '../src/review-threads.ts';

const paging = { fields: 'id path', pageSize: 7, maxPages: 3 };

// One page of threads, with a next page when `next` names its cursor.
function page(nodes: unknown[], next: string | null = null) {
  return { data: { repository: { pullRequest: { reviewThreads: { pageInfo: { hasNextPage: next !== null, endCursor: next }, nodes } } } } };
}

test('readThreadPages reads every page, passing the cursor', async () => {
  const cursors: unknown[] = [];
  const api = async (_method: string, _url: string, body?: any) => {
    cursors.push(body.variables.cursor);
    return body.variables.cursor === null ? page([{ id: 'a' }], 'c1') : page([{ id: 'b' }]);
  };
  const read = await readThreadPages<{ id: string }>(api, 'o/r', 5, paging);
  assert.deepEqual(read, { threads: [{ id: 'a' }, { id: 'b' }], complete: true });
  assert.deepEqual(cursors, [null, 'c1']);
});

test("readThreadPages stops at maxPages and says it isn't complete", async () => {
  let calls = 0;
  const api = async () => page([{ id: `t${++calls}` }], `c${calls}`);
  const read = await readThreadPages(api, 'o/r', 5, paging);
  assert.equal(calls, 3);
  assert.equal(read.threads.length, 3);
  assert.equal(read.complete, false);
});

test('readThreadPages throws on GraphQL errors and on an answer without threads', async () => {
  await assert.rejects(readThreadPages(async () => ({ errors: [{ message: 'boom' }] }), 'o/r', 5, paging), /GitHub refused the review threads: boom/);
  await assert.rejects(readThreadPages(async () => ({ data: { repository: null } }), 'o/r', 5, paging), /Couldn't read the review threads of #5\./);
});

test("readThreadPages asks for the caller's fields and page size", async () => {
  const asked: any[] = [];
  const api = async (method: string, url: string, body?: any) => {
    asked.push({ call: `${method} ${url}`, body });
    return page([]);
  };
  await readThreadPages(api, 'o/r', 5, paging);
  assert.equal(asked[0].call, 'POST /graphql');
  assert.ok(asked[0].body.query.includes('first: 7'));
  assert.ok(asked[0].body.query.includes('nodes { id path }'));
  assert.deepEqual(asked[0].body.variables, { owner: 'o', name: 'r', number: 5, cursor: null });
});

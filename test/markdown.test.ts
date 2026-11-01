import assert from 'node:assert/strict';
import { test } from 'node:test';
import { neutralizeMentions, plainText } from '../src/markdown.ts';

test('neutralizeMentions puts a zero-width space after an @ that starts a mention', () => {
  assert.equal(neutralizeMentions('Ask @someone or @org/team'), 'Ask @\u200bsomeone or @\u200borg/team');
  assert.equal(neutralizeMentions('a @ b'), 'a @ b');
});

test('plainText removes backticks, brackets and line breaks', () => {
  assert.equal(plainText('a`b[c]\r\nd'), 'abcd');
});

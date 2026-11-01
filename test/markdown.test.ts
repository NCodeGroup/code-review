import assert from 'node:assert/strict';
import { test } from 'node:test';
import { neutralizeMentions, neutralizeProse, plainText } from '../src/markdown.ts';

test('neutralizeMentions puts a zero-width space after an @ that starts a mention', () => {
  assert.equal(neutralizeMentions('Ask @someone or @org/team'), 'Ask @\u200bsomeone or @\u200borg/team');
  assert.equal(neutralizeMentions('a @ b'), 'a @ b');
});

test('plainText removes backticks, brackets and line breaks', () => {
  assert.equal(plainText('a`b[c]\r\nd'), 'abcd');
});

test('neutralizeProse puts a zero-width space in mentions and links in prose', () => {
  assert.equal(
    neutralizeProse('Ask @someone: see [docs](https://x.y), http://a and www.b.c'),
    'Ask @\u200bsomeone: see [docs]\u200b(https:\u200b//x.y), http:\u200b//a and www\u200b.b.c',
  );
});

test('neutralizeProse leaves an inline code span as written', () => {
  assert.equal(neutralizeProse('Use `@Override` or `[a](b)`, @x'), 'Use `@Override` or `[a](b)`, @\u200bx');
});

test('neutralizeProse leaves a fenced code block as written', () => {
  assert.equal(neutralizeProse('Fix:\n```java\n@Override\n```\nthen @team'), 'Fix:\n```java\n@Override\n```\nthen @\u200bteam');
});

test('neutralizeProse opens no code span at a backslash-escaped backtick', () => {
  assert.equal(neutralizeProse('\\`@user\\`'), '\\`@\u200buser\\`');
});

test('neutralizeProse escapes everything when a backtick has no closer on its line', () => {
  assert.equal(neutralizeProse('a ` b\n`@x` c'), 'a ` b\n`@\u200bx` c');
});

test('neutralizeProse escapes everything for an indented, first-line or unclosed fence', () => {
  assert.equal(neutralizeProse('x\n  ```\n@y\n  ```'), 'x\n  ```\n@\u200by\n  ```');
  assert.equal(neutralizeProse('```js\n@x\n```'), '```js\n@\u200bx\n```');
  assert.equal(neutralizeProse('x\n```\n@y'), 'x\n```\n@\u200by');
});

test('neutralizeProse reads a lone carriage return as a line break', () => {
  assert.equal(neutralizeProse('x\n```\n@x\r```\n@y\n```'), 'x\n```\n@\u200bx\n```\n@\u200by\n```');
  assert.equal(neutralizeProse('x\r\n```\r\n@x\r\n```\r\ny @z'), 'x\r\n```\r\n@x\r\n```\r\ny @\u200bz');
});

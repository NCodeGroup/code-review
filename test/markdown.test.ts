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

test('neutralizeProse breaks every character reference to an @', () => {
  assert.equal(
    neutralizeProse('Hi &#64;a, &#x40;b, &#X0040;c, &#000064;d and &commat;e'),
    'Hi &\u200b#64;a, &\u200b#x40;b, &\u200b#X0040;c, &\u200b#000064;d and &\u200bcommat;e',
  );
});

test('neutralizeProse breaks character references in an http or https scheme', () => {
  assert.equal(
    neutralizeProse('See http&#58;//a, https:&#x2F;/b and HTTP&colon;&sol;&#047;c'),
    'See http&\u200b#58;//a, https:&\u200b#x2F;/b and HTTP&\u200bcolon;&\u200bsol;&\u200b#047;c',
  );
});

test('neutralizeProse breaks character references where a ] meets a (, [ or :', () => {
  assert.equal(
    neutralizeProse('[a]&#40;b) [c]&#x5B;d] [e]&colon; f&#93;(g) h&rsqb;&lpar;i)'),
    '[a]&\u200b#40;b) [c]&\u200b#x5B;d] [e]&\u200bcolon; f&\u200b#93;(g) h&\u200brsqb;&\u200blpar;i)',
  );
});

test('neutralizeProse leaves a character reference in a code span as written', () => {
  assert.equal(neutralizeProse('`&#64;x http&#58;//y` and &#64;z'), '`&#64;x http&#58;//y` and &\u200b#64;z');
});

test('neutralizeProse leaves a character reference that forms no mention or link as written', () => {
  assert.equal(neutralizeProse('a&#58; b, &#47;c, x&#93; and &#40;y'), 'a&#58; b, &#47;c, x&#93; and &#40;y');
});

test('neutralizeProse reads a lone carriage return as a line break', () => {
  assert.equal(neutralizeProse('x\n```\n@x\r```\n@y\n```'), 'x\n```\n@\u200bx\n```\n@\u200by\n```');
  assert.equal(neutralizeProse('x\r\n```\r\n@x\r\n```\r\ny @z'), 'x\r\n```\r\n@x\r\n```\r\ny @\u200bz');
});

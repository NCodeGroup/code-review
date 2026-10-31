import assert from 'node:assert/strict';
import { test } from 'node:test';
import { maskCSharp } from '../src/csharp.ts';

// The masked text keeps the code, with whatever isn't code turned into spaces.
const code = (text: string) => maskCSharp(text).replace(/\s+/g, ' ').trim();

test('maskCSharp keeps the length and every line break', () => {
  const text = 'var a = "x";\r\n/* one\ntwo */ var b = 1;\n// end\n';
  const masked = maskCSharp(text);
  assert.equal(masked.length, text.length);
  assert.deepEqual([...masked].map((c, i) => (c === '\n' || c === '\r' ? i : -1)).filter((i) => i >= 0), [...text].map((c, i) => (c === '\n' || c === '\r' ? i : -1)).filter((i) => i >= 0));
});

test('maskCSharp masks line and block comments, a block comment over several lines included', () => {
  assert.equal(code('int a; // public class X {\nint b; /* {\n} */ int c;'), 'int a; int b; int c;');
});

test('maskCSharp masks regular, verbatim and interpolated strings whole, and keeps the code after them', () => {
  assert.equal(code('f("a}\\"{"); g();'), 'f( ); g();');
  assert.equal(code('f(@"x""}"); g();'), 'f( ); g();');
  assert.equal(code('f($"{(a ? "}" : "{")} {{"); g();'), 'f( ); g();');
  assert.equal(code('f($@"{x}\n}"); g();'), 'f( ); g();');
});

test('maskCSharp masks a raw string over several lines', () => {
  assert.equal(code('var s = """\npublic class X {\n""";\nGo();'), 'var s = ; Go();');
});

test('maskCSharp masks char literals, quotes and braces among them', () => {
  assert.equal(code("f('\"'); g('{'); h('\\''); i();"), 'f( ); g( ); h( ); i();');
});

test('maskCSharp masks preprocessor lines', () => {
  assert.equal(code('#if DEBUG\n  #region {\nGo();\n#endif'), 'Go();');
});

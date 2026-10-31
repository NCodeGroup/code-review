import assert from 'node:assert/strict';
import { test } from 'node:test';
import { declarationSpans, maskCSharp, type DeclarationSpan } from '../src/csharp.ts';

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

// Each span as its kind, visibility and lines, with its parent's start line, for comparing two layouts of the same code.
const shape = (text: string) =>
  declarationSpans(text)?.map((s) => ({ ...s.declaration, start: s.start, open: s.open, end: s.end, parent: s.parent?.start }));

test('declarationSpans reads the same declarations from K&R and Allman braces', () => {
  const kr = declarationSpans('public class A {\n    public void M() {\n        Go();\n    }\n}\n')!;
  const allman = declarationSpans('public class A\n{\n    public void M()\n    {\n        Go();\n    }\n}\n')!;
  const strip = (spans: DeclarationSpan[]) => spans.map((s) => ({ declaration: s.declaration, parent: s.parent?.declaration }));
  assert.deepEqual(strip(kr), strip(allman));
  assert.deepEqual(shape('public class A\n{\n    public void M()\n    {\n        Go();\n    }\n}\n'), [
    { kind: 'type', visible: true, membersPublic: false, start: 0, open: 1, end: 6, parent: undefined },
    { kind: 'member', visible: true, start: 2, open: 3, end: 5, parent: 0 },
  ]);
});

test('declarationSpans spans an expression-bodied member to its semicolon', () => {
  assert.deepEqual(shape('public class A\n{\n    public int M() =>\n        Go();\n}\n')?.[1], { kind: 'member', visible: true, start: 2, open: 3, end: 3, parent: 0 });
});

test('declarationSpans reads a member under an attribute with an array in it', () => {
  assert.deepEqual(shape('[Attr(new[] { 1 })] public void M() { }'), [{ kind: 'member', visible: true, start: 0, open: 0, end: 0, parent: undefined }]);
});

test('declarationSpans leaves namespaces out, file-scoped or with a block', () => {
  assert.deepEqual(shape('namespace N;\npublic class A { }\n'), [{ kind: 'type', visible: true, membersPublic: false, start: 1, open: 1, end: 1, parent: undefined }]);
  assert.deepEqual(shape('namespace N\n{\n    public class A { }\n}\n'), [{ kind: 'type', visible: true, membersPublic: false, start: 2, open: 2, end: 2, parent: undefined }]);
});

test("declarationSpans gives up when the braces don't balance", () => {
  assert.equal(declarationSpans('public class A { } }'), undefined);
  assert.equal(declarationSpans('public class A {\n    public void M() {\n}\n'), undefined);
});

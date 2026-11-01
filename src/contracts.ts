// What the selection floor needs to know about each changed C# file: whether the default branch packs its project, and
// whether its diff touches a public member or a serialized contract. It reads files and text; it never builds or runs
// anything.

import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { declaration, declarationSpans, type DeclarationSpan } from './csharp.ts';
import type { ChangedFile } from './gather.ts';

const isPackableElement = /<IsPackable(?:\s[^>]*)?>\s*(true|false)\s*<\/IsPackable>/gi;

// What one MSBuild file sets IsPackable to: true when any IsPackable element in it says true, a conditional one
// included, so the floor fails closed; false when each says false; undefined when it has none or doesn't exist; and
// 'unreadable' when it exists but can't be read.
function packableIn(file: string): boolean | undefined | 'unreadable' {
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT' ? undefined : 'unreadable';
  }
  const values = [...text.matchAll(isPackableElement)].map((m) => m[1]!.toLowerCase() === 'true');
  return values.length ? values.includes(true) : undefined;
}

// Whether a project packs, as MSBuild reads IsPackable: each Directory.Build.props from the repository root down to the
// project's folder, then the .csproj, then each Directory.Build.targets from the root down; the last file that sets it
// wins. Reading every props file, outer first, stands in for the usual pattern of each one importing its parent's. A
// file that exists but can't be read makes the project packed, so the floor fails closed.
function projectPacks(basePath: string, folder: string, project: string): boolean {
  const parts = folder ? folder.split('/') : [];
  const folders = ['', ...parts.map((_, i) => parts.slice(0, i + 1).join('/'))];
  const files = [
    ...folders.map((f) => path.join(basePath, f, 'Directory.Build.props')),
    path.join(basePath, folder, project),
    ...folders.map((f) => path.join(basePath, f, 'Directory.Build.targets')),
  ];
  let packs = false;
  for (const file of files) {
    const value = packableIn(file);
    if (value === 'unreadable') return true;
    if (value !== undefined) packs = value;
  }
  return packs;
}

// Whether the .csproj nearest above a file packs it, by PublicAPI.Shipped.txt beside it or IsPackable in it or in the
// Directory.Build.props and .targets above it, read from the default branch's checkout only, so a pull request can't
// make its own project count as packed.
export function isPackableProject(basePath: string, file: string, cache = new Map<string, boolean>()): boolean {
  const parts = file.split('/');
  if (parts.some((p) => p === '' || p === '.' || p === '..')) return false;
  // Every folder the walk passes has no project of its own, so it gets the answer of the one it stops at.
  const visited: string[] = [];
  const answer = (packable: boolean) => {
    for (const folder of visited) cache.set(folder, packable);
    return packable;
  };
  for (let depth = parts.length - 1; depth >= 0; depth--) {
    const folder = parts.slice(0, depth).join('/');
    const known = cache.get(folder);
    if (known !== undefined) return answer(known);
    visited.push(folder);
    let names: string[];
    try {
      names = readdirSync(path.join(basePath, folder));
    } catch {
      continue;
    }
    const projects = names.filter((n) => n.endsWith('.csproj'));
    if (!projects.length) continue;
    return answer(names.includes('PublicAPI.Shipped.txt') || projects.some((p) => projectPacks(basePath, folder, p)));
  }
  return answer(false);
}

const notCode = /^\s*([{}()[\]#]|\/\/|\/\*|\*)/;

interface HeadScan {
  // The declarations around head line `index` (0-based), innermost first; with `gap`, the ones around the gap a removed
  // line left before it. Undefined when the head's braces don't balance.
  around(index: number, gap: boolean): DeclarationSpan[] | undefined;
  // The first line at or below `index` that is code, not a blank, a brace, an attribute or a comment.
  codeFrom(index: number): string | undefined;
}

// Reads a file at the head for the changed lines of its diff: its braces once, then the innermost declaration on each
// line, so a large file costs its length and not its length times its changes.
function scanHead(head: string): HeadScan {
  const lines = head.split(/\r?\n/);
  const spans = declarationSpans(head);
  const innermost: (DeclarationSpan | undefined)[] = new Array(lines.length);
  // A span opens after the one it sits in, so the inner one is written last.
  for (const span of spans ?? []) for (let line = span.start; line <= span.end && line < lines.length; line++) innermost[line] = span;
  const isCode = (line: string) => line.trim() !== '' && !notCode.test(line);
  // Lines from codeStart up to codeEnd aren't code; codeEnd is, or is the end of the file.
  let codeStart = 0;
  let codeEnd = -1;
  return {
    around(index, gap) {
      if (!spans) return undefined;
      let span = gap ? (index > 0 ? innermost[index - 1] : undefined) : innermost[index];
      // Around a gap: the declarations that hold the lines on both sides of it.
      while (span && gap && span.end < index) span = span.parent;
      const chain: DeclarationSpan[] = [];
      for (; span; span = span.parent) chain.push(span);
      return chain;
    },
    codeFrom(index) {
      if (index < codeStart || index > codeEnd) {
        codeStart = index;
        codeEnd = index;
        while (codeEnd < lines.length && !isCode(lines[codeEnd]!)) codeEnd++;
      }
      return lines[codeEnd];
    },
  };
}

// Whether a changed line declares, or sits inside, a public or protected member of a public type. `above` is the number
// of the head's lines before it; for a removed line, the gap it left is there. The line's own text decides first, then
// the declarations the head's braces put around it.
function inVisibleMember(head: HeadScan, above: number, code: string, removed: boolean): boolean {
  let own = declaration(code);
  // An attribute belongs to the declaration below it.
  if (!own && /^\s*\[/.test(code)) {
    const next = head.codeFrom(above);
    own = next === undefined ? undefined : declaration(next);
  }
  if (own?.kind === 'namespace' || own?.visible === false) return false;
  const chain = head.around(above, removed);
  // A head whose braces don't balance can't place the line, so it counts as public: the floor fails closed.
  if (!chain) return true;
  if (own) return chain.every((s) => s.declaration.visible);
  const inner = chain[0];
  if (!inner) return false;
  // Straight inside a class or struct's body, outside any member with an access modifier: a private field or a blank.
  if (inner.declaration.kind === 'type' && !inner.declaration.membersPublic && above > inner.open) return false;
  return chain.every((s) => s.declaration.visible);
}

// Whether a .cs file's diff adds or removes a line that declares, or sits inside, a public or protected member: a
// change to the surface, or to the behavior behind it. head is the file at the pull request's head, '' when deleted.
export function touchesPublicMember(section: string, head: string): boolean {
  const scan = scanHead(head);
  let next = 0;
  let inHunk = false;
  for (const text of section.split('\n')) {
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(text);
    if (hunk) {
      next = Number(hunk[1]);
      inHunk = true;
      continue;
    }
    if (!inHunk) continue;
    if (text.startsWith(' ')) next++;
    if (!text.startsWith('+') && !text.startsWith('-')) continue;
    const code = text.slice(1).replace(/\r$/, '');
    // An added line is head line `next`; a removed one sits before it.
    const above = next - 1;
    const removed = text.startsWith('-');
    if (!removed) next++;
    if (!code.trim() || /^\s*(\/\/|\/\*|\*)/.test(code)) continue;
    if (inVisibleMember(scan, above, code, removed)) return true;
  }
  return false;
}

// DbContext has no leading \w*: it matches the same names, AppDbContext too, without backtracking through long words.
const contractMarker = /\b(?:JsonPropertyName|DataMember|JsonSerializerContext|IEntityTypeConfiguration)\b|DbContext\b/;

// Whether a file's diff, in its hunks with their context, touches a serialized or persisted contract.
export function touchesSerializedContract(section: string): boolean {
  const hunks = section.indexOf('\n@@');
  return hunks >= 0 && contractMarker.test(section.slice(hunks));
}

// Marks what the selection floor needs to know about each changed .cs file; which of them are tests is the floor's to
// say. Whether its project is packed comes from the default branch; the head's copies, read through readHeads as data,
// only place changed lines. A packed file whose head can't be read counts as a public change, so the floor fails closed.
export function markContracts(files: ChangedFile[], sections: Map<string, string>, basePath: string, readHeads: (files: string[]) => Map<string, string>): void {
  const projects = new Map<string, boolean>();
  const unread: { file: ChangedFile; section: string }[] = [];
  for (const file of files) {
    const section = sections.get(file.path);
    if (file.generated || !section || !/\.cs$/i.test(file.path)) continue;
    if (touchesSerializedContract(section)) file.serializedContract = true;
    if (!isPackableProject(basePath, file.path, projects)) continue;
    file.packable = true;
    if (!/^\+\+\+ \/dev\/null$/m.test(section)) unread.push({ file, section });
    else if (touchesPublicMember(section, '')) file.publicMember = true;
  }
  if (!unread.length) return;
  const heads = readHeads(unread.map(({ file }) => file.path));
  for (const { file, section } of unread) {
    const head = heads.get(file.path);
    if (head === undefined || touchesPublicMember(section, head)) file.publicMember = true;
  }
}

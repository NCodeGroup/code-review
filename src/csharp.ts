// A scanner for C#, enough to tell which member a line belongs to without a C# parser: it masks the text that isn't
// code, then follows the braces. It never compiles or runs anything; the api-compat floor uses it on the head's files.

const blankable = (c: string) => c !== '\n' && c !== '\r';

// Skips a char literal starting at `i`: one character, two after a backslash, then on to the closing quote or the end
// of the line.
function skipChar(text: string, i: number): number {
  let j = i + 1;
  j += text[j] === '\\' ? 2 : 1;
  while (j < text.length && text[j] !== "'" && text[j] !== '\n') j++;
  return text[j] === "'" ? j + 1 : j;
}

// Whether a string literal starts at `i`: a quote, or a run of $ and @ prefixes before one.
function startsString(text: string, i: number): boolean {
  let j = i;
  while (text[j] === '$' || text[j] === '@') j++;
  return text[j] === '"';
}

// Skips an interpolation hole, from just after its `{` to just after its closing `}`, with the strings and chars in it.
function skipHole(text: string, i: number): number {
  let depth = 0;
  let j = i;
  while (j < text.length) {
    const c = text[j]!;
    if (startsString(text, j)) {
      j = skipString(text, j);
      continue;
    }
    if (c === "'") {
      j = skipChar(text, j);
      continue;
    }
    if (c === '{') depth++;
    else if (c === '}') {
      if (depth === 0) return j + 1;
      depth--;
    }
    j++;
  }
  return text.length;
}

// Skips a string literal starting at `i`, its $ and @ prefixes included: regular, verbatim, interpolated or raw.
function skipString(text: string, i: number): number {
  let q = i;
  let dollars = 0;
  let verbatim = false;
  for (; text[q] === '$' || text[q] === '@'; q++) {
    if (text[q] === '$') dollars++;
    else verbatim = true;
  }
  let quotes = 0;
  while (text[q + quotes] === '"') quotes++;
  if (quotes >= 3) {
    // A raw string ends at the next run of as many quotes; its holes need no parsing to be masked.
    const end = text.indexOf('"'.repeat(quotes), q + quotes);
    return end < 0 ? text.length : end + quotes;
  }
  if (quotes === 2) return q + 2;
  let j = q + 1;
  while (j < text.length) {
    const c = text[j]!;
    if (!verbatim && c === '\n') return j;
    if (!verbatim && c === '\\') {
      j += 2;
      continue;
    }
    if (c === '"') {
      if (verbatim && text[j + 1] === '"') {
        j += 2;
        continue;
      }
      return j + 1;
    }
    if (dollars > 0 && c === '{') {
      j = text[j + 1] === '{' ? j + 2 : skipHole(text, j + 1);
      continue;
    }
    j++;
  }
  return text.length;
}

// The text with every comment, string or char literal and preprocessor line turned into spaces, line breaks kept, so
// what's left is code at the same offsets and on the same lines.
export function maskCSharp(text: string): string {
  const out = text.split('');
  const blank = (from: number, to: number) => {
    for (let k = from; k < to && k < text.length; k++) if (blankable(text[k]!)) out[k] = ' ';
  };
  const lineEnd = (from: number) => {
    const end = text.indexOf('\n', from);
    return end < 0 ? text.length : end;
  };
  let i = 0;
  while (i < text.length) {
    if ((i === 0 || text[i - 1] === '\n') && /^[ \t]*#/.test(text.slice(i, lineEnd(i)))) {
      const end = lineEnd(i);
      blank(i, end);
      i = end;
      continue;
    }
    const c = text[i]!;
    let end = -1;
    if (c === '/' && text[i + 1] === '/') end = lineEnd(i);
    else if (c === '/' && text[i + 1] === '*') {
      const close = text.indexOf('*/', i + 2);
      end = close < 0 ? text.length : close + 2;
    } else if (c === "'") end = skipChar(text, i);
    else if (startsString(text, i)) end = skipString(text, i);
    if (end < 0) {
      i++;
      continue;
    }
    blank(i, end);
    i = end;
  }
  return out.join('');
}

export type Declaration =
  | { kind: 'namespace' }
  | { kind: 'type'; visible: boolean; membersPublic: boolean }
  | { kind: 'member'; visible: boolean };

const modifierRun = /^\s*(?:\[[^\]]*\]\s*)*((?:(?:public|protected|private|internal|static|virtual|override|abstract|sealed|async|extern|unsafe|new|readonly|partial|required|const|volatile|file|ref|event|implicit|explicit)\s+)*)/;
const accessWords = new Set(['public', 'protected', 'private', 'internal']);

// A C# line read as a declaration, from its leading modifiers. Members without an access modifier are private (or a
// statement) and read as nothing.
export function declaration(line: string): Declaration | undefined {
  if (/^\s*namespace\b/.test(line)) return { kind: 'namespace' };
  const match = modifierRun.exec(line)!;
  const modifiers = match[1]!.split(/\s+/).filter(Boolean);
  const visible = modifiers.includes('public') || (modifiers.includes('protected') && !modifiers.includes('private'));
  const type = /^(class|struct|interface|enum|record)\s+[A-Za-z_@]/.exec(line.slice(match[0].length));
  if (type) return { kind: 'type', visible, membersPublic: type[1] === 'interface' || type[1] === 'enum' };
  if (modifiers.some((m) => accessWords.has(m))) return { kind: 'member', visible };
  return undefined;
}

export type MemberOrType = Exclude<Declaration, { kind: 'namespace' }>;

// A type or member declaration and the lines it spans, 0-based and inclusive: from its first attribute or modifier to
// its closing brace, or its semicolon when it has no body. `open` is the line of its opening brace, or of that semicolon.
export interface DeclarationSpan {
  start: number;
  open: number;
  end: number;
  declaration: MemberOrType;
  parent: DeclarationSpan | undefined;
}

// Drops leading attributes, counting brackets, so an attribute with an array or an indexer in it ends where it does.
function stripAttributes(header: string): string {
  let text = header;
  while (text.startsWith('[')) {
    let depth = 0;
    let end = -1;
    for (let k = 0; k < text.length; k++) {
      if (text[k] === '[') depth++;
      else if (text[k] === ']' && --depth === 0) {
        end = k;
        break;
      }
    }
    if (end < 0) return text;
    text = text.slice(end + 1).trimStart();
  }
  return text;
}

// A statement's masked text, read as the declaration it opens; a namespace isn't one a member can sit in.
function classify(header: string): MemberOrType | undefined {
  const found = declaration(stripAttributes(header.replace(/\s+/g, ' ').trim()));
  return found?.kind === 'namespace' ? undefined : found;
}

// The type and member declarations in a C# file, in the order they open, each with the one it sits in. Only braces and
// semicolons outside parentheses and brackets count, so a lambda in an argument or an attribute's array stays inside its
// statement. Undefined when the braces don't balance, such as #if branches that each open one.
export function declarationSpans(text: string): DeclarationSpan[] | undefined {
  const masked = maskCSharp(text);
  const spans: DeclarationSpan[] = [];
  const frames: (DeclarationSpan | undefined)[] = [];
  const parent = () => frames.findLast((frame) => frame !== undefined);
  let line = 0;
  let depth = 0;
  let start = -1;
  let startLine = 0;
  for (let i = 0; i < masked.length; i++) {
    const c = masked[i]!;
    if (c === '\n') {
      line++;
      continue;
    }
    if (/\s/.test(c)) continue;
    if (c === '(' || c === '[') depth++;
    else if (c === ')' || c === ']') depth = Math.max(0, depth - 1);
    if (depth > 0 || !'{};'.includes(c)) {
      if (start < 0) {
        start = i;
        startLine = line;
      }
      continue;
    }
    const found = start < 0 ? undefined : classify(masked.slice(start, i));
    if (c === '{') {
      const span = found ? { start: startLine, open: line, end: line, declaration: found, parent: parent() } : undefined;
      if (span) spans.push(span);
      frames.push(span);
    } else if (c === '}') {
      if (!frames.length) return undefined;
      const span = frames.pop();
      if (span) span.end = line;
    } else if (found) {
      spans.push({ start: startLine, open: line, end: line, declaration: found, parent: parent() });
    }
    start = -1;
  }
  return frames.length ? undefined : spans;
}

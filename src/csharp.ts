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

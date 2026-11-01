// The escaping the bot's comments share for text from a pull request or a model.

// Stops @mentions in quoted text from notifying anyone: a zero-width space after the @, which the training reader
// removes again.
export function neutralizeMentions(text: string): string {
  return text.replace(/@(?=[A-Za-z0-9_-])/g, '@\u200b');
}

// Text for a code span or a link's text: without a backtick, bracket or line break, which could end it or start a link.
export function plainText(text: string): string {
  return text.replace(/[`\[\]\r\n]/g, '');
}

// Model-written text for a comment, neutralized so it can't mention anyone, post a link or cross-reference an issue or
// pull request. Outside code, a zero-width space goes after an @ that starts a mention, between ] and a following (, [
// or :, between http: or https: and //, between www and a following dot, after a # followed by a digit (an issue or
// pull request reference such as #12 or owner/repo#12), and between GH and a - followed by a digit, where the - or the
// digit may also be a character reference such as &#45; and the zero-width space still goes right after GH. A character
// reference GitHub would decode into one of those also gets a zero-width space after its &, which keeps it literal
// text: any reference to @, references to # followed by a digit, and references to :, /, ], (, or [ in an http: or
// https: scheme followed by // or where a ] meets a following (, [ or :. Code stays as written: an inline code span, a
// backtick run no backslash escapes up to the next run of the same length on its line, and a fenced code block, opened
// at column 0 on a line after the first by three or more backticks (with no backtick after them) or tildes, and closed
// by a line of at most three spaces and a run of the same character at least as long. When GitHub might read the code
// differently (a backtick run with no closer on its line, a fence-like line that is indented or first, or a fence never
// closed), the whole text is escaped, code included: a zero-width space in code is invisible, and a ping isn't.
export function neutralizeProse(text: string): string {
  // CommonMark ends a line at a lone \r too, so the fence and code span rules below must see it as a line break.
  text = text.replace(/\r(?!\n)/g, '\n');
  const lines = text.split('\n');
  const out: string[] = [];
  let fence: string | undefined;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (fence) {
      out.push(line);
      const closing = /^ {0,3}(`{3,}|~{3,})[ \t]*\r?$/.exec(line)?.[1];
      if (closing && closing[0] === fence[0] && closing.length >= fence.length) fence = undefined;
      continue;
    }
    const opening = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    if (opening) {
      const run = opening[1]!;
      if (i === 0 || opening[0] !== run || (run[0] === '`' && line.slice(run.length).includes('`'))) return escapeProse(text);
      fence = run;
      out.push(line);
      continue;
    }
    const escaped = withCodeSpans(line);
    if (escaped === undefined) return escapeProse(text);
    out.push(escaped);
  }
  return fence ? escapeProse(text) : out.join('\n');
}

function escapeProse(text: string): string {
  return text
    .replace(hashBeforeDigit, (match) => (match === '#' ? '#\u200b' : match))
    .replace(hashReference, breakReferences)
    .replace(ghPrefix, '$1\u200b')
    .replace(atReference, breakReferences)
    .replace(schemeWithReference, breakReferences)
    .replace(bracketWithReference, breakReferences)
    .replace(/@(?=[A-Za-z0-9_-])/g, '@\u200b')
    .replace(/\](?=[([:])/g, ']\u200b')
    .replace(/(https?:)(?=\/\/)/gi, '$1\u200b')
    .replace(/(www)(?=\.)/gi, '$1\u200b');
}

// Character references GitHub decodes: decimal or hexadecimal with any leading zeros, or named.
const at = '&#0*64;|&#[xX]0*40;|&commat;';
const colon = ':|&#0*58;|&#[xX]0*3[aA];|&colon;';
const slash = '/|&#0*47;|&#[xX]0*2[fF];|&sol;';
const closeBracket = '\\]|&#0*93;|&#[xX]0*5[dD];|&rsqb;|&rbrack;';
const afterBracket = `[([]|&#0*40;|&#[xX]0*28;|&lpar;|&#0*91;|&#[xX]0*5[bB];|&lsqb;|&lbrack;|${colon}`;
const atReference = new RegExp(at, 'g');
const schemeWithReference = new RegExp(`[hH][tT][tT][pP][sS]?(?:${colon})(?:${slash})(?:${slash})`, 'g');
const bracketWithReference = new RegExp(`(?:${closeBracket})(?:${afterBracket})`, 'g');
const digit = '[0-9]|&#0*(?:4[89]|5[0-7]);|&#[xX]0*3[0-9];';
const hashBeforeDigit = new RegExp(`&#[0-9]{1,7};|#(?=${digit})`, 'g');
const hashReference = new RegExp(`(?:&#0*35;|&#[xX]0*23;|&num;)(?=${digit})`, 'g');
const ghPrefix = new RegExp(`(gh)(?=(?:-|&#0*45;|&#[xX]0*2[dD];)(?:${digit}))`, 'gi');

function breakReferences(match: string): string {
  return match.replace(/&(?=[#a-z])/g, '&\u200b');
}

// A line with its prose escaped and its code spans as written, or undefined when a backtick run has no closer on it.
function withCodeSpans(line: string): string | undefined {
  let out = '';
  let prose = '';
  for (let i = 0; i < line.length; ) {
    if (line[i] === '\\') {
      prose += line.slice(i, i + 2);
      i += 2;
      continue;
    }
    if (line[i] !== '`') {
      prose += line[i];
      i++;
      continue;
    }
    const run = /^`+/.exec(line.slice(i))![0].length;
    let close = -1;
    for (const match of line.slice(i + run).matchAll(/`+/g)) {
      if (match[0].length === run) {
        close = i + run + match.index;
        break;
      }
    }
    if (close < 0) return undefined;
    out += escapeProse(prose) + line.slice(i, close + run);
    prose = '';
    i = close + run;
  }
  return out + escapeProse(prose);
}

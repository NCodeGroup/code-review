// A finding that says a file isn't changed, when the pull request changes it, was written from a view of the diff that
// left the file out (issue #32). It's dropped before posting, and the summary comment, the check run and the trace
// record it. The guard is best-effort, behind synthesis seeing every changed file: its patterns catch the usual
// phrasings of the claim, kept narrow to spare findings about what the code does.

import type { ReviewedFinding } from './review.ts';

export interface DroppedFinding {
  finding: Omit<ReviewedFinding, 'id'>;
  // The changed file the finding says isn't changed, and the words that say so.
  file: string;
  claim: string;
}

function escape(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function baseName(file: string): string {
  return file.slice(file.lastIndexOf('/') + 1);
}

// The file named by its path, or by its name when no other changed file has that name, in backticks or quotes or as
// ./name, but not as part of a longer path or name, nor as "name's". A name with no dot or slash, such as `auth`, counts
// only in backticks or quotes: the author picks the file names, and a bare word would match ordinary prose.
function mention(file: string, nameIsUnique: boolean): string {
  const name = baseName(file);
  const names = nameIsUnique && name !== file ? [file, name] : [file];
  const paths = names.filter((n) => /[./]/.test(n)).map(escape);
  const words = names.filter((n) => !/[./]/.test(n)).map(escape);
  const forms: string[] = [];
  if (paths.length) forms.push(String.raw`[\x60'"]?(?<![\w./-])(?:\.\/)?(?:${paths.join('|')})(?![\w/-]|\.\w|'s\b)[\x60'"]?`);
  if (words.length) forms.push(String.raw`[\x60'"](?:\.\/)?(?:${words.join('|')})[\x60'"]`);
  return `(?:${forms.join('|')})`;
}

const changes = String.raw`(?:changes?|hunks?|diffs?|edits?|modifications?)`;
const where = String.raw`(?:the|this)\s+(?:diff|pull\s+request|PR|change)`;
// "not updated" only where it ends its clause or names the diff, so "config.ts is not updated to read the flag" is kept.
const notChanged = String.raw`not\s+(?:changed|modified|touched|edited|updated)(?=\s*(?:$|[.,;:!?)\x60'"]|(?:in|by)\s+${where}\b|(?:at\s+all|here|either|so|and|but|because|since)\b))`;
// The diff as the subject of a sentence, so "the handler never touches config.ts" is about the code, not the diff.
const theDiff = String.raw`\b(?:diff|pull\s+request|PR|(?:the|this)\s+(?:change|commit|branch))`;

// The file as the subject of a sentence, not as where something else is ("the caller in command.ts isn't in the diff").
function subject(file: string): string {
  return String.raw`(?<!\b(?:in|at|from|of|inside|within|by|to)\s+[\x60'"]?)${file}`;
}

function claimPatterns(file: string): RegExp[] {
  return [
    // "no changes to command.ts", "without a hunk for command.ts", but not "the fix needs no changes to command.ts"
    String.raw`(?<!\b(?:needs?|requires?|takes?|wants?)\s+)\b(?:no|without(?:\s+any|\s+a)?|not\s+any)\s+${changes}\s+(?:to|for|in|of|on)\s+(?:the\s+)?(?:file\s+)?${file}`,
    // "no command.ts hunk"
    String.raw`\bno\s+${file}\s+${changes}\b`,
    // "the PR doesn't change command.ts", "the diff never touches command.ts"
    String.raw`${theDiff}\s+(?:does\s+not|did\s+not|never)\s+(?:change|touch|modify|update|edit)(?:es|s|ed)?\s+(?:the\s+)?(?:file\s+)?${file}`,
    // "the diff doesn't include command.ts"
    String.raw`${theDiff}\s+(?:does\s+not|did\s+not|never)\s+(?:include|contain|show|cover)s?\s+(?:any\s+)?(?:changes?\s+(?:to|in)\s+)?(?:the\s+)?(?:file\s+)?${file}`,
    // "command.ts is unchanged", "command.ts isn't in the diff"
    String.raw`${subject(file)}(?:\s+file)?\s+(?:is|was|are|were|stays|remains|appears(?:\s+to\s+be)?|seems(?:\s+to\s+be)?)\s+(?:unchanged|untouched|unmodified|${notChanged}|not\s+(?:in|part\s+of|included\s+in|shown\s+in|present\s+in)\s+${where})\b`,
    // "command.ts is missing from the diff"
    String.raw`${subject(file)}(?:\s+file)?\s+(?:is\s+|was\s+)?(?:missing|absent)\s+from\s+${where}\b`,
  ].map((pattern) => new RegExp(pattern, 'i'));
}

// Reads "isn't" as "is not", so one pattern covers both.
function normalize(text: string): string {
  return text.replace(/[\u2018\u2019]/g, "'").replace(/\b(is|was|are|were|does|do|did|has|have|had)n't\b/gi, '$1 not');
}

// Splits the findings into the ones to post and the ones that say a changed file isn't changed. Only the title, problem
// and consequence are read: the evidence and the fix quote the pull request's own lines, which its author controls.
export function dropContradicted<T extends Omit<ReviewedFinding, 'id'>>(findings: T[], changedFiles: string[]): { kept: T[]; dropped: DroppedFinding[] } {
  const nameCounts = new Map<string, number>();
  for (const file of changedFiles) {
    const name = baseName(file);
    nameCounts.set(name, (nameCounts.get(name) ?? 0) + 1);
  }
  const checks = changedFiles.map((file) => {
    const unique = nameCounts.get(baseName(file)) === 1;
    return { file, patterns: claimPatterns(mention(file, unique)) };
  });
  const kept: T[] = [];
  const dropped: DroppedFinding[] = [];
  for (const finding of findings) {
    const text = normalize([finding.title, finding.problem, finding.consequence].join('\n'));
    let hit: { file: string; claim: string } | undefined;
    for (const { file, patterns } of checks) {
      const match = patterns.map((p) => p.exec(text)).find(Boolean);
      if (match) {
        hit = { file, claim: match[0].trim() };
        break;
      }
    }
    if (!hit) {
      kept.push(finding);
      continue;
    }
    const { id: _id, ...rest } = finding as Omit<ReviewedFinding, 'id'> & { id?: string };
    dropped.push({ finding: rest, ...hit });
  }
  return { kept, dropped };
}

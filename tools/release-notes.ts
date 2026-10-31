// Prints a version's section of CHANGELOG.md, for the Release workflow to publish as the release's notes, and fails when
// there is no `## [<version>] - <YYYY-MM-DD>` section with entries, so a tag never goes out before its changelog.
//
//   node tools/release-notes.ts <version> [<changelog>]
import { readFileSync } from 'node:fs';

const versionPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

function isCalendarDate(date: string): boolean {
  const parsed = new Date(`${date}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === date;
}

export function releaseNotes(changelog: string, version: string): string {
  if (!versionPattern.test(version)) throw new Error(`'${version}' isn't MAJOR.MINOR.PATCH, such as 0.1.0.`);
  const lines = changelog.split(/\r?\n/);
  const escaped = version.replaceAll('.', '\\.');
  const heading = new RegExp(`^## \\[${escaped}\\](?:\\s|$)`);
  const exact = new RegExp(`^## \\[${escaped}\\] - (\\d{4}-\\d{2}-\\d{2})\\s*$`);

  let start = -1;
  let inFence = false;
  for (const [index, line] of lines.entries()) {
    if (/^\s*(```|~~~)/.test(line)) inFence = !inFence;
    if (inFence || !heading.test(line)) continue;
    const date = exact.exec(line)?.[1];
    if (date === undefined || !isCalendarDate(date)) {
      throw new Error(`CHANGELOG.md's heading for ${version} is '${line.trim()}'; write it as '## [${version}] - YYYY-MM-DD'.`);
    }
    if (start >= 0) throw new Error(`CHANGELOG.md has more than one section for ${version}.`);
    start = index;
  }
  if (start < 0) throw new Error(`CHANGELOG.md has no '## [${version}] - YYYY-MM-DD' section; add one, with the release's changes, before releasing.`);

  // The section runs to the next second-level heading, or to the link definitions at the end of the file.
  const body: string[] = [];
  inFence = false;
  for (const line of lines.slice(start + 1)) {
    if (/^\s*(```|~~~)/.test(line)) inFence = !inFence;
    if (!inFence && (/^## /.test(line) || /^\[[^\]]+\]:\s*\S/.test(line))) break;
    body.push(line);
  }
  const notes = body.join('\n').trim();
  if (!/^\s*[-*+]\s+\S/m.test(notes)) throw new Error(`CHANGELOG.md's section for ${version} lists no changes.`);
  return `${notes}\n`;
}

if (import.meta.main) {
  try {
    const [version, file = 'CHANGELOG.md'] = process.argv.slice(2);
    if (version === undefined) throw new Error('Usage: node tools/release-notes.ts <version> [<changelog>]');
    process.stdout.write(releaseNotes(readFileSync(file, 'utf8'), version));
  } catch (error) {
    console.error(`::error::${(error as Error).message}`);
    process.exitCode = 1;
  }
}

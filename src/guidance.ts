// The layout of one learned guidance bullet, in guidance/*.md: training writes it, and the engine reads its tag.
//
//   - **statement** why *Check:* check *Note:* note *Applies to:* `glob`, `glob` <sub>source; source</sub>
//
// The "*Applies to:*" field names the files the bullet applies to, from the instruction files it was learned from.
// A bullet without it applies to every file.

export const appliesToLabel = '*Applies to:*';

export interface GuidanceRule { statement: string; why: string; check: string; sources: string[]; note?: string }

const appliesTo = String.raw` \*Applies to:\* ((?:\`[^\`]+\`(?:, )?)+)`;
const bullet = new RegExp(String.raw`^- \*\*(.+?)\*\* (.*?) \*Check:\* (.*?)(?: \*Note:\* (.*?))?(?:${appliesTo})? <sub>(.*)<\/sub>$`);
const tag = new RegExp(`${appliesTo}(?: <sub>.*</sub>)?$`);

export function formatBullet(rule: GuidanceRule, globs: string[]): string {
  const scope = globs.length ? ` ${appliesToLabel} ${globs.map((g) => `\`${g}\``).join(', ')}` : '';
  return `- **${rule.statement}** ${rule.why} *Check:* ${rule.check}${rule.note ? ` *Note:* ${rule.note}` : ''}${scope} <sub>${rule.sources.join('; ')}</sub>`;
}

export function parseBullet(line: string): GuidanceRule | undefined {
  const match = bullet.exec(line);
  if (!match) return undefined;
  const [, statement, why, check, note, , sources] = match;
  return { statement: statement!, why: why!, check: check!, ...(note ? { note } : {}), sources: sources!.split('; ') };
}

// The globs a bullet's "*Applies to:*" field lists; none when it has no such field.
export function bulletGlobs(line: string): string[] {
  const field = tag.exec(line)?.[1] ?? '';
  return [...field.matchAll(/`([^`]+)`/g)].map((m) => m[1]!);
}

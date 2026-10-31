// A reviewer's charter and its frontmatter: the "key: value" lines between a leading "---" line and the next one. The
// engine's charters (reviewers/*.md) and a repository's own read it the same way, so a setting such as shadow: means
// the same in both.

export interface Charter {
  // The charter without its frontmatter: what the reviewer is given.
  text: string;
  // A shadow reviewer runs as usual, but its findings go only to the trace and the check run's shadow section.
  shadow: boolean;
}

const frontmatterPattern = /^\uFEFF?---[ \t]*\r?\n((?:.*\r?\n)*?)---[ \t]*(?:\r?\n|$)/;

// The frontmatter's top-level "key: value" pairs and the text after it. Lines that aren't a pair, such as comments,
// list items and nested keys, are left out.
export function splitFrontmatter(raw: string): { fields: Record<string, string>; body: string } {
  const match = frontmatterPattern.exec(raw);
  if (!match) return { fields: {}, body: raw };
  const fields: Record<string, string> = {};
  for (const line of match[1]!.split(/\r?\n/)) {
    const pair = /^([A-Za-z][\w-]*)[ \t]*:[ \t]*(.*?)[ \t]*$/.exec(line);
    if (!pair) continue;
    const value = pair[2]!.replace(/[ \t]+#.*$/, '');
    fields[pair[1]!] = /^(["']).*\1$/.test(value) ? value.slice(1, -1) : value;
  }
  return { fields, body: raw.slice(match[0].length) };
}

export function parseCharter(raw: string): Charter {
  const { fields, body } = splitFrontmatter(raw);
  return { text: body, shadow: /^true$/i.test(fields['shadow'] ?? '') };
}

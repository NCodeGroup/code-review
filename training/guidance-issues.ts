// Reads the closed `review-guidance` issues `/review teach org` opened in NCodeGroup/code-review into
// training/feedback.md, so the next generalization follows the rules the maintainer accepted. Only an issue the bot
// opened, for an NCodeGroup-wide rule, and closed as completed counts; one closed as not planned is dropped.

import { botLogin } from '../src/results.ts';
import { guidanceLabel, guidanceMarker, orgGuidanceRepository } from '../src/teach.ts';

export interface GuidanceIssue {
  number: number;
  html_url: string;
  body?: string | null;
  state_reason?: string | null;
  user?: { login?: string } | null;
  pull_request?: unknown;
}

export interface TaughtRule {
  number: number;
  url: string;
  rule: string;
}

// The rule in an issue `/review teach org` opened: the fenced block under "### Rule", without the zero-width spaces
// that kept its mentions from notifying anyone. Undefined for an issue that isn't one.
export function ruleFromIssue(issue: GuidanceIssue): string | undefined {
  if (issue.pull_request || issue.user?.login !== botLogin || issue.state_reason !== 'completed') return undefined;
  const body = (issue.body ?? '').replace(/\r\n/g, '\n');
  if (!body.startsWith(guidanceMarker('org'))) return undefined;
  const block = /^### Rule\n\n(`{3,})text\n([\s\S]*?)\n\1$/m.exec(body);
  const rule = block?.[2]?.replace(/@\u200b/g, '@').trim();
  return rule || undefined;
}

const pageSize = 100;

// Reads every closed issue with the label, a page at a time. Tests pass their own fetch.
export async function fetchGuidanceIssues(repository: string, token: string | undefined, fetchApi: typeof fetch = fetch): Promise<GuidanceIssue[]> {
  const issues: GuidanceIssue[] = [];
  for (let page = 1; ; page++) {
    const url = `https://api.github.com/repos/${repository}/issues?state=closed&labels=${guidanceLabel}&per_page=${pageSize}&page=${page}`;
    const response = await fetchApi(url, {
      headers: { accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28', ...(token ? { authorization: `Bearer ${token}` } : {}) },
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) throw new Error(`GitHub refused GET ${url}: HTTP ${response.status}`);
    const batch = (await response.json()) as GuidanceIssue[];
    issues.push(...batch);
    if (batch.length < pageSize) return issues;
  }
}

export function taughtRules(issues: GuidanceIssue[]): TaughtRule[] {
  return issues
    .flatMap((issue) => {
      const rule = ruleFromIssue(issue);
      return rule ? [{ number: issue.number, url: issue.html_url, rule }] : [];
    })
    .sort((a, b) => a.number - b.number);
}

const heading = '## Taught with /review teach';

// feedback.md with its taught-rules section replaced by these rules, or removed when there are none. The rest of the
// file, the maintainer's own corrections, is kept as it is.
export function withTaughtRules(feedback: string, rules: TaughtRule[], repository = orgGuidanceRepository): string {
  const text = feedback.replace(/\r\n/g, '\n');
  const start = text.indexOf(`\n${heading}\n`);
  let before = start >= 0 ? text.slice(0, start) : text;
  let after = '';
  if (start >= 0) {
    const next = text.indexOf('\n## ', start + heading.length + 1);
    after = next >= 0 ? text.slice(next) : '';
  }
  before = before.replace(/\n+$/, '');
  if (!rules.length) return `${before}\n${after.replace(/^\n+/, '\n')}`.replace(/\n*$/, '\n');
  const bullets = rules.map((r) => `- ${r.rule.split('\n').join('\n  ')} ([${repository}#${r.number}](${r.url}))`);
  const section = [
    heading,
    '',
    `<!-- Written by \`npm run train\` from the closed \`${guidanceLabel}\` issues in ${repository}; each run rewrites this section, so change a rule in its issue. -->`,
    '',
    ...bullets,
  ].join('\n');
  return `${before}\n\n${section}\n${after}`.replace(/\n*$/, '\n');
}

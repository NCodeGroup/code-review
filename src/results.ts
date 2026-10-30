// What the review step hands the publish step, and how it reads in the check run.

import type { CallRecord } from './agent.ts';
import type { Provider } from './config.ts';
import type { ReviewedFinding } from './review.ts';

export interface Results {
  repository: string;
  pullRequest: number;
  headSha: string;
  provider: Provider;
  providerReason: string;
  summary: string;
  findings: ReviewedFinding[];
  reviewers: { name: string; status: 'ran' | 'failed'; findingCount: number; error?: string }[];
  calls: CallRecord[];
  costUsd: number;
  durationMs: number;
  notShown: string[];
}

const severityLabel = { blocker: 'Blocker', 'should-fix': 'Should fix', nit: 'Nit' } as const;

// GitHub renders the check run's text as Markdown; keep code-like text from breaking the table or injecting HTML.
function cell(text: string): string {
  return text.replace(/\|/g, '\\|').replace(/[\r\n]+/g, ' ').replace(/</g, '&lt;');
}

export function checkTitle(results: Results): string {
  const counts = { blocker: 0, 'should-fix': 0, nit: 0 };
  for (const f of results.findings) counts[f.severity]++;
  if (!results.findings.length) return 'No findings (shadow mode)';
  const parts = [`${counts.blocker} blocker`, `${counts['should-fix']} should-fix`, `${counts.nit} nit`];
  return `${parts.join(', ')} (shadow mode)`;
}

export function checkSummary(results: Results): string {
  const cost = `$${results.costUsd.toFixed(2)}`;
  const lines = [
    results.summary.replace(/</g, '&lt;'),
    '',
    `Shadow mode: these findings appear only in this check run. ${cost} on ${results.provider === 'anthropic' ? 'the Claude API' : 'Amazon Bedrock'}, ${Math.round(results.durationMs / 1000)}s.`,
  ];
  if (results.notShown.length) {
    lines.push('', `Not reviewed (over the size budget): ${results.notShown.slice(0, 20).map((f) => `\`${cell(f)}\``).join(', ')}${results.notShown.length > 20 ? ` and ${results.notShown.length - 20} more` : ''}.`);
  }
  return lines.join('\n');
}

export function checkText(results: Results): string {
  const out: string[] = [];
  for (const f of results.findings) {
    out.push(
      `### ${f.id} · ${severityLabel[f.severity]} · \`${cell(f.file)}:${f.line}\``,
      '',
      `**${cell(f.title)}** ${f.problem.replace(/</g, '&lt;')}`,
      '',
      `*Consequence:* ${f.consequence.replace(/</g, '&lt;')}`,
      '',
      `*Fix:* ${f.fix.replace(/</g, '&lt;')}`,
      '',
      `<sub>${cell(f.reviewers.join(', '))} · confidence ${f.confidence.toFixed(2)}</sub>`,
      '',
    );
  }
  out.push('### Reviewers', '', '| Reviewer | Status | Findings | Cost |', '|---|---|---|---|');
  const costs = new Map(results.calls.map((c) => [c.role, c.costUsd]));
  for (const r of results.reviewers) {
    out.push(`| ${r.name} | ${r.status}${r.error ? `: ${cell(r.error).slice(0, 80)}` : ''} | ${r.findingCount} | $${(costs.get(`reviewer:${r.name}`) ?? 0).toFixed(3)} |`);
  }
  for (const role of ['selection', 'synthesis']) {
    if (costs.has(role)) out.push(`| ${role} | ran | | $${costs.get(role)!.toFixed(3)} |`);
  }
  return out.join('\n');
}

export interface Annotation {
  path: string;
  start_line: number;
  end_line: number;
  annotation_level: 'notice' | 'warning' | 'failure';
  title: string;
  message: string;
}

export function annotations(results: Results): Annotation[] {
  return results.findings.slice(0, 50).map((f) => ({
    path: f.file,
    start_line: f.line,
    end_line: f.line,
    annotation_level: f.severity === 'nit' ? 'notice' : 'warning',
    title: `${f.id} ${severityLabel[f.severity]}: ${f.title}`.slice(0, 255),
    message: `${f.problem}\n\nConsequence: ${f.consequence}\n\nFix: ${f.fix}`.slice(0, 64_000),
  }));
}

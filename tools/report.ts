// The monthly review report: for each repository that runs the review, the pull requests closed in a month, what became
// of their findings (the outcomes marker the bot adds when a pull request closes) and what their reviews cost (the review
// markers in the bot's summary comments). It opens one issue, "Review report YYYY-MM", in the repository it runs in, or
// updates that month's issue when it already exists, so a re-run never adds a second one.
//
//   node tools/report.ts
//
// Environment: GITHUB_TOKEN (read-only on the reviewed repositories, which are public; issues: write here),
// GITHUB_REPOSITORY (where the issue goes, and whose owner's repositories are scanned), REPORT_MONTH (YYYY-MM; the
// previous month, in UTC, when empty), REPORT_REPOSITORIES (owner/name, separated by commas or spaces, instead of the
// scan) and REPORT_DRY_RUN (1 prints the issue's body instead of publishing it).
//
// Everything read from GitHub, comments and markers included, is data: only the bot's comments and the report author's
// issues are read, every value is checked for its type, and names are escaped before they reach a table.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { errorText, readCommentPages } from '../src/comments.ts';
import type { Provider } from '../src/config.ts';
import { githubApi, type Api } from '../src/github.ts';
import { parseOutcomesMarker, type Outcome } from '../src/outcomes.ts';
import { assertNoSecrets } from '../src/outputs.ts';
import { botLogin, markerJson, reviewRecords, summaryMarker, supersededMarker } from '../src/results.ts';

// The workflow file a repository runs the review from, as the README's caller names it.
export const callerWorkflow = '.github/workflows/code-review.yml';
// Reports are issues with this label, opened by this login: the workflow's GITHUB_TOKEN.
export const reportLabel = 'review-report';
export const reportAuthor = 'github-actions[bot]';
const reportMarkerPattern = /<!-- ncode-review:report (.+?) -->/;

// GitHub's largest page, and the pages read at most, to bound calls: closed pull requests per repository, repositories
// and report issues.
export const pageSize = 100;
export const maxPullPages = 30;
export const maxRepositoryPages = 10;
export const maxIssuePages = 10;

const outcomes = ['fixed', 'dismissed', 'acknowledged', 'ignored'] as const satisfies readonly Outcome[];
const providers = ['anthropic', 'bedrock'] as const satisfies readonly Provider[];
const providerLabel: Record<Provider, string> = { anthropic: 'Claude API', bedrock: 'Amazon Bedrock' };
// A finding whose marker names no reviewer.
export const unattributed = '(unattributed)';

export interface Month {
  // YYYY-MM.
  name: string;
  // The first instant of the month and of the next one, in UTC: a pull request closed at `start` counts, at `end` not.
  start: Date;
  end: Date;
}

function monthName(year: number, month: number): string {
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}`;
}

// The month to report: the one given as YYYY-MM, or the one before `now`'s, in UTC, so the run on the 1st reports the
// month just ended. A month that hasn't started yet is refused; the current month reports what has closed so far.
export function monthWindow(input: string | undefined, now: Date): Month {
  let year: number;
  let month: number;
  const given = input?.trim();
  if (given) {
    const match = /^(\d{4})-(0[1-9]|1[0-2])$/.exec(given);
    if (!match) throw new Error(`The month must be YYYY-MM, such as 2026-10; got ${JSON.stringify(given.slice(0, 40))}.`);
    year = Number(match[1]);
    month = Number(match[2]);
  } else {
    year = now.getUTCFullYear();
    month = now.getUTCMonth();
    if (month === 0) {
      year--;
      month = 12;
    }
  }
  const start = new Date(Date.UTC(year, month - 1, 1));
  const end = new Date(Date.UTC(year, month, 1));
  const name = monthName(year, month);
  if (start.getTime() > now.getTime()) throw new Error(`${name} hasn't started yet.`);
  return { name, start, end };
}

export function previousMonth(name: string): string {
  const [year, month] = name.split('-').map(Number) as [number, number];
  return month === 1 ? monthName(year - 1, 12) : monthName(year, month - 1);
}

export function reportTitle(month: string): string {
  return `Review report ${month}`;
}

// The name can't be `.` or `..`, which would turn a /repos/owner/name/... path into another endpoint.
const repositoryPattern = /^[A-Za-z0-9-]+\/(?!\.\.?$)[A-Za-z0-9._-]+$/;

// A configured list of repositories, as owner/name separated by commas or whitespace; empty when none is configured.
export function parseRepositories(list: string | undefined): string[] {
  const names = (list ?? '').split(/[\s,]+/).filter(Boolean);
  for (const name of names) {
    if (!repositoryPattern.test(name)) throw new Error(`${JSON.stringify(name.slice(0, 100))} isn't a repository's owner/name.`);
  }
  return [...new Set(names)].sort();
}

// The owner's public repositories that run the review: those with the caller workflow. The workflow's GITHUB_TOKEN can't
// list the app's installations, which needs the app's own key, but it reads any public repository.
export async function discoverRepositories(api: Api, owner: string, notes: string[], log: (line: string) => void): Promise<string[]> {
  type Listed = { full_name?: string; fork?: boolean; private?: boolean };
  const candidates: string[] = [];
  for (let page = 1; page <= maxRepositoryPages; page++) {
    const listed = (await api('GET', `/orgs/${encodeURIComponent(owner)}/repos?type=public&per_page=${pageSize}&page=${page}`)) as Listed[];
    for (const repo of listed) {
      if (typeof repo.full_name === 'string' && repositoryPattern.test(repo.full_name) && !repo.fork && !repo.private) candidates.push(repo.full_name);
    }
    if (listed.length < pageSize) break;
    if (page === maxRepositoryPages) notes.push(`Only the first ${maxRepositoryPages * pageSize} of ${owner}'s repositories were checked.`);
  }
  const found: string[] = [];
  for (const repository of candidates) {
    try {
      await api('GET', `/repos/${repository}/contents/${callerWorkflow}`);
      found.push(repository);
    } catch (error) {
      if (/HTTP 404\b/.test((error as Error).message)) continue;
      const note = `Couldn't check whether ${repository} runs the review (${errorText(error)}); it's left out.`;
      notes.push(note);
      log(`::warning::${note}`);
    }
  }
  return found.sort();
}

export interface ListedPull {
  number: number;
  closed_at: string;
}

// The pull requests closed in the month, merged or not. GitHub lists them by last update, newest first, and a pull
// request is updated when it closes, so the listing stops at the first one last updated before the month began.
export async function listClosedPulls(api: Api, repository: string, month: Month, notes: string[]): Promise<ListedPull[]> {
  type Listed = { number?: number; closed_at?: string | null; updated_at?: string };
  const pulls: ListedPull[] = [];
  for (let page = 1; page <= maxPullPages; page++) {
    const listed = (await api('GET', `/repos/${repository}/pulls?state=closed&sort=updated&direction=desc&per_page=${pageSize}&page=${page}`)) as Listed[];
    for (const pull of listed) {
      if (typeof pull.number !== 'number' || typeof pull.closed_at !== 'string') continue;
      const closed = Date.parse(pull.closed_at);
      if (closed >= month.start.getTime() && closed < month.end.getTime()) pulls.push({ number: pull.number, closed_at: pull.closed_at });
    }
    const oldest = listed.at(-1)?.updated_at;
    if (listed.length < pageSize || (oldest !== undefined && Date.parse(oldest) < month.start.getTime())) return pulls;
  }
  notes.push(`${repository} has more closed pull requests updated since ${month.name} began than the ${maxPullPages * pageSize} read; the rest are left out.`);
  return pulls;
}

export interface Review {
  provider: Provider;
  costUsd: number;
}

export interface PullRecord {
  repository: string;
  number: number;
  // The outcome and reviewers of each finding, from the outcomes marker; absent when no outcomes were recorded.
  findings?: { reviewers: string[]; outcome: Outcome }[];
  // Each review the bot ran on it, with what it cost.
  reviews: Review[];
  // Reviews whose cost is unknown: summaries posted before the review marker, collapsed since.
  unknownCost: number;
}

// The cost line of a summary comment posted before summaries had a review marker.
const visibleCost = /^<sub>Trial: findings are posted as review threads and in the check run\. \$(\d+(?:\.\d+)?) on (Claude API|Amazon Bedrock), \d+s, at [0-9a-f]{7}\./m;

function isCost(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

// The reviews one bot comment records.
function commentReviews(body: string): { reviews: Review[]; unknown: number } {
  const reviews = reviewRecords(body).flatMap((record) =>
    providers.includes(record.provider) && isCost(record.costUsd) ? [{ provider: record.provider, costUsd: record.costUsd }] : [],
  );
  if (reviews.length) return { reviews, unknown: 0 };
  if (body.startsWith(summaryMarker)) {
    const line = visibleCost.exec(body);
    if (line) return { reviews: [{ provider: line[2] === 'Claude API' ? 'anthropic' : 'bedrock', costUsd: Number(line[1]) }], unknown: 0 };
    return { reviews: [], unknown: 1 };
  }
  return { reviews: [], unknown: body.startsWith(supersededMarker) ? 1 : 0 };
}

function markerFindings(body: string): PullRecord['findings'] {
  const marker = parseOutcomesMarker(body) as { findings?: unknown } | undefined;
  if (!marker || !Array.isArray(marker.findings)) return undefined;
  return marker.findings.flatMap((finding: unknown) => {
    const { outcome, reviewers } = (finding ?? {}) as { outcome?: unknown; reviewers?: unknown };
    if (!outcomes.includes(outcome as Outcome)) return [];
    const names = Array.isArray(reviewers) ? reviewers.filter((r): r is string => typeof r === 'string' && r.length > 0) : [];
    return [{ reviewers: [...new Set(names)], outcome: outcome as Outcome }];
  });
}

// What the bot recorded on one pull request, from its own comments only, since anyone can write a marker in a comment.
// Undefined when the bot never reviewed it. The newest outcomes marker wins: a pull request reopened, reviewed again and
// closed again has its earlier outcomes kept in the summary it superseded. Every review marker counts, since each one is
// a review that ran.
export async function readPull(api: Api, repository: string, number: number): Promise<PullRecord | undefined> {
  type Listed = { body?: string; user?: { login?: string } };
  let failure = '';
  const comments = await readCommentPages(`/repos/${repository}/issues/${number}/comments`, async (url) => {
    try {
      return (await api('GET', url)) as Listed[];
    } catch (error) {
      failure = errorText(error);
      return undefined;
    }
  });
  if (!comments) throw new Error(failure ? `couldn't read its comments (${failure})` : 'it has more comments than are read');
  let findings: PullRecord['findings'];
  const reviews: Review[] = [];
  let unknownCost = 0;
  let reviewed = false;
  for (const comment of comments) {
    if (comment.user?.login !== botLogin || typeof comment.body !== 'string') continue;
    const body = comment.body;
    const recorded = markerFindings(body);
    if (recorded) findings = recorded;
    const found = commentReviews(body);
    reviews.push(...found.reviews);
    unknownCost += found.unknown;
    reviewed ||= !!recorded || body.startsWith(summaryMarker) || body.startsWith(supersededMarker) || found.reviews.length > 0;
  }
  if (!reviewed) return undefined;
  return { repository, number, ...(findings ? { findings } : {}), reviews, unknownCost };
}

export type Tally = Record<Outcome, number>;

export interface RepositoryTally extends Tally {
  pulls: number;
  withOutcomes: number;
  costUsd: number;
}

export interface Totals extends RepositoryTally {
  // The cost split by provider.
  cost: Record<Provider, number>;
  // The cost of the pull requests with outcomes, which cost per fixed finding divides.
  outcomeCostUsd: number;
  unknownCost: number;
}

// The report's numbers, kept in its issue as a hidden marker for the next month's change.
export interface ReportData {
  version: 1;
  month: string;
  repositories: number;
  totals: Totals;
  reviewers: Record<string, Tally>;
  byRepository: Record<string, RepositoryTally>;
}

function emptyTally(): Tally {
  return { fixed: 0, dismissed: 0, acknowledged: 0, ignored: 0 };
}

function emptyRepository(): RepositoryTally {
  return { ...emptyTally(), pulls: 0, withOutcomes: 0, costUsd: 0 };
}

function roundUsd(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}

export function aggregate(month: string, repositories: string[], pulls: PullRecord[]): ReportData {
  const totals: Totals = { ...emptyRepository(), cost: { anthropic: 0, bedrock: 0 }, outcomeCostUsd: 0, unknownCost: 0 };
  const reviewers = new Map<string, Tally>();
  const byRepository = new Map<string, RepositoryTally>();
  for (const pull of pulls) {
    const repo = byRepository.get(pull.repository) ?? emptyRepository();
    byRepository.set(pull.repository, repo);
    const cost = pull.reviews.reduce((sum, review) => sum + review.costUsd, 0);
    for (const review of pull.reviews) totals.cost[review.provider] += review.costUsd;
    for (const tally of [repo, totals]) {
      tally.pulls++;
      tally.costUsd += cost;
    }
    totals.unknownCost += pull.unknownCost;
    if (!pull.findings) continue;
    repo.withOutcomes++;
    totals.withOutcomes++;
    totals.outcomeCostUsd += cost;
    for (const finding of pull.findings) {
      repo[finding.outcome]++;
      totals[finding.outcome]++;
      // A finding several reviewers raised counts for each of them.
      for (const name of finding.reviewers.length ? finding.reviewers : [unattributed]) {
        const tally = reviewers.get(name) ?? emptyTally();
        reviewers.set(name, tally);
        tally[finding.outcome]++;
      }
    }
  }
  totals.costUsd = roundUsd(totals.costUsd);
  totals.outcomeCostUsd = roundUsd(totals.outcomeCostUsd);
  for (const provider of providers) totals.cost[provider] = roundUsd(totals.cost[provider]);
  for (const repo of byRepository.values()) repo.costUsd = roundUsd(repo.costUsd);
  const sorted = <T>(map: Map<string, T>) => Object.fromEntries([...map].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
  return { version: 1, month, repositories: repositories.length, totals, reviewers: sorted(reviewers), byRepository: sorted(byRepository) };
}

export function findingCount(tally: Tally): number {
  return tally.fixed + tally.dismissed + tally.acknowledged + tally.ignored;
}

// Fixed ÷ (fixed + dismissed); undefined when nothing was either.
export function precision(tally: Tally): number | undefined {
  const judged = tally.fixed + tally.dismissed;
  return judged ? tally.fixed / judged : undefined;
}

export function findingsPerPull(tally: RepositoryTally): number | undefined {
  return tally.withOutcomes ? findingCount(tally) / tally.withOutcomes : undefined;
}

export function costPerFixed(totals: Totals): number | undefined {
  return totals.fixed ? totals.outcomeCostUsd / totals.fixed : undefined;
}

export function reportMarker(data: ReportData): string {
  return `<!-- ncode-review:report ${markerJson(data)} -->`;
}

function count(value: unknown): number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : 0;
}

function readTally(value: unknown): Tally {
  const raw = (value ?? {}) as Record<string, unknown>;
  return { fixed: count(raw['fixed']), dismissed: count(raw['dismissed']), acknowledged: count(raw['acknowledged']), ignored: count(raw['ignored']) };
}

function readRepository(value: unknown): RepositoryTally {
  const raw = (value ?? {}) as Record<string, unknown>;
  return { ...readTally(raw), pulls: count(raw['pulls']), withOutcomes: count(raw['withOutcomes']), costUsd: isCost(raw['costUsd']) ? raw['costUsd'] : 0 };
}

function readMap<T>(value: unknown, read: (entry: unknown) => T): Record<string, T> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, read(entry)]));
}

// A report's numbers from its issue's marker, every value checked; undefined when there's no valid marker.
export function parseReportMarker(body: string): ReportData | undefined {
  const match = reportMarkerPattern.exec(body);
  if (!match) return undefined;
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(match[1]!);
  } catch {
    return undefined;
  }
  if (!raw || raw['version'] !== 1 || typeof raw['month'] !== 'string' || typeof raw['totals'] !== 'object' || !raw['totals']) return undefined;
  const totals = raw['totals'] as Record<string, unknown>;
  const cost = (totals['cost'] ?? {}) as Record<string, unknown>;
  return {
    version: 1,
    month: raw['month'],
    repositories: count(raw['repositories']),
    totals: {
      ...readRepository(totals),
      cost: { anthropic: isCost(cost['anthropic']) ? cost['anthropic'] : 0, bedrock: isCost(cost['bedrock']) ? cost['bedrock'] : 0 },
      outcomeCostUsd: isCost(totals['outcomeCostUsd']) ? totals['outcomeCostUsd'] : 0,
      unknownCost: count(totals['unknownCost']),
    },
    reviewers: readMap(raw['reviewers'], readTally),
    byRepository: readMap(raw['byRepository'], readRepository),
  };
}

function cell(text: string): string {
  return text.replace(/\\/g, '\\\\').replace(/\|/g, '\\|').replace(/[\r\n]+/g, ' ').replace(/</g, '&lt;').replace(/@/g, '@\u200b');
}

const dash = '—';

function usd(value: number | undefined): string {
  return value === undefined ? dash : `$${value.toFixed(2)}`;
}

function percent(value: number | undefined): string {
  return value === undefined ? dash : `${Math.round(value * 100)}%`;
}

function decimal(value: number | undefined): string {
  return value === undefined ? dash : value.toFixed(1);
}

function signed(value: number, text: string): string {
  return value > 0 ? `+${text}` : value < 0 ? `-${text}` : text;
}

type Kind = 'count' | 'usd' | 'percent' | 'decimal';

function format(kind: Kind, value: number | undefined): string {
  if (kind === 'usd') return usd(value);
  if (kind === 'percent') return percent(value);
  if (kind === 'decimal') return decimal(value);
  return value === undefined ? dash : String(value);
}

function change(kind: Kind, current: number | undefined, previous: number | undefined): string {
  if (current === undefined || previous === undefined) return dash;
  if (kind === 'percent') {
    const points = Math.round(current * 100) - Math.round(previous * 100);
    return `${signed(points, String(Math.abs(points)))} pp`;
  }
  const difference = current - previous;
  if (kind === 'usd') return signed(Math.round(difference * 100), usd(Math.abs(difference)));
  if (kind === 'decimal') return signed(Math.round(difference * 10), decimal(Math.abs(difference)));
  return signed(difference, String(Math.abs(difference)));
}

// The issue's body: the marker, the totals with the previous month's and the change, then a table per reviewer and per
// repository, and any notes about what couldn't be read.
export function reportBody(data: ReportData, previous: ReportData | undefined, notes: string[] = []): string {
  const t = data.totals;
  const p = previous?.totals;
  const lines = [
    reportMarker(data),
    `## ${reportTitle(data.month)}`,
    '',
    `Pull requests the bot reviewed that closed in ${data.month} (UTC), merged or not, across ${data.repositories} repositor${data.repositories === 1 ? 'y' : 'ies'}. ` +
      'Precision is fixed ÷ (fixed + dismissed); acknowledged and ignored findings are shown apart and left out of it. ' +
      'Findings come from the outcomes recorded when each pull request closed, and cost from the summary comments of every review it had.',
    '',
    '### Totals',
    '',
    `| | ${data.month} | ${previous ? previous.month : 'Previous month'} | Change |`,
    '|---|---|---|---|',
  ];
  const rows: [string, Kind, (totals: Totals) => number | undefined][] = [
    ['Pull requests reviewed', 'count', (x) => x.pulls],
    ['With outcomes recorded', 'count', (x) => x.withOutcomes],
    ['Findings', 'count', (x) => findingCount(x)],
    ['Findings per pull request', 'decimal', (x) => findingsPerPull(x)],
    ['Fixed', 'count', (x) => x.fixed],
    ['Dismissed', 'count', (x) => x.dismissed],
    ['Acknowledged', 'count', (x) => x.acknowledged],
    ['Ignored', 'count', (x) => x.ignored],
    ['Precision', 'percent', (x) => precision(x)],
    ['Cost', 'usd', (x) => x.costUsd],
    ...providers.map((provider): [string, Kind, (totals: Totals) => number | undefined] => [`Cost on ${providerLabel[provider]}`, 'usd', (x) => x.cost[provider]]),
    ['Cost per fixed finding', 'usd', (x) => costPerFixed(x)],
  ];
  for (const [label, kind, value] of rows) {
    const current = value(t);
    const before = p && value(p);
    lines.push(`| ${label} | ${format(kind, current)} | ${p ? format(kind, before) : dash} | ${change(kind, current, before)} |`);
  }
  lines.push(
    '',
    'Findings per pull request counts the pull requests with outcomes recorded, and cost per fixed finding divides their cost by their fixed findings.',
  );
  if (t.unknownCost) lines.push(`${t.unknownCost} review${t.unknownCost === 1 ? '' : 's'} from before summaries recorded their cost ${t.unknownCost === 1 ? 'is' : 'are'} left out of it.`);

  lines.push('', '### By reviewer', '');
  const reviewers = Object.entries(data.reviewers);
  if (!reviewers.length) lines.push('No findings with outcomes.');
  else {
    lines.push('| Reviewer | Findings | Fixed | Dismissed | Acknowledged | Ignored | Precision | Change |', '|---|---|---|---|---|---|---|---|');
    for (const [name, tally] of reviewers) {
      const before = previous?.reviewers[name];
      lines.push(
        `| ${cell(name)} | ${findingCount(tally)} | ${tally.fixed} | ${tally.dismissed} | ${tally.acknowledged} | ${tally.ignored} | ${percent(precision(tally))} | ${change('percent', precision(tally), before && precision(before))} |`,
      );
    }
  }

  lines.push('', '### By repository', '');
  const repositories = Object.entries(data.byRepository);
  if (!repositories.length) lines.push('No reviewed pull requests closed this month.');
  else {
    lines.push(
      '| Repository | Pull requests | Findings | Findings per pull request | Fixed | Dismissed | Acknowledged | Ignored | Precision | Change | Cost |',
      '|---|---|---|---|---|---|---|---|---|---|---|',
    );
    for (const [name, tally] of repositories) {
      const before = previous?.byRepository[name];
      lines.push(
        `| ${cell(name)} | ${tally.pulls} | ${findingCount(tally)} | ${decimal(findingsPerPull(tally))} | ${tally.fixed} | ${tally.dismissed} | ${tally.acknowledged} | ${tally.ignored} | ${percent(precision(tally))} | ${change('percent', precision(tally), before && precision(before))} | ${usd(tally.costUsd)} |`,
      );
    }
  }

  if (notes.length) {
    lines.push('', '### Notes', '');
    for (const note of notes) lines.push(`- ${cell(note)}`);
  }
  return `${lines.join('\n')}\n`;
}

export interface ReportIssue {
  number: number;
  title: string;
  body: string;
  html_url?: string;
}

// The report issues, by title: only those the report author opened, since anyone can open an issue with that title.
// Where there are two for a month, the older one is kept.
export async function findReports(api: Api, repository: string, author: string): Promise<Map<string, ReportIssue>> {
  type Listed = { number?: number; title?: string; body?: string | null; html_url?: string; user?: { login?: string }; pull_request?: unknown };
  const reports = new Map<string, ReportIssue>();
  for (let page = 1; page <= maxIssuePages; page++) {
    const listed = (await api('GET', `/repos/${repository}/issues?labels=${reportLabel}&state=all&sort=created&direction=asc&per_page=${pageSize}&page=${page}`)) as Listed[];
    for (const issue of listed) {
      if (issue.pull_request || issue.user?.login !== author || typeof issue.number !== 'number' || typeof issue.title !== 'string') continue;
      if (!/^Review report \d{4}-\d{2}$/.test(issue.title) || reports.has(issue.title)) continue;
      reports.set(issue.title, { number: issue.number, title: issue.title, body: issue.body ?? '', ...(issue.html_url ? { html_url: issue.html_url } : {}) });
    }
    if (listed.length < pageSize) break;
  }
  return reports;
}

export interface ReportOptions {
  fetch: typeof fetch;
  token: string;
  // owner/name: where the issue goes; its owner's repositories are scanned unless `repositories` is given.
  repository: string;
  month?: string;
  repositories?: string[];
  now?: Date;
  author?: string;
  dryRun?: boolean;
  log?: (line: string) => void;
}

export interface ReportResult {
  month: string;
  body: string;
  issue?: { number: number; url?: string; action: 'created' | 'updated' | 'unchanged' };
}

export async function runReport(options: ReportOptions): Promise<ReportResult> {
  const log = options.log ?? console.log;
  if (!repositoryPattern.test(options.repository)) throw new Error(`${JSON.stringify(options.repository)} isn't a repository's owner/name.`);
  const month = monthWindow(options.month, options.now ?? new Date());
  const api = githubApi(options.token, options.fetch, { terseErrors: true });
  const notes: string[] = [];

  const repositories = options.repositories?.length
    ? options.repositories
    : await discoverRepositories(api, options.repository.split('/')[0]!, notes, log);
  log(`Reporting ${month.name} for ${repositories.length} repositor${repositories.length === 1 ? 'y' : 'ies'}: ${repositories.join(', ') || 'none'}.`);

  const pulls: PullRecord[] = [];
  for (const repository of repositories) {
    let closed: ListedPull[];
    try {
      closed = await listClosedPulls(api, repository, month, notes);
    } catch (error) {
      const note = `Couldn't list ${repository}'s closed pull requests (${errorText(error)}); it's left out.`;
      notes.push(note);
      log(`::warning::${note}`);
      continue;
    }
    for (const pull of closed.sort((a, b) => a.number - b.number)) {
      try {
        const record = await readPull(api, repository, pull.number);
        if (record) pulls.push(record);
      } catch (error) {
        const note = `${repository}#${pull.number} is left out: ${errorText(error)}.`;
        notes.push(note);
        log(`::warning::${note}`);
      }
    }
  }

  const data = aggregate(month.name, repositories, pulls);
  const author = options.author ?? reportAuthor;
  const reports = await findReports(api, options.repository, author);
  const previous = reports.get(reportTitle(previousMonth(month.name)));
  const previousData = previous && parseReportMarker(previous.body);
  const body = reportBody(data, previousData?.month === previousMonth(month.name) ? previousData : undefined, notes);
  assertNoSecrets(body, [options.token], 'The report');

  if (options.dryRun) return { month: month.name, body };
  const title = reportTitle(month.name);
  const existing = reports.get(title);
  if (existing) {
    if (existing.body === body) {
      log(`${title} (#${existing.number}) is already up to date.`);
      return { month: month.name, body, issue: { number: existing.number, ...(existing.html_url ? { url: existing.html_url } : {}), action: 'unchanged' } };
    }
    const updated = (await api('PATCH', `/repos/${options.repository}/issues/${existing.number}`, { body })) as { html_url?: string };
    log(`Updated ${title}: ${updated?.html_url ?? `#${existing.number}`}`);
    return { month: month.name, body, issue: { number: existing.number, ...(updated?.html_url ? { url: updated.html_url } : {}), action: 'updated' } };
  }
  const created = (await api('POST', `/repos/${options.repository}/issues`, { title, body, labels: [reportLabel] })) as { number: number; html_url?: string };
  log(`Opened ${title}: ${created.html_url ?? `#${created.number}`}`);
  return { month: month.name, body, issue: { number: created.number, ...(created.html_url ? { url: created.html_url } : {}), action: 'created' } };
}

// Not `import.meta.main`: it needs Node 24.2, and on an older 24.x the script would exit 0 without a report.
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const env = process.env;
  try {
    const token = env['GITHUB_TOKEN'];
    const repository = env['GITHUB_REPOSITORY'];
    if (!token || !repository) throw new Error('GITHUB_TOKEN and GITHUB_REPOSITORY must be set.');
    const result = await runReport({
      fetch,
      token,
      repository,
      ...(env['REPORT_MONTH'] ? { month: env['REPORT_MONTH'] } : {}),
      repositories: parseRepositories(env['REPORT_REPOSITORIES']),
      dryRun: env['REPORT_DRY_RUN'] === '1',
    });
    if (!result.issue) process.stdout.write(result.body);
  } catch (error) {
    console.error(`::error::${errorText(error)}`);
    process.exitCode = 1;
  }
}

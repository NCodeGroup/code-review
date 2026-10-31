// `/review teach`: turns a writer's correction into a `review-guidance` issue, in this repository for a project rule or
// in NCodeGroup/code-review for an NCodeGroup-wide one. The review step words the issue, with no model call; the
// publish step opens it with an app token that can write issues, after everything else, and replies on the pull
// request. Nothing in the job writes code: `/run-issues` or a person turns the issue into a pull request.

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { maxRuleChars, type Command, type FindingRef } from './command.ts';
import { findFinding, type Answer, type GitHubApi, type Resolution } from './explain.ts';
import { GitHubError, type ReadApi } from './github.ts';
import { neutralizeMentions, plainText } from './markdown.ts';
import { assertNoSecrets } from './outputs.ts';

export { GitHubError };

export const guidanceLabel = 'review-guidance';
export const orgGuidanceRepository = 'NCodeGroup/code-review';
export const teachingFile = 'teach.json';

// What the review step hands the publish step: the issue to open and where to reply.
export interface Teaching {
  // Where the command was: the reply goes on this pull request.
  repository: string;
  pullRequest: number;
  // The repository the issue opens in.
  target: string;
  scope: 'repository' | 'org';
  rule: string;
  title: string;
  body: string;
}

// The finding a `teach F<n>` rule comes from, as the review step read it.
export interface TaughtFinding {
  id: string;
  path?: string | undefined;
  line?: number | null | undefined;
  url?: string | undefined;
  text: string;
}

// Quotes text as data in a fenced block whose fence is longer than any run of backticks in it, so nothing in it can
// close the block early or render as markdown.
export function fenced(text: string): string {
  const longest = Math.max(0, ...[...text.matchAll(/`+/g)].map((m) => m[0].length));
  const fence = '`'.repeat(Math.max(3, longest + 1));
  return `${fence}text\n${neutralizeMentions(text)}\n${fence}`;
}

const maxTitleRuleChars = 72;
const maxFindingChars = 4_000;

export function issueTitle(rule: string): string {
  const line = rule.split(/\r?\n/).find((l) => l.trim())?.trim() ?? '';
  const short = line.length > maxTitleRuleChars ? `${line.slice(0, maxTitleRuleChars - 1).trimEnd()}…` : line;
  return `Review guidance: ${neutralizeMentions(short)}`;
}

// The marker the training reader looks for: who made the issue and what scope its rule has.
export function guidanceMarker(scope: Teaching['scope']): string {
  return `<!-- ncode-review:guidance scope=${scope} -->`;
}

export interface TeachContext {
  repository: string;
  number: number;
  host: string;
  commentUrl?: string | undefined;
  author?: string | undefined;
  // A private repository's name and link stay out of an issue in another repository, which may be public.
  isPrivate: boolean;
}

// Where a rule was taught, as the issue's body names it.
export type IssueSource = Omit<TeachContext, 'number' | 'host'> & { pullRequest: number };

// The issue's body: the rule quoted as data, where it was taught, the finding it comes from, and what to do with it.
export function issueBody(scope: Teaching['scope'], rule: string, source: IssueSource, finding?: TaughtFinding): string {
  const who = source.author ? `\`${plainText(source.author)}\`` : 'A writer';
  const hidden = scope === 'org' && source.isPrivate;
  const where = hidden
    ? 'in a private repository'
    : `on ${source.commentUrl ? `[${source.repository}#${source.pullRequest}](${source.commentUrl})` : `${source.repository}#${source.pullRequest}`}`;
  const parts = [guidanceMarker(scope), `${who} taught this ${scope === 'org' ? 'NCodeGroup-wide' : 'project'} review rule with \`/review teach\` ${where}.`, '### Rule', fenced(rule)];
  if (finding && !hidden) {
    const line = finding.line ? `:${finding.line}` : '';
    const at = `\`${plainText(finding.path ?? '(no file)')}${line}\``;
    parts.push(`### From finding ${finding.id}`, `${finding.url ? `[${at}](${finding.url})` : at}, as NCode Review posted it:`, fenced(finding.text.slice(0, maxFindingChars)));
  }
  parts.push(
    '### To do',
    scope === 'org'
      ? 'Close this issue as completed to accept the rule: `npm run train` copies the rules of closed `review-guidance` issues in NCodeGroup/code-review into `training/feedback.md`, which every generalization of `guidance/` follows. Close it as not planned to drop it.'
      : "Add the rule to this repository's `.github/code-review/guidance.md` in a pull request, then close this issue. Close it as not planned to drop it.",
  );
  return parts.join('\n\n');
}

// The text of a finding comment without the bot's hidden markers.
export function findingText(body: string | undefined): string {
  return (body ?? '').replace(/<!--[\s\S]*?-->/g, '').trim();
}

export function usageBody(): string {
  return 'Say what to teach: `/review teach <rule>` for a rule in this repository, `/review teach F3 <rule>` for one that comes from a finding, or `/review teach org <rule>` for one in every NCodeGroup repository.';
}

export function tooLongBody(length: number): string {
  return `That rule is ${length.toLocaleString('en-US')} characters long; teach one of at most ${maxRuleChars.toLocaleString('en-US')} characters.`;
}

export function teachUnknownRefBody(ref: FindingRef, validIds: string[]): string {
  const asked = ref.kind === 'id' ? `There's no ${ref.id} in the newest review.` : "That link isn't to one of NCode Review's finding comments on this pull request.";
  const valid = validIds.length ? `The newest review's findings are ${validIds.join(', ')}.` : 'This pull request has no findings posted as inline comments yet.';
  return `${asked} ${valid} To teach from a finding of an earlier review, use its comment's link: \`/review teach <link> <rule>\`.`;
}

export type TeachPlan = { answer: Answer } | { teaching: Teaching };

// What a `/review teach` comment leads to: a reply saying what's wrong with it, or the issue to open. A finding ref is
// looked up with the read-only reader; an unknown one gets the newest review's ids.
export async function planTeaching(command: Extract<Command, { kind: 'teach' }>, context: TeachContext, read: ReadApi): Promise<TeachPlan> {
  const reply = (body: string): TeachPlan => ({ answer: { repository: context.repository, pullRequest: context.number, body } });
  if (!command.rule) return reply(usageBody());
  if (command.rule.length > maxRuleChars) return reply(tooLongBody(command.rule.length));
  let finding: TaughtFinding | undefined;
  if (command.ref) {
    const resolution: Resolution = await findFinding(command.ref, context, read);
    if ('validIds' in resolution) return reply(teachUnknownRefBody(command.ref, resolution.validIds));
    const c = resolution.found.comment;
    finding = { id: resolution.found.id, path: c.path, line: c.line ?? c.original_line, url: c.html_url, text: findingText(c.body) };
  }
  const { number, host, ...where } = context;
  const source: IssueSource = { ...where, pullRequest: number };
  return {
    teaching: {
      repository: context.repository,
      pullRequest: context.number,
      target: command.scope === 'org' ? orgGuidanceRepository : context.repository,
      scope: command.scope,
      rule: command.rule,
      title: issueTitle(command.rule),
      body: issueBody(command.scope, command.rule, source, finding),
    },
  };
}

export type IssueOutcome = { issue: { number: number; url: string } } | { refused: 'permission' | 'disabled' };

// Creates the label when the target repository doesn't have it yet. A 422 from the create means another teach run made
// it in between, which is as good.
async function ensureLabel(api: GitHubApi, target: string): Promise<void> {
  try {
    await api('GET', `/repos/${target}/labels/${guidanceLabel}`);
  } catch (error) {
    if (!(error instanceof GitHubError) || error.status !== 404) throw error;
    try {
      await api('POST', `/repos/${target}/labels`, { name: guidanceLabel, color: '0e8a16', description: 'A rule taught with /review teach, to add to the review guidance' });
    } catch (createError) {
      if (!(createError instanceof GitHubError) || createError.status !== 422) throw createError;
    }
  }
}

// Opens the issue with the issues token. A 403 or 404 means the app can't write issues there; a 410 means the
// repository has issues turned off. Any other refusal fails the step.
export async function openGuidanceIssue(api: GitHubApi, teaching: Teaching): Promise<IssueOutcome> {
  try {
    await ensureLabel(api, teaching.target);
    const issue = (await api('POST', `/repos/${teaching.target}/issues`, { title: teaching.title, body: teaching.body, labels: [guidanceLabel] })) as { number: number; html_url: string };
    return { issue: { number: issue.number, url: issue.html_url } };
  } catch (error) {
    if (error instanceof GitHubError && (error.status === 403 || error.status === 404)) return { refused: 'permission' };
    if (error instanceof GitHubError && error.status === 410) return { refused: 'disabled' };
    throw error;
  }
}

export function replyBody(teaching: Teaching, outcome: IssueOutcome): string {
  if ('issue' in outcome) {
    const kind = teaching.scope === 'org' ? 'an NCodeGroup-wide review rule' : 'a review rule for this repository';
    return `Opened [${teaching.target}#${outcome.issue.number}](${outcome.issue.url}) to make this ${kind}.`;
  }
  const why =
    outcome.refused === 'disabled'
      ? `issues are turned off in ${teaching.target}`
      : `the NCode Review app can't write issues in ${teaching.target}. A maintainer needs to give the app the Issues: Read and write permission${teaching.scope === 'org' ? ` and install it on ${orgGuidanceRepository}` : ''}`;
  return `I couldn't open a \`${guidanceLabel}\` issue: ${why}. The rule, to add by hand meanwhile:\n\n${fenced(teaching.rule)}`;
}

// Opens the issue, when there's an issues token, and replies on the pull request with the app's token. Both texts are
// scanned for secrets first. Without an issues token, which happens when the app can't get issues write there, the
// reply says so.
export async function postTeaching(api: GitHubApi, issuesApi: GitHubApi | undefined, teaching: Teaching, secrets: string[]): Promise<string> {
  assertNoSecrets(`${teaching.title}\n${teaching.body}`, secrets, 'The guidance issue');
  const outcome: IssueOutcome = issuesApi ? await openGuidanceIssue(issuesApi, teaching) : { refused: 'permission' };
  const body = replyBody(teaching, outcome);
  assertNoSecrets(body, secrets, 'The reply');
  const comment = (await api('POST', `/repos/${teaching.repository}/issues/${teaching.pullRequest}/comments`, { body })) as { html_url: string };
  return comment.html_url;
}

// The publish step's teach branch: returns the reply's URL, or undefined, without a call, when the run wasn't a teach.
export async function publishTeaching(outDir: string, api: GitHubApi, issuesApi: GitHubApi | undefined, secrets: string[]): Promise<string | undefined> {
  const file = path.join(outDir, teachingFile);
  if (!existsSync(file)) return undefined;
  return postTeaching(api, issuesApi, JSON.parse(readFileSync(file, 'utf8')) as Teaching, secrets);
}

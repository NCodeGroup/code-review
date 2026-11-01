// `/review explain <ref>`: finds the finding a comment asks about, has one agent read the code again, and words the
// answer the publish step posts as a top-level comment on the pull request.

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { runAgent, type AgentResult, type AgentRun } from './agent.ts';
import type { FindingRef } from './command.ts';
import { errorText, readCommentPages } from './comments.ts';
import { budgets, maxTurns } from './config.ts';
import type { ReadApi } from './github.ts';
import { neutralizeProse, plainText } from './markdown.ts';
import { assertNoSecrets, writeForPublish } from './outputs.ts';
import { botLogin } from './results.ts';
import { markerFields } from './threads.ts';

// An inline review comment as GitHub's API returns it. `line` is null once the code it was on has changed.
export interface ReviewComment {
  id: number;
  body?: string;
  path?: string;
  line?: number | null;
  original_line?: number | null;
  original_commit_id?: string;
  html_url?: string;
  pull_request_url?: string;
  pull_request_review_id?: number | null;
  user?: { login?: string };
}

export interface FoundFinding {
  id: string;
  comment: ReviewComment;
}

export type Resolution = { found: FoundFinding } | { validIds: string[] };

// What the review step hands the publish step instead of results.json: one top-level comment to post.
export interface Answer {
  repository: string;
  pullRequest: number;
  body: string;
}

export const answerFile = 'answer.json';

function findingId(comment: ReviewComment): string | undefined {
  if (comment.user?.login !== botLogin) return undefined;
  const id = markerFields(comment.body)?.get('id');
  return id && /^F\d+$/.test(id) ? id : undefined;
}

// The newest review's findings, in id order: the bot's inline finding comments, newest first, that belong to the same
// review as the newest one. Ids restart at F1 in every review, so an id means the newest review's finding.
export function newestReviewFindings(comments: ReviewComment[]): FoundFinding[] {
  const findings = comments
    .flatMap((comment) => {
      const id = findingId(comment);
      return id ? [{ id, comment }] : [];
    })
    .sort((a, b) => b.comment.id - a.comment.id);
  const review = findings[0]?.comment.pull_request_review_id;
  return findings.filter((f) => f.comment.pull_request_review_id === review).sort((a, b) => Number(a.id.slice(1)) - Number(b.id.slice(1)));
}

// Finds the finding a ref names on this pull request, reading the comments with the read-only token. A link must be to
// one of the bot's finding comments on this pull request, from any review; anything else gets the newest review's ids.
export async function findFinding(ref: FindingRef, where: { repository: string; number: number; host: string }, read: ReadApi): Promise<Resolution> {
  if (ref.kind === 'url' && ref.host === where.host.toLowerCase() && ref.repository.toLowerCase() === where.repository.toLowerCase() && ref.number === where.number) {
    const comment = (await read(`/repos/${where.repository}/pulls/comments/${ref.commentId}`)) as ReviewComment | undefined;
    const id = comment && comment.id === ref.commentId ? findingId(comment) : undefined;
    const onThis = comment?.pull_request_url?.toLowerCase().endsWith(`/repos/${where.repository.toLowerCase()}/pulls/${where.number}`);
    if (comment && id && onThis) return { found: { id, comment } };
  }
  const all = await readCommentPages(`/repos/${where.repository}/pulls/${where.number}/comments`, (url) => read(url) as Promise<ReviewComment[] | undefined>);
  if (!all) throw new Error(`Couldn't list the review comments on #${where.number}.`);
  const newest = newestReviewFindings(all);
  const found = ref.kind === 'id' ? newest.find((f) => f.id === ref.id) : undefined;
  return found ? { found } : { validIds: newest.map((f) => f.id) };
}

// Wraps text from a comment as data, so a closing tag inside it can't end the block early.
export function dataBlock(tag: string, text: string): string {
  return `<${tag}>\n${text.replace(new RegExp(`<(/?${tag})\\b`, 'gi'), '&lt;$1')}\n</${tag}>`;
}

// What one explain call is asked: the finding, the question about it, which may be empty, and the commit to read.
export interface ExplainRequest {
  found: FoundFinding;
  question: string;
  headSha: string;
}

export function explainPrompt({ found, question, headSha }: ExplainRequest, checkout: string): string {
  const c = found.comment;
  const line = c.line ?? c.original_line;
  const moved = c.line == null ? ' The code there has changed since, so find where it is now.' : '';
  return [
    `Finding ${found.id}, posted on ${c.path ?? '(no file)'}${line ? ` line ${line}` : ''}${c.original_commit_id ? ` at commit ${c.original_commit_id.slice(0, 7)}` : ''}.${moved}`,
    dataBlock('finding', c.body ?? ''),
    question ? `The question asked about it:\n${dataBlock('question', question)}` : 'No question was asked: say whether the finding holds, and why.',
    `The pull request's latest commit, ${headSha.slice(0, 7)}, is checked out at: ${checkout}`,
  ].join('\n\n');
}

export interface Explanation {
  answer: string;
  holds: boolean;
  reason: string;
}

const explanationSchema = {
  type: 'object',
  properties: { answer: { type: 'string' }, holds: { type: 'boolean' }, reason: { type: 'string' } },
  required: ['answer', 'holds', 'reason'],
  additionalProperties: false,
};

// One Sonnet call with Read, Grep and Glob confined to the checkout, under the same lockdown as the reviewers. Tests
// pass their own agent.
export function explainFinding(
  run: AgentRun & { checkout: string },
  systemPrompt: string,
  request: ExplainRequest,
  agent: typeof runAgent<Explanation> = runAgent,
): Promise<AgentResult<Explanation>> {
  return agent(run, {
    role: 'explain',
    tier: 'sonnet',
    systemPrompt,
    prompt: explainPrompt(request, run.checkout),
    schema: explanationSchema,
    maxTurns: maxTurns.explain,
    budgetUsd: budgets.explain,
  });
}

const maxAnswerChars = 6_000;

function text(value: string, max = maxAnswerChars): string {
  return value.trim().slice(0, max).replace(/</g, '&lt;');
}

function reference(found: FoundFinding): string {
  const c = found.comment;
  const line = c.line ?? c.original_line;
  const where = `${plainText(c.path ?? '')}${line ? `:${line}` : ''}`;
  return `Re ${found.id} (${c.html_url ? `[\`${where}\`](${c.html_url})` : `\`${where}\``})`;
}

export function answerBody(found: FoundFinding, explanation: Explanation): string {
  const reason = neutralizeProse(text(explanation.reason).replace(/^because\b[\s,:]*/i, ''));
  const verdict = explanation.holds ? `Still holds because ${reason}` : `On reflection this doesn't hold: ${reason}`;
  return `${reference(found)}: ${neutralizeProse(text(explanation.answer))}\n\n${verdict}`;
}

export function failedBody(found: FoundFinding, error: string): string {
  return `${reference(found)}: I couldn't finish looking into this (${text(errorText(error))}). Comment the command again to retry.`;
}

// How much of an unrecognized ref the reply repeats back.
const maxEchoedRefChars = 100;

export function unknownRefBody(ref: FindingRef, validIds: string[]): string {
  const asked =
    ref.kind === 'id'
      ? `There's no ${ref.id} in the newest review.`
      : ref.kind === 'url'
        ? "That link isn't to one of NCode Review's finding comments on this pull request."
        : ref.text
          ? `\`${text(ref.text.replace(/[`\r\n]/g, ''), maxEchoedRefChars)}\` isn't a finding id or a link to a finding comment.`
          : 'Name the finding to explain, such as `/review explain F1`.';
  const valid = validIds.length ? `The newest review's findings are ${validIds.join(', ')}.` : 'This pull request has no findings posted as inline comments yet.';
  return `${asked} ${valid} To ask about a finding from an earlier review, use its comment's link: \`/review explain <link> <question>\`.`;
}

export interface Explained {
  found: FoundFinding;
  result: AgentResult<Explanation>;
}

// The comment a `/review explain` run posts, and the call behind it when there was one. An unknown ref gets the newest
// review's ids without asking the agent; a call that fails gets a comment saying so.
export async function answerFor(
  ref: FindingRef,
  resolution: Resolution,
  ask: (found: FoundFinding) => Promise<AgentResult<Explanation>>,
): Promise<{ body: string; explained?: Explained }> {
  if ('validIds' in resolution) return { body: unknownRefBody(ref, resolution.validIds) };
  const { found } = resolution;
  const result = await ask(found);
  const body = result.output ? answerBody(found, result.output) : failedBody(found, result.error ?? 'no answer');
  return { body, explained: { found, result } };
}

// What a `/review explain` run leaves for the publish step: answer.json, plus trace.json when the agent was asked. An
// unknown ref writes only the answer, without asking. It never writes results.json, so the publish step posts no review.
export async function writeAnswer(
  outDir: string,
  where: { repository: string; number: number; question: string; secrets: string[] },
  ref: FindingRef,
  resolution: Resolution,
  ask: (found: FoundFinding) => Promise<AgentResult<Explanation>>,
): Promise<void> {
  const { body, explained } = await answerFor(ref, resolution, ask);
  const files: Record<string, unknown> = { [answerFile]: { repository: where.repository, pullRequest: where.number, body } satisfies Answer };
  if (explained) {
    const { found, result } = explained;
    files['trace.json'] = { explain: { id: found.id, comment: found.comment.html_url ?? found.comment.id, question: where.question, output: result.output, calls: result.records } };
  }
  writeForPublish(outDir, files, where.secrets, 'answered');
}

export type GitHubApi = (method: string, url: string, body?: unknown) => Promise<any>;

// Posts the answer as a top-level comment, with the app's token, after the agent has exited. It is scanned for secrets
// first, and nothing is posted when it holds one.
export async function postAnswer(api: GitHubApi, answer: Answer, secrets: string[]): Promise<string> {
  assertNoSecrets(answer.body, secrets, 'The answer');
  const comment = (await api('POST', `/repos/${answer.repository}/issues/${answer.pullRequest}/comments`, { body: answer.body })) as { html_url: string };
  return comment.html_url;
}

// The publish step's explain branch: posts the answer the review step left in outDir and returns the comment's URL, or
// returns undefined, without a call, when there's none because the run was a review.
export async function publishAnswer(outDir: string, api: GitHubApi, secrets: string[]): Promise<string | undefined> {
  const answerPath = path.join(outDir, answerFile);
  if (!existsSync(answerPath)) return undefined;
  const answer = JSON.parse(readFileSync(answerPath, 'utf8')) as Answer;
  return postAnswer(api, answer, secrets);
}

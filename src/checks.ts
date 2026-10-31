// The "Code review" check run through a run's life: created in progress by the acknowledgement, within seconds of the
// event, then completed by the publish step with the review, or by the finish step with why there's no review. Nothing
// here imports an npm package: the acknowledgement runs it with the runner's own node, before npm ci.

import { errorText } from './comments.ts';
import type { Api } from './github.ts';
import { NoProviderError } from './provider.ts';

export const checkName = 'Code review';

export type Conclusion = 'neutral' | 'failure' | 'cancelled';

// How a run that posted no review ends its check run. The review step writes it to status.json when it stops early;
// headSha is there once the run has decided to review, so a failure can be shown even without an acknowledgement.
export interface RunStatus {
  conclusion: Conclusion;
  title: string;
  summary: string;
  headSha?: string;
}

// The check run the acknowledgement created, which the publish or finish step completes.
export interface Acknowledged {
  id: number;
  headSha: string;
}

const short = (sha: string) => sha.slice(0, 7);
const logLine = (url: string | undefined) => (url ? ` [The run's log](${url}) says why.` : " The run's log says why.");

export function isSha(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{40}$/.test(value);
}

// The check run id and head the acknowledgement passed on through its step outputs, when both are well formed.
export function acknowledgedFrom(id: string | undefined, headSha: string | undefined): Acknowledged | undefined {
  const number = Number(id);
  return id && /^\d+$/.test(id) && Number.isSafeInteger(number) && isSha(headSha) ? { id: number, headSha } : undefined;
}

// The decide step's outputs for a run that will review, which the acknowledgement reads: only a commit SHA and a
// comment id, each checked for shape, so nothing from the event can add a line of its own. None when the head is
// missing or malformed.
export function decisionOutputs(decision: { pullRequest: { head?: { sha?: string } }; commentId?: number }): string | undefined {
  const headSha = decision.pullRequest.head?.sha;
  if (!isSha(headSha)) return undefined;
  const lines = ['acknowledge=true', `head-sha=${headSha}`];
  if (Number.isSafeInteger(decision.commentId) && (decision.commentId ?? 0) > 0) lines.push(`comment-id=${decision.commentId}`);
  return `${lines.join('\n')}\n`;
}

export function inProgressCheck(headSha: string, detailsUrl?: string) {
  return {
    name: checkName,
    head_sha: headSha,
    status: 'in_progress',
    started_at: new Date().toISOString(),
    ...(detailsUrl ? { details_url: detailsUrl } : {}),
    output: { title: 'Review in progress', summary: `Review started at ${short(headSha)}; it usually takes a few minutes.` },
  };
}

export function budgetStatus(reason: string): RunStatus {
  return {
    conclusion: 'neutral',
    title: 'Review budget used up',
    summary: [
      `No review ran: ${reason}.`,
      'Nothing was charged. The review is advice and nothing requires it, so the autopilot can carry on without it; comment `/review` once the budget is back.',
    ].join('\n\n'),
  };
}

// The status for an error that stopped the review step: a used-up budget, or a failure with the error's text.
export function failureStatus(error: unknown, url?: string): RunStatus {
  if (error instanceof NoProviderError) return budgetStatus(error.reason);
  return { conclusion: 'failure', title: 'Review failed', summary: `The review failed: ${errorText(error).replace(/\.$/, '')}.${logLine(url)}` };
}

export function skippedStatus(reason: string): RunStatus {
  return { conclusion: 'neutral', title: 'Review skipped', summary: reason };
}

// Reads status.json as data: an unknown conclusion reads as a failure, and anything that isn't text is left out.
export function parseStatus(json: string): RunStatus | undefined {
  let value: Partial<Record<keyof RunStatus, unknown>>;
  try {
    value = JSON.parse(json);
  } catch {
    return undefined;
  }
  if (!value || typeof value !== 'object' || typeof value.title !== 'string' || typeof value.summary !== 'string') return undefined;
  const conclusion = (['neutral', 'failure', 'cancelled'] as const).find((c) => c === value.conclusion) ?? 'failure';
  return { conclusion, title: value.title, summary: value.summary, ...(isSha(value.headSha) ? { headSha: value.headSha } : {}) };
}

// The status when the review step left none: the run was cancelled, it stopped before the review step finished, or the
// review finished and its results couldn't be posted. `outcomes` are the step outcomes of setup-node, npm ci, the
// review and the publish step, empty for a step that didn't run.
export function stoppedStatus(outcomes: { review?: string; publish?: string; others?: string[] }, url?: string): RunStatus {
  const all = [...(outcomes.others ?? []), outcomes.review, outcomes.publish];
  if (all.includes('cancelled')) {
    return {
      conclusion: 'cancelled',
      title: 'Review cancelled',
      summary: 'The run was cancelled before the review was posted, usually because a newer run for this pull request started.',
    };
  }
  const summary = outcomes.review === 'success' ? "The review finished, but its results couldn't be posted." : 'The run stopped before the review finished.';
  return { conclusion: 'failure', title: 'Review failed', summary: `${summary}${logLine(url)}` };
}

// The acknowledgement: 👀 on the /review comment, then the "Code review" check run in progress. A refused reaction only
// warns, since the check run is the sign that matters. Returns the check run's id.
export async function acknowledge(
  api: Api,
  target: { repository: string; headSha: string; commentId?: number; detailsUrl?: string },
  log: (line: string) => void = console.log,
): Promise<number> {
  if (target.commentId !== undefined) {
    try {
      await api('POST', `/repos/${target.repository}/issues/comments/${target.commentId}/reactions`, { content: 'eyes' });
    } catch (error) {
      log(`::warning::Couldn't react to the /review comment (${errorText(error)}).`);
    }
  }
  const created = (await api('POST', `/repos/${target.repository}/check-runs`, inProgressCheck(target.headSha, target.detailsUrl))) as { id: number; html_url?: string };
  log(`Acknowledged with ${created.html_url ?? `check run ${created.id}`}`);
  return created.id;
}

function completion(conclusion: Conclusion, output: object) {
  return { name: checkName, status: 'completed', conclusion, completed_at: new Date().toISOString(), output };
}

// Posts the review's check run: the acknowledged one, updated, when it is on the reviewed commit, so there's never a
// second. When the pull request moved between the acknowledgement and the review, the review gets its own check run
// on the commit it reviewed, and the acknowledged one says where the review went.
export async function publishCheck(
  api: Api,
  repository: string,
  check: { head_sha: string; conclusion: Conclusion; output: object },
  acknowledged: Acknowledged | undefined,
): Promise<{ html_url: string }> {
  if (acknowledged?.headSha === check.head_sha) {
    return (await api('PATCH', `/repos/${repository}/check-runs/${acknowledged.id}`, completion(check.conclusion, check.output))) as { html_url: string };
  }
  const created = (await api('POST', `/repos/${repository}/check-runs`, { ...completion(check.conclusion, check.output), head_sha: check.head_sha })) as { html_url: string };
  if (acknowledged) {
    await api('PATCH', `/repos/${repository}/check-runs/${acknowledged.id}`, completion('neutral', {
      title: `Reviewed ${short(check.head_sha)} instead`,
      summary: `The pull request moved to ${short(check.head_sha)} before the review began; [its check run](${created.html_url}) has the review.`,
    }));
  }
  return created;
}

// Completes the check run for a run that posted no review, with why: the acknowledged one when there is one, otherwise
// a new one on the commit the run decided to review. Returns false when there's neither.
export async function finishCheck(api: Api, repository: string, acknowledged: Acknowledged | undefined, status: RunStatus): Promise<boolean> {
  const done = completion(status.conclusion, { title: status.title, summary: status.summary });
  if (acknowledged) {
    await api('PATCH', `/repos/${repository}/check-runs/${acknowledged.id}`, done);
    return true;
  }
  if (!status.headSha) return false;
  await api('POST', `/repos/${repository}/check-runs`, { ...done, head_sha: status.headSha });
  return true;
}

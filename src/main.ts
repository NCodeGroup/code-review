// The review step: gather, choose a provider, review, and write results.json and trace.json for the publish step, or
// status.json with why there's no review, for the finish step. It holds the model credentials but never the app's
// private key or a token minted from it: those reach only the steps that write to the pull request.

import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { failureStatus, skippedStatus, type RunStatus } from './checks.ts';
import { decideReview } from './command.ts';
import { lastReviewedHead } from './comments.ts';
import { AnthropicTokenSource, secretValues, type Credentials } from './credentials.ts';
import { fetchHeadFor, fetchPullRequestHead } from './fetch-head.ts';
import { closedIssues, gather, maxIssueChars, readPullRequest } from './gather.ts';
import { fetchPullRequest, runUrl } from './github.ts';
import { assertNoSecrets } from './outputs.ts';
import { chooseProvider, NoProviderError } from './provider.ts';
import { startProxy } from './proxy.ts';
import { changedLines, loadCharters, review } from './review.ts';
import { topSeverity, type Results } from './results.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// What the finish step needs when the review stops early: the commit, once the run has decided to review one, and the
// secrets to keep out of the reason.
const run: { headSha?: string | undefined; credentials: Credentials; githubToken?: string } = { credentials: {} };

// Writes status.json for the finish step, and, once the run has decided to review a commit, tells the action's later
// steps there's a check run to complete even without an acknowledgement.
function writeStatus(status: RunStatus): void {
  const outDir = process.env['CODE_REVIEW_OUT'];
  if (!outDir) return;
  const secrets = [...secretValues(run.credentials), ...(run.githubToken ? [run.githubToken] : [])];
  let safe = { ...status, ...(run.headSha ? { headSha: run.headSha } : {}) };
  try {
    assertNoSecrets(JSON.stringify(safe), secrets, 'The reason');
  } catch {
    safe = { ...safe, summary: "The review stopped, and its reason can't be shown here; the run's log says why." };
  }
  mkdirSync(outDir, { recursive: true });
  writeFileSync(path.join(outDir, 'status.json'), JSON.stringify(safe, null, 2));
  const output = process.env['GITHUB_OUTPUT'];
  if (output && run.headSha) appendFileSync(output, 'stopped=true\n');
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} isn't set.`);
  return value;
}

// Reads a variable and removes it from this process's environment, so nothing started later inherits it.
function take(name: string): string | undefined {
  const value = process.env[name];
  delete process.env[name];
  return value || undefined;
}

// The added lines of each file a finding is in, so the publish step can tell which findings can be inline comments.
function changedLinesFor(diff: string, files: string[]): Record<string, number[]> {
  const all = changedLines(diff);
  return Object.fromEntries([...new Set(files)].map((file) => [file, [...(all.get(file) ?? [])]]));
}

// The issues a pull request closes, as context for intent. An issue whose author lacks write access is left out: its
// text could steer the review.
async function readClosedIssues(repository: string, numbers: number[], token: string | undefined) {
  const issues: { number: number; title: string; body: string }[] = [];
  for (const number of numbers) {
    const response = await fetch(`https://api.github.com/repos/${repository}/issues/${number}`, {
      headers: { accept: 'application/vnd.github+json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    });
    if (!response.ok) continue;
    const issue = (await response.json()) as { title?: string; body?: string; author_association?: string; pull_request?: unknown };
    if (issue.pull_request || !['OWNER', 'MEMBER', 'COLLABORATOR'].includes(issue.author_association ?? '')) continue;
    issues.push({ number, title: issue.title ?? '', body: (issue.body ?? '').slice(0, maxIssueChars) });
  }
  return issues;
}

async function main(): Promise<void> {
  const outDir = required('CODE_REVIEW_OUT');
  const prPath = path.resolve(required('CODE_REVIEW_PR_PATH'));
  const basePath = path.resolve(required('CODE_REVIEW_BASE_PATH'));
  const repository = required('GITHUB_REPOSITORY');
  let event = JSON.parse(readFileSync(required('GITHUB_EVENT_PATH'), 'utf8'));
  const githubToken = take('CODE_REVIEW_GITHUB_TOKEN');
  if (githubToken) run.githubToken = githubToken;

  // A /review comment carries the issue, not the pull request, so the decision reads the pull request from the API.
  // An automatic run on a commit already reviewed, such as marking a draft ready without pushing, would pay again for
  // the same review; /review still reviews it.
  const decision = await decideReview(
    event,
    repository,
    (number) => fetchPullRequest(repository, number, githubToken),
    (number) => lastReviewedHead(repository, number, githubToken),
  );
  if (!decision.review) {
    console.log(decision.reason);
    writeStatus(skippedStatus(decision.reason));
    return;
  }
  if (event.comment) event = { pull_request: decision.pullRequest };

  const credentials = run.credentials;
  const bedrockKey = take('CODE_REVIEW_BEDROCK_KEY');
  if (bedrockKey) credentials.bedrockKey = bedrockKey;
  const requestUrl = take('ACTIONS_ID_TOKEN_REQUEST_URL');
  const requestToken = take('ACTIONS_ID_TOKEN_REQUEST_TOKEN');
  if (requestUrl && requestToken && process.env['CODE_REVIEW_FEDERATION_RULE_ID']) {
    credentials.anthropic = new AnthropicTokenSource(
      {
        ruleId: required('CODE_REVIEW_FEDERATION_RULE_ID'),
        organizationId: required('CODE_REVIEW_ORGANIZATION_ID'),
        serviceAccountId: required('CODE_REVIEW_SERVICE_ACCOUNT_ID'),
        workspaceId: required('CODE_REVIEW_WORKSPACE_ID'),
      },
      requestUrl,
      requestToken,
    );
  }

  const log = (line: string) => console.log(line);
  const started = Date.now();
  const pullRequest = readPullRequest(event, repository);
  run.headSha = pullRequest.headSha || undefined;
  // The engine fetches the exact commit once it has decided to review, unless the workflow already checked the head out.
  const headFetch = fetchHeadFor({ path: prPath, repository, serverUrl: process.env['GITHUB_SERVER_URL'], number: pullRequest.number, headSha: pullRequest.headSha, token: githubToken });
  fetchPullRequestHead(headFetch);
  pullRequest.issues = await readClosedIssues(repository, closedIssues(pullRequest.body), githubToken);
  const gathered = gather(pullRequest, prPath, basePath, path.join(root, 'guidance'));
  run.headSha = pullRequest.headSha;
  log(`Reviewing ${repository}#${pullRequest.number} at ${pullRequest.headSha.slice(0, 7)}`);
  const shown = gathered.files.filter((f) => f.shown).length;
  log(`${gathered.files.length} changed files, ${shown} in the diff, ${gathered.diff.length} characters`);

  const choice = await chooseProvider(credentials);
  log(`Provider: ${choice.reason}`);

  const proxy = await startProxy(credentials);
  let results: Results;
  try {
    const outcome = await review({ provider: choice.provider, proxyUrl: proxy.url, checkout: prPath }, gathered, loadCharters(root), log);
    results = {
      repository,
      pullRequest: pullRequest.number,
      headSha: pullRequest.headSha,
      provider: choice.provider,
      providerReason: choice.reason,
      summary: outcome.summary,
      verdict: outcome.verdict,
      findings: outcome.findings,
      reviewers: outcome.reviewers.map(({ name, status, findings, error }) => {
        const top = topSeverity(findings);
        return {
          name,
          status,
          model: outcome.calls.find((c) => c.role === `reviewer:${name}`)?.model ?? '',
          findingCount: findings.length,
          ...(top ? { topSeverity: top } : {}),
          ...(error ? { error } : {}),
        };
      }),
      skipped: outcome.skipped,
      synthesisModel: outcome.calls.find((c) => c.role === 'synthesis')?.model ?? '',
      calls: outcome.calls,
      costUsd: outcome.calls.reduce((sum, c) => sum + c.costUsd, 0),
      durationMs: Date.now() - started,
      notShown: gathered.files.filter((f) => !f.shown).map((f) => f.path),
      changedLines: changedLinesFor(gathered.diff, outcome.findings.map((f) => f.file)),
    };
    const trace = { results, rawFindings: outcome.reviewers, files: gathered.files, conventionsChars: gathered.conventions.length };

    const secrets = secretValues(credentials);
    const resultsJson = JSON.stringify(results, null, 2);
    const traceJson = JSON.stringify(trace, null, 2);
    assertNoSecrets(resultsJson, secrets, 'The results');
    assertNoSecrets(traceJson, secrets, 'The trace');
    mkdirSync(outDir, { recursive: true });
    writeFileSync(path.join(outDir, 'results.json'), resultsJson);
    writeFileSync(path.join(outDir, 'trace.json'), traceJson);
    // Tells the action's later steps there's a review to publish.
    const output = process.env['GITHUB_OUTPUT'];
    if (output) appendFileSync(output, 'reviewed=true\n');
  } finally {
    await proxy.close();
  }
  log(`${results.findings.length} findings, $${results.costUsd.toFixed(2)}, ${Math.round(results.durationMs / 1000)}s`);
}

main().catch((error) => {
  try {
    writeStatus(failureStatus(error, runUrl()));
  } catch (statusError) {
    console.error(`::warning::Couldn't record why the review stopped: ${(statusError as Error).message}`);
  }
  // No provider means the budget is used up, not that the review broke: the check run says so, neutral, and the job
  // doesn't fail.
  if (error instanceof NoProviderError) {
    console.log(`::warning::${error.message} No review ran, and nothing was charged.`);
    return;
  }
  console.error(`::error::${(error as Error).message}`);
  process.exitCode = 1;
});

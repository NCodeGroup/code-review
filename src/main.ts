// The review step: gather, choose a provider, review, and write results.json and trace.json for the publish step.
// It holds the model credentials but never the app's private key, which only the publish step sees.

import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { commandFromEvent, skipReasonFor } from './command.ts';
import { lastReviewedHead } from './comments.ts';
import { AnthropicTokenSource, secretValues, type Credentials } from './credentials.ts';
import { fetchHeadFor, fetchPullRequestHead } from './fetch-head.ts';
import { closedIssues, gather, readPullRequest } from './gather.ts';
import { assertNoSecrets } from './outputs.ts';
import { chooseProvider } from './provider.ts';
import { startProxy } from './proxy.ts';
import { changedLines, loadCharters, review } from './review.ts';
import { topSeverity, type Results } from './results.ts';
import { readClosedIssues, writerCheck } from './writers.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

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

async function main(): Promise<void> {
  const outDir = required('CODE_REVIEW_OUT');
  const prPath = path.resolve(required('CODE_REVIEW_PR_PATH'));
  const basePath = path.resolve(required('CODE_REVIEW_BASE_PATH'));
  const repository = required('GITHUB_REPOSITORY');
  let event = JSON.parse(readFileSync(required('GITHUB_EVENT_PATH'), 'utf8'));
  const githubToken = take('CODE_REVIEW_GITHUB_TOKEN');

  // A /review comment carries the issue, not the pull request, so read the pull request from the API.
  if (event.comment) {
    const request = commandFromEvent(event);
    if (!request) {
      console.log('Not a /review command from someone with write access; nothing to do.');
      return;
    }
    const response = await fetch(`https://api.github.com/repos/${repository}/pulls/${request.number}`, {
      headers: { accept: 'application/vnd.github+json', ...(githubToken ? { authorization: `Bearer ${githubToken}` } : {}) },
    });
    if (!response.ok) throw new Error(`Couldn't read pull request #${request.number}: HTTP ${response.status}`);
    const pullRequest = (await response.json()) as { number?: number; head?: { sha?: string; repo?: { full_name?: string } | null } };
    const reason = await skipReasonFor('comment', pullRequest, repository, () => lastReviewedHead(repository, request.number, githubToken));
    if (reason) {
      console.log(reason);
      return;
    }
    event = { pull_request: pullRequest };
  } else {
    // An automatic run on a commit already reviewed, such as marking a draft ready without pushing, would pay again for
    // the same review. /review still reviews it.
    const pullRequest = event.pull_request;
    const reason = await skipReasonFor('automatic', pullRequest, repository, () => lastReviewedHead(repository, pullRequest.number, githubToken));
    if (reason) {
      console.log(reason);
      return;
    }
  }

  const credentials: Credentials = {};
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
  const pullRequestEvent = event.pull_request ?? event.issue;
  const isWriter = writerCheck(repository, githubToken);
  const pullRequest = readPullRequest(event, repository, await isWriter(pullRequestEvent?.user?.login, pullRequestEvent?.author_association));
  // The engine fetches the exact commit once it has decided to review, unless the workflow already checked the head out.
  const headFetch = fetchHeadFor({ path: prPath, repository, serverUrl: process.env['GITHUB_SERVER_URL'], number: pullRequest.number, headSha: pullRequest.headSha, token: githubToken });
  fetchPullRequestHead(headFetch);
  pullRequest.issues = await readClosedIssues(repository, closedIssues(pullRequest.body), githubToken, isWriter);
  const gathered = gather(pullRequest, prPath, basePath, path.join(root, 'guidance'));
  log(`Reviewing ${repository}#${pullRequest.number} at ${pullRequest.headSha.slice(0, 7)}`);
  log(`Description: ${pullRequest.body ? 'shown' : pullRequest.bodyWithheld ? "left out, since its author can't write to the repository" : 'none'}; ${pullRequest.issues.length} closed issues shown`);
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
  console.error(`::error::${(error as Error).message}`);
  process.exitCode = 1;
});

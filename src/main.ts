// The review step: gather, choose a provider, review, and write results.json and trace.json for the publish step, or
// status.json with why there's no review, for the finish step. For a `/review explain` comment it writes answer.json
// instead, for `/review teach` teach.json, and for an automatic review the loop limit pauses, paused.json. On a closed
// pull request it writes outcomes.json, without a model call (outcomes.ts). It holds the model credentials but never
// the app's private key or a token minted from it: those reach only the steps that write to the pull request.

import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { bedrockFallbackFor, runAgent, totalCost, type AgentRun } from './agent.ts';
import { skippedStatus, stoppedBy, stoppedRecord, type RunStatus } from './checks.ts';
import { decideRun, type Command, type CommentEvent } from './command.ts';
import { errorText, readIssueComments, type ListedComment } from './comments.ts';
import { AnthropicTokenSource, secretValues, type Credentials } from './credentials.ts';
import { required, take } from './env.ts';
import { answerFile, explainFinding, findFinding, writeAnswer, type FoundFinding } from './explain.ts';
import { fetchCommit, fetchHeadFor, fetchPullRequestHead } from './fetch-head.ts';
import { closedIssues, gather, readPullRequest, templateCandidate } from './gather.ts';
import { fetchPullRequest, githubApi, githubReader, runUrl } from './github.ts';
import { readOpenIssues } from './issues.ts';
import { writeErrorLog, writeLog } from './log.ts';
import { isClosedEvent, recordOutcomes } from './outcomes.ts';
import { writeForPublish } from './outputs.ts';
import { checkPause, pausedStatus, type Paused } from './pause.ts';
import { chooseProvider } from './provider.ts';
import { startProxy } from './proxy.ts';
import { planReReview, readEarlierFindings, reReview, runReview } from './rereview.ts';
import { loadCharters, review } from './review.ts';
import { buildResults } from './review-results.ts';
import { newestReviewedHead, upstreamTotal, type Results } from './results.ts';
import { guidanceLabel, planTeaching, teachingFile } from './teach.ts';
import { confirmTemplateFiles } from './template-check.ts';
import { readClosedIssues, writerCheck } from './writers.ts';

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
  const record = stoppedRecord(status, run.headSha, secrets);
  mkdirSync(outDir, { recursive: true });
  writeFileSync(path.join(outDir, 'status.json'), record.json);
  const output = process.env['GITHUB_OUTPUT'];
  if (output && record.output) appendFileSync(output, record.output);
}

// The model credentials, taken out of this process's environment so nothing started later inherits them, and kept in
// `run`, so a stopped run's reason leaves them out.
function takeCredentials(): Credentials {
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
  return credentials;
}

// `/review teach`: words the guidance issue, reading a finding it names with the read-only token, with no model call,
// and leaves it for the publish step, which opens it with an issues token. A rule that can't be taught gets a reply.
async function teach(
  where: { outDir: string; repository: string; number: number; githubToken: string | undefined; event: CommentEvent },
  command: Extract<Command, { kind: 'teach' }>,
): Promise<void> {
  const { outDir, repository, number, githubToken, event } = where;
  const secrets = githubToken ? [githubToken] : [];
  const host = new URL(process.env['GITHUB_SERVER_URL'] || 'https://github.com').host;
  const context = {
    repository,
    number,
    host,
    commentUrl: event.comment?.html_url,
    author: event.comment?.user?.login,
    isPrivate: event.repository?.private !== false,
  };
  const plan = await planTeaching(command, context, githubReader(githubToken));
  if ('answer' in plan) {
    writeLog(`Not teaching: ${plan.answer.body}`);
    writeForPublish(outDir, { [answerFile]: plan.answer }, secrets, 'answered');
    return;
  }
  const [owner, name] = plan.teaching.target.split('/') as [string, string];
  writeLog(`Teaching a ${command.scope === 'org' ? 'NCodeGroup-wide' : 'project'} rule: a ${guidanceLabel} issue in ${plan.teaching.target}`);
  writeForPublish(outDir, { [teachingFile]: plan.teaching }, secrets, 'taught', { 'guidance-owner': owner, 'guidance-repository': name });
}

// `/review explain <ref>`: finds the finding with the read-only token, has one agent read the code again, and leaves the
// answer for the publish step. An unknown ref gets the newest review's ids, without a model call.
async function answer(
  where: { outDir: string; prPath: string; repository: string; number: number; headSha: string; githubToken: string | undefined },
  command: Extract<Command, { kind: 'explain' }>,
): Promise<void> {
  const { outDir, prPath, repository, number, headSha, githubToken } = where;
  const credentials = takeCredentials();
  const secrets = [...secretValues(credentials), ...(githubToken ? [githubToken] : [])];
  const host = new URL(process.env['GITHUB_SERVER_URL'] || 'https://github.com').host;
  const resolution = await findFinding(command.ref, { repository, number, host }, githubReader(githubToken));
  if ('validIds' in resolution) writeLog(`No such finding; the newest review's are ${resolution.validIds.join(', ') || 'none'}.`);

  const ask = async (found: FoundFinding) => {
    writeLog(`Explaining ${found.id} (${found.comment.html_url ?? found.comment.id}) at ${headSha.slice(0, 7)}`);
    fetchPullRequestHead(fetchHeadFor({ path: prPath, repository, serverUrl: process.env['GITHUB_SERVER_URL'], number, headSha, token: githubToken }));
    const choice = await chooseProvider(credentials);
    writeLog(`Provider: ${choice.reason}`);
    const proxy = await startProxy(credentials);
    const fallback = bedrockFallbackFor(choice.provider, Boolean(credentials.bedrockKey));
    try {
      const systemPrompt = readFileSync(path.join(root, 'prompts', 'explain.md'), 'utf8');
      const run = { provider: choice.provider, proxyUrl: proxy.url, checkout: prPath, ...(fallback ? { fallback } : {}) };
      const result = await explainFinding(run, systemPrompt, { found, question: command.question, headSha });
      if (fallback?.reason) writeLog(`Switched to Bedrock partway: ${fallback.reason}`);
      if (result.error) writeLog(`::warning::The explain call failed: ${errorText(result.error)}`);
      const outcome = !result.output ? 'No answer' : result.output.holds ? 'Holds' : "Doesn't hold";
      writeLog(`${outcome}, $${totalCost(result.records).toFixed(2)}`);
      return result;
    } finally {
      await proxy.close();
    }
  };
  await writeAnswer(outDir, { repository, number, question: command.question, secrets }, command.ref, resolution, ask);
}

async function main(): Promise<void> {
  const outDir = required('CODE_REVIEW_OUT');
  const prPath = path.resolve(required('CODE_REVIEW_PR_PATH'));
  const basePath = path.resolve(required('CODE_REVIEW_BASE_PATH'));
  const repository = required('GITHUB_REPOSITORY');
  let event = JSON.parse(readFileSync(required('GITHUB_EVENT_PATH'), 'utf8'));
  const githubToken = take('CODE_REVIEW_GITHUB_TOKEN');
  if (githubToken) run.githubToken = githubToken;
  const log = writeLog;
  // The pull request's comments, read once: the skip rule, the loop limit and the re-review all need them.
  let comments: Promise<ListedComment[] | undefined> | undefined;
  const issueComments = (number: number) => (comments ??= readIssueComments(repository, number, githubToken, fetch, log));
  const reviewedHead = async (number: number) => newestReviewedHead(await issueComments(number));

  // A closed pull request records what became of its findings, by rules alone: no provider, proxy or model call, and so
  // no credentials. It never reviews.
  if (isClosedEvent(event)) {
    if (!githubToken) throw new Error("CODE_REVIEW_GITHUB_TOKEN isn't set; the outcomes need it to read the review threads.");
    await recordOutcomes(githubApi(githubToken, fetch, { terseErrors: true }), event, repository, outDir);
    return;
  }
  // A /review comment carries the issue, not the pull request, so the decision reads the pull request from the API.
  // An automatic run on a commit already reviewed, such as marking a draft ready without pushing, would pay again for
  // the same review; /review still reviews it.
  const decision = await decideRun(
    event,
    repository,
    (number) => fetchPullRequest(repository, number, githubToken),
    reviewedHead,
  );
  if (!decision.run) {
    writeLog(decision.reason);
    writeStatus(skippedStatus(decision.reason));
    return;
  }
  const { command, number } = decision;
  if (command.kind === 'explain') {
    await answer({ outDir, prPath, repository, number, headSha: decision.pullRequest.head?.sha ?? '', githubToken }, command);
    return;
  }
  if (command.kind === 'teach') {
    await teach({ outDir, repository, number, githubToken, event }, command);
    return;
  }
  const isWriter = writerCheck(repository, githubToken, fetch, log);
  // After three reviews with no word from the maintainer, an automatic run reviews nothing and makes no model call. Its
  // status lets the finish step complete an acknowledged check run, so a paused run never leaves one in progress.
  if (!event.comment) {
    const pause = await checkPause({ repository, number, token: githubToken, issueComments: await issueComments(number), isWriter, log });
    if (pause !== 'review') writeStatus(pausedStatus());
    if (pause === 'paused') {
      writeLog('Paused, and the notice is posted already; comment /review to resume.');
      return;
    }
    if (pause === 'pause') {
      const paused: Paused = { repository, pullRequest: number };
      mkdirSync(outDir, { recursive: true });
      writeFileSync(path.join(outDir, 'paused.json'), JSON.stringify(paused));
      const output = process.env['GITHUB_OUTPUT'];
      if (output) appendFileSync(output, 'paused=true\n');
      return;
    }
  }
  if (event.comment) event = { pull_request: decision.pullRequest };

  const credentials = takeCredentials();
  const started = Date.now();
  const pullRequestEvent = event.pull_request ?? event.issue;
  const authorCanWrite = await isWriter(pullRequestEvent?.user?.login, pullRequestEvent?.author_association);
  const pullRequest = readPullRequest(event, repository, authorCanWrite);
  run.headSha = pullRequest.headSha || undefined;
  // The engine fetches the exact commit once it has decided to review, unless the workflow already checked the head out.
  const headFetch = fetchHeadFor({ path: prPath, repository, serverUrl: process.env['GITHUB_SERVER_URL'], number: pullRequest.number, headSha: pullRequest.headSha, token: githubToken });
  fetchPullRequestHead(headFetch);
  const closedNumbers = closedIssues(pullRequest.body);
  pullRequest.issues = await readClosedIssues(repository, closedNumbers, githubToken, isWriter, fetch, log);
  // A template adoption or update leaves a file to the template only when it is the template's own copy.
  const candidate = templateCandidate(pullRequest, prPath, basePath);
  const confirmed = candidate ? await confirmTemplateFiles(candidate, prPath, githubReader(githubToken), log) : undefined;
  const gathered = gather(pullRequest, prPath, basePath, path.join(root, 'guidance'), confirmed);
  run.headSha = pullRequest.headSha;
  log(`Reviewing ${repository}#${pullRequest.number} at ${pullRequest.headSha.slice(0, 7)}`);
  log(`Description: ${pullRequest.body ? 'shown' : pullRequest.bodyWithheld ? "left out, since its author can't write to the repository" : 'none'}; ${pullRequest.issues.length} closed issues shown`);
  for (const warning of gathered.warnings) log(`::warning::${warning}`);
  const shown = gathered.files.filter((f) => f.shown).length;
  log(`${gathered.files.length} changed files, ${shown} in the diff, ${gathered.diff.length} characters${gathered.skippedByConfig.length ? `, ${gathered.skippedByConfig.length} skipped by config` : ''}`);
  // A pull request the bot reviewed before gets a re-review of what changed since then.
  const last = await reviewedHead(pullRequest.number);
  const plan = await planReReview({
    gathered,
    checkout: prPath,
    lastHead: last,
    fetchCommit: (sha) => fetchCommit({ ...headFetch, sha }),
    readEarlier: () => readEarlierFindings(repository, pullRequest.number, githubToken, isWriter),
    log,
  });
  // Only a full review's synthesis can mark a finding as tracked in an open issue.
  const openIssues = plan ? [] : await readOpenIssues(repository, githubToken, isWriter, closedIssues(pullRequest.body));

  const choice = await chooseProvider(credentials);
  log(`Provider: ${choice.reason}`);

  const proxy = await startProxy(credentials);
  // A run that starts on the Claude API with a Bedrock key moves to Bedrock if the credits run out partway.
  const fallback = bedrockFallbackFor(choice.provider, Boolean(credentials.bedrockKey));
  let results: Results;
  try {
    const agentRun: AgentRun = { provider: choice.provider, proxyUrl: proxy.url, checkout: prPath, ...(fallback ? { fallback } : {}) };
    const { outcome, recordedHead, trace: reReviewTrace } = await runReview({
      plan,
      headSha: pullRequest.headSha,
      lastHead: last,
      full: () => review({ run: agentRun, gathered, charters: loadCharters(root), log, agent: runAgent, openIssues }),
      again: (p) => reReview(agentRun, gathered, loadCharters(root), p, log),
    });
    for (const warning of outcome.warnings) log(`::warning::${warning}`);
    if (fallback?.reason) log(`Switched to Bedrock partway: ${fallback.reason}`);
    results = buildResults(outcome, {
      repository,
      pullRequest: pullRequest.number,
      headSha: pullRequest.headSha,
      authorCanWrite: pullRequest.authorCanWrite,
      provider: choice.provider,
      providerReason: choice.reason,
      ...(fallback?.reason ? { switchedToBedrock: fallback.reason } : {}),
      ...(gathered.template ? { template: gathered.template.repository } : {}),
      durationMs: Date.now() - started,
      notShown: gathered.files.filter((f) => !f.shown).map((f) => f.path),
      skippedByConfig: gathered.skippedByConfig,
      warnings: gathered.warnings,
      diff: gathered.diff,
      recordedHead,
      ...(reReviewTrace.reReview
        ? { reReview: { changedLines: reReviewTrace.reReview.changedLines, earlier: reReviewTrace.reReview.earlier.map(({ url, status, note }) => ({ url, status, note })) } }
        : {}),
    });
    // The shadow reviewers' findings and the shadow prompts' outputs, beside the live ones they shadow.
    const trace = {
      results,
      rawFindings: outcome.reviewers,
      verification: outcome.verification,
      shadow: { reviewers: outcome.shadow, skipped: outcome.shadowSkipped, prompts: outcome.shadowPrompts },
      files: gathered.files,
      conventionsChars: gathered.conventions.length,
      settings: {
        policies: gathered.policies,
        projectReviewers: gathered.projectReviewers.map((r) => ({ name: r.name, paths: r.paths, ...(r.shadow ? { shadow: true } : {}) })),
        sensitive: gathered.sensitive,
        tiers: gathered.tiers,
      },
      ...reReviewTrace,
    };
    writeForPublish(outDir, { 'results.json': results, 'trace.json': trace }, secretValues(credentials), 'reviewed');
  } finally {
    await proxy.close();
  }
  const upstream = upstreamTotal(results);
  log(`${results.findings.length} findings${upstream ? ` (${upstream} more belong upstream)` : ''}, $${results.costUsd.toFixed(2)}, ${Math.round(results.durationMs / 1000)}s`);
}

main().catch((error) => {
  const { status, failed } = stoppedBy(error, runUrl());
  try {
    writeStatus(status);
  } catch (statusError) {
    writeErrorLog(`::warning::Couldn't record why the review stopped: ${(statusError as Error).message}`);
  }
  if (!failed) {
    writeLog(`::warning::${error.message} No review ran, and nothing was charged.`);
    return;
  }
  writeErrorLog(`::error::${(error as Error).message}`);
  process.exitCode = 1;
});

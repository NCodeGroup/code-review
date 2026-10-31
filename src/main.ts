// The review step: gather, choose a provider, review, and write results.json and trace.json for the publish step. For a
// `/review explain` comment it writes answer.json instead, and for `/review teach` teach.json.
// It holds the model credentials but never the app's private key, which only the publish step sees.

import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { commandFromEvent, skipReasonFor, type Command, type CommentEvent } from './command.ts';
import { errorText, lastReviewedHead } from './comments.ts';
import { AnthropicTokenSource, secretValues, type Credentials } from './credentials.ts';
import { answerFile, answerFor, explainFinding, findFinding, githubReader, type Answer, type FoundFinding } from './explain.ts';
import { fetchHeadFor, fetchPullRequestHead } from './fetch-head.ts';
import { closedIssues, gather, maxIssueChars, readPullRequest } from './gather.ts';
import { assertNoSecrets } from './outputs.ts';
import { chooseProvider } from './provider.ts';
import { startProxy } from './proxy.ts';
import { changedLines, loadCharters, review } from './review.ts';
import { topSeverity, type Results } from './results.ts';
import { guidanceLabel, planTeaching, teachingFile } from './teach.ts';

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

// The model credentials, taken out of this process's environment so nothing started later inherits them.
function takeCredentials(): Credentials {
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
  return credentials;
}

// Writes what the publish step posts, scanned for secrets, and tells the action's later steps there's something to post.
function writeForPublish(outDir: string, files: Record<string, unknown>, secrets: string[], flag: 'reviewed' | 'answered' | 'taught', outputs: Record<string, string> = {}): void {
  const texts = Object.entries(files).map(([name, value]) => [name, JSON.stringify(value, null, 2)] as const);
  for (const [name, text] of texts) assertNoSecrets(text, secrets, `The ${name.replace(/\.json$/, '')}`);
  mkdirSync(outDir, { recursive: true });
  for (const [name, text] of texts) writeFileSync(path.join(outDir, name), text);
  const output = process.env['GITHUB_OUTPUT'];
  if (output) appendFileSync(output, [`${flag}=true`, ...Object.entries(outputs).map(([key, value]) => `${key}=${value}`)].map((line) => `${line}\n`).join(''));
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
    console.log(`Not teaching: ${plan.answer.body}`);
    writeForPublish(outDir, { [answerFile]: plan.answer }, secrets, 'answered');
    return;
  }
  const [owner, name] = plan.teaching.target.split('/') as [string, string];
  console.log(`Teaching a ${command.scope === 'org' ? 'NCodeGroup-wide' : 'project'} rule: a ${guidanceLabel} issue in ${plan.teaching.target}`);
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
  if ('validIds' in resolution) console.log(`No such finding; the newest review's are ${resolution.validIds.join(', ') || 'none'}.`);

  const ask = async (found: FoundFinding) => {
    console.log(`Explaining ${found.id} (${found.comment.html_url ?? found.comment.id}) at ${headSha.slice(0, 7)}`);
    fetchPullRequestHead(fetchHeadFor({ path: prPath, repository, serverUrl: process.env['GITHUB_SERVER_URL'], number, headSha, token: githubToken }));
    const choice = await chooseProvider(credentials);
    console.log(`Provider: ${choice.reason}`);
    const proxy = await startProxy(credentials);
    try {
      const systemPrompt = readFileSync(path.join(root, 'prompts', 'explain.md'), 'utf8');
      return await explainFinding({ provider: choice.provider, proxyUrl: proxy.url, checkout: prPath }, systemPrompt, { found, question: command.question, headSha });
    } finally {
      await proxy.close();
    }
  };
  const { body, explained } = await answerFor(command.ref, resolution, ask);
  const files: Record<string, unknown> = { [answerFile]: { repository, pullRequest: number, body } satisfies Answer };
  if (explained) {
    const { found, result } = explained;
    if (result.error) console.log(`::warning::The explain call failed: ${errorText(result.error)}`);
    files['trace.json'] = { explain: { id: found.id, comment: found.comment.html_url ?? found.comment.id, question: command.question, output: result.output, call: result.record } };
    const outcome = !result.output ? 'No answer' : result.output.holds ? 'Holds' : "Doesn't hold";
    console.log(`${outcome}, $${result.record.costUsd.toFixed(2)}`);
  }
  writeForPublish(outDir, files, secrets, 'answered');
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
    if (request.command.kind === 'explain') {
      await answer({ outDir, prPath, repository, number: request.number, headSha: pullRequest.head?.sha ?? '', githubToken }, request.command);
      return;
    }
    if (request.command.kind === 'teach') {
      await teach({ outDir, repository, number: request.number, githubToken, event }, request.command);
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

  const credentials = takeCredentials();
  const log = (line: string) => console.log(line);
  const started = Date.now();
  const pullRequest = readPullRequest(event, repository);
  // The engine fetches the exact commit once it has decided to review, unless the workflow already checked the head out.
  const headFetch = fetchHeadFor({ path: prPath, repository, serverUrl: process.env['GITHUB_SERVER_URL'], number: pullRequest.number, headSha: pullRequest.headSha, token: githubToken });
  fetchPullRequestHead(headFetch);
  pullRequest.issues = await readClosedIssues(repository, closedIssues(pullRequest.body), githubToken);
  const gathered = gather(pullRequest, prPath, basePath, path.join(root, 'guidance'));
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
      ...(outcome.verification.length ? { refuted: outcome.refuted } : {}),
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
    const trace = { results, rawFindings: outcome.reviewers, verification: outcome.verification, files: gathered.files, conventionsChars: gathered.conventions.length };
    writeForPublish(outDir, { 'results.json': results, 'trace.json': trace }, secretValues(credentials), 'reviewed');
  } finally {
    await proxy.close();
  }
  log(`${results.findings.length} findings, $${results.costUsd.toFixed(2)}, ${Math.round(results.durationMs / 1000)}s`);
}

main().catch((error) => {
  console.error(`::error::${(error as Error).message}`);
  process.exitCode = 1;
});

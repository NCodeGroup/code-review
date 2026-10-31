// The finish step: completes the "Code review" check run when the publish step didn't, so it never stays in progress.
// It runs after the review step, whatever happened to it: the review found no provider, failed, was cancelled, or
// stopped before it began. The reason comes from the review step's status.json, or from the steps' outcomes when there
// is none. Like the acknowledgement, it imports no npm package, so it works even when npm ci failed.

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { acknowledgedFrom, finishCheck, parseStatus, stoppedStatus, type RunStatus } from './checks.ts';
import { githubApi, runUrl } from './github.ts';
import { assertNoSecrets } from './outputs.ts';

function readStatus(outDir: string): RunStatus | undefined {
  try {
    return parseStatus(readFileSync(path.join(outDir, 'status.json'), 'utf8'));
  } catch {
    return undefined;
  }
}

async function main(): Promise<void> {
  const token = process.env['CODE_REVIEW_APP_TOKEN'];
  const outDir = process.env['CODE_REVIEW_OUT'];
  const repository = process.env['GITHUB_REPOSITORY'];
  if (!token || !outDir || !repository) throw new Error('CODE_REVIEW_APP_TOKEN, CODE_REVIEW_OUT and GITHUB_REPOSITORY must be set.');
  const acknowledged = acknowledgedFrom(process.env['CODE_REVIEW_CHECK_RUN_ID'], process.env['CODE_REVIEW_CHECK_RUN_SHA']);
  const [setup = '', install = '', review = '', publish = ''] = (process.env['CODE_REVIEW_STEP_OUTCOMES'] ?? '').split(',');
  const url = runUrl();
  let status = readStatus(outDir) ?? stoppedStatus({ others: [setup, install], review, publish }, url);
  try {
    assertNoSecrets(JSON.stringify(status), [token], 'The check run');
  } catch (error) {
    console.log(`::warning::${(error as Error).message} It is left out.`);
    status = {
      conclusion: status.conclusion,
      title: 'Review stopped',
      summary: "The reason can't be shown here; the run's log says why.",
      ...(status.headSha ? { headSha: status.headSha } : {}),
    };
    assertNoSecrets(JSON.stringify(status), [token], 'The check run');
  }
  if (await finishCheck(githubApi(token), repository, acknowledged, status)) console.log(`Completed the check run: ${status.title}`);
  else console.log('No check run to complete.');
}

main().catch((error) => {
  console.error(`::error::${(error as Error).message}`);
  process.exitCode = 1;
});

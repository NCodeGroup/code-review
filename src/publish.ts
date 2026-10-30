// The publish step: reads results.json and posts the "Code review" check run with the app's token. It runs after the
// agents have exited, and the token is limited to checks on the one repository under review.

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { assertNoSecrets } from './outputs.ts';
import { annotations, checkSummary, checkText, checkTitle, type Results } from './results.ts';

async function main(): Promise<void> {
  const token = process.env['CODE_REVIEW_APP_TOKEN'];
  const outDir = process.env['CODE_REVIEW_OUT'];
  if (!token || !outDir) throw new Error('CODE_REVIEW_APP_TOKEN and CODE_REVIEW_OUT must be set.');
  const results = JSON.parse(readFileSync(path.join(outDir, 'results.json'), 'utf8')) as Results;

  const output = { title: checkTitle(results), summary: checkSummary(results), text: checkText(results), annotations: annotations(results) };
  const body = JSON.stringify({ name: 'Code review', head_sha: results.headSha, status: 'completed', conclusion: 'neutral', output });
  assertNoSecrets(body, [token], 'The check run');

  const response = await fetch(`https://api.github.com/repos/${results.repository}/check-runs`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      accept: 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28',
      'content-type': 'application/json',
    },
    body,
  });
  if (!response.ok) throw new Error(`GitHub refused the check run: HTTP ${response.status} ${await response.text()}`);
  const created = (await response.json()) as { html_url: string };
  console.log(`Posted ${created.html_url}`);
}

main().catch((error) => {
  console.error(`::error::${(error as Error).message}`);
  process.exitCode = 1;
});

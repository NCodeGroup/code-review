// Copyright © NCode Group
// SPDX-License-Identifier: Apache-2.0

// Fails a pull request that changes what the action's consumers run unless it adds a new release section to
// CHANGELOG.md, so that its merge tags and publishes that version through tag-release.yml (ADR-1012).
//
//   node tools/release-check.ts <base ref>
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { linesWithFences, releaseNotes } from './release-notes.ts';

// What a consumer's run of the action loads: action.yml, the engine, the prompts, the reviewers' charters and the
// learned guidance. package.json counts only for its runtime dependencies, which action.yml installs with npm ci
// --omit=dev.
export const shippedPaths = ['action.yml', 'src/', 'prompts/', 'reviewers/', 'guidance/'];

// The changed files a consumer runs, with "package.json dependencies" when the runtime dependencies changed.
export function shippedChanges(files: readonly string[], basePackage?: string, headPackage?: string): string[] {
  const changed = files.filter((file) => shippedPaths.some((p) => (p.endsWith('/') ? file.startsWith(p) : file === p)));
  if (files.includes('package.json') && dependencies(basePackage) !== dependencies(headPackage))
    changed.push('package.json dependencies');
  return changed;
}

function dependencies(packageJson: string | undefined): string {
  if (packageJson === undefined) return '{}';
  return JSON.stringify((JSON.parse(packageJson) as { dependencies?: unknown }).dependencies ?? {});
}

// The number of the changelog's newest release section, `## [1.2.3] - 2026-11-27`, as Publish-Release.ps1 reads it.
export function newestRelease(changelog: string): string | undefined {
  for (const [, line, inFence] of linesWithFences(changelog.split(/\r?\n/))) {
    const number = inFence ? undefined : /^## \[(\d+\.\d+\.\d+)\]/.exec(line)?.[1];
    if (number) return number;
  }
  return undefined;
}

function newer(a: string, b: string): boolean {
  const [x, y] = [a, b].map((v) => v.split('.').map(Number));
  for (let i = 0; i < 3; i++) if (x![i] !== y![i]) return x![i]! > y![i]!;
  return false;
}

// How many changed files the refusal names before it counts the rest.
const namedFiles = 5;

// A message as a workflow command's text: %, CR and LF escaped, so a file name can't end the annotation or start
// another command.
export function workflowCommandText(message: string): string {
  return message.replaceAll('%', '%25').replaceAll('\r', '%0D').replaceAll('\n', '%0A');
}

// Why the pull request can't merge as it is, or undefined: it changes nothing a consumer runs, or its changelog's newest
// release section is newer than the base's and holds the release's changes.
export function releaseProblem(
  changed: readonly string[],
  baseChangelog: string,
  headChangelog: string,
): string | undefined {
  if (!changed.length) return undefined;
  const before = newestRelease(baseChangelog);
  const after = newestRelease(headChangelog);
  if (after && (!before || newer(after, before))) {
    try {
      releaseNotes(headChangelog, after);
      return undefined;
    } catch (error) {
      return (error as Error).message;
    }
  }
  const named =
    changed.length > namedFiles
      ? `${changed.slice(0, namedFiles).join(', ')} and ${changed.length - namedFiles} more`
      : changed.join(', ');
  return (
    `This pull request changes what the action's consumers run (${named}), so its merge must release it: ` +
    `move CHANGELOG.md's [Unreleased] entries into a new '## [<version>] - YYYY-MM-DD' section newer than ${before ?? 'the last release'}, ` +
    'with its compare link, and tag-release.yml publishes that version when the pull request merges (ADR-1012).'
  );
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  try {
    const [base] = process.argv.slice(2);
    if (!base) throw new Error('Usage: node tools/release-check.ts <base ref>');
    const git = (...args: string[]) => execFileSync('git', args, { encoding: 'utf8' });
    // A file the base branch doesn't have is undefined; any other git failure, such as a missing object, throws.
    const atBase = (file: string) => {
      try {
        execFileSync('git', ['cat-file', '-e', `${base}:${file}`], { stdio: 'ignore' });
      } catch {
        return undefined;
      }
      return git('show', `${base}:${file}`);
    };
    const files = git('diff', '--name-only', `${base}...HEAD`).split('\n').filter(Boolean);
    const changed = shippedChanges(files, atBase('package.json'), readFileSync('package.json', 'utf8'));
    const changelog = readFileSync('CHANGELOG.md', 'utf8');
    const problem = releaseProblem(changed, atBase('CHANGELOG.md') ?? '', changelog);
    if (problem) throw new Error(problem);
    console.log(
      changed.length
        ? `Release: ${newestRelease(changelog)}, for ${changed.join(', ')}.`
        : 'Release: none needed; nothing a consumer runs changed.',
    );
  } catch (error) {
    console.error(`::error::${workflowCommandText((error as Error).message)}`);
    process.exitCode = 1;
  }
}

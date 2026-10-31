import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { releaseNotes } from '../tools/release-notes.ts';

const changelog = `# Changelog

All notable changes to this project will be documented in this file.

## [Unreleased]

### Changed

- Something not released yet.

## [0.3.1] - 2026-10-31

### Changed

- Releases are immutable from this one on.

## [0.3.0] - 2026-10-31

### Added

- A reviewer.

### Fixed

- A bug ([#22](https://github.com/NCodeGroup/code-review/pull/22)).

## [0.1.0] - 2026-10-30

### Added

- The first release.

[unreleased]: https://github.com/NCodeGroup/code-review/compare/v0.3.1...HEAD
[0.3.1]: https://github.com/NCodeGroup/code-review/compare/v0.3.0...v0.3.1
[0.1.0]: https://github.com/NCodeGroup/code-review/releases/tag/v0.1.0
`;

test('releaseNotes returns the version\'s section up to the next one', () => {
  assert.equal(
    releaseNotes(changelog, '0.3.0'),
    '### Added\n\n- A reviewer.\n\n### Fixed\n\n- A bug ([#22](https://github.com/NCodeGroup/code-review/pull/22)).\n',
  );
});

test('releaseNotes stops the last section at the link definitions', () => {
  assert.equal(releaseNotes(changelog, '0.1.0'), '### Added\n\n- The first release.\n');
});

test('releaseNotes reads a changelog with CRLF line endings', () => {
  assert.equal(releaseNotes(changelog.replaceAll('\n', '\r\n'), '0.3.1'), '### Changed\n\n- Releases are immutable from this one on.\n');
});

test('releaseNotes fails when the version has no section', () => {
  assert.throws(() => releaseNotes(changelog, '0.4.0'), /no '## \[0\.4\.0\] - YYYY-MM-DD' section/);
});

test('releaseNotes matches the version exactly, not as a pattern or a prefix', () => {
  for (const heading of ['## [0x3y1] - 2026-10-31', '## [0.3.1x] - 2026-10-31', '### [0.3.1] - 2026-10-31']) {
    assert.throws(() => releaseNotes(changelog.replace('## [0.3.1] - 2026-10-31', heading), '0.3.1'), /no '## \[0\.3\.1\]/, heading);
  }
  assert.throws(() => releaseNotes(changelog, '0.3.10'), /no '## \[0\.3\.10\]/);
});

test('releaseNotes fails on a heading without a date', () => {
  assert.throws(() => releaseNotes(changelog.replace('## [0.3.1] - 2026-10-31', '## [0.3.1]'), '0.3.1'), /heading for 0\.3\.1 is '## \[0\.3\.1\]'/);
});

test('releaseNotes fails on a date that isn\'t YYYY-MM-DD or isn\'t on the calendar', () => {
  for (const date of ['31.10.2026', '2026-10-31 (draft)', '2026-02-30', '2026-13-01']) {
    assert.throws(() => releaseNotes(changelog.replace('## [0.3.1] - 2026-10-31', `## [0.3.1] - ${date}`), '0.3.1'), /write it as '## \[0\.3\.1\] - YYYY-MM-DD'/, date);
  }
});

test('releaseNotes fails on a section with no entries', () => {
  const empty = changelog.replace('### Changed\n\n- Releases are immutable from this one on.\n', '### Changed\n\n');
  assert.throws(() => releaseNotes(empty, '0.3.1'), /section for 0\.3\.1 lists no changes/);
});

test('releaseNotes fails on two sections for the version', () => {
  const twice = changelog.replace('## [0.1.0] - 2026-10-30', '## [0.3.1] - 2026-10-30');
  assert.throws(() => releaseNotes(twice, '0.3.1'), /more than one section for 0\.3\.1/);
});

test('releaseNotes keeps a heading inside a fenced block as part of the section', () => {
  const fenced = changelog.replace('- Releases are immutable from this one on.\n', '- Releases are immutable from this one on.\n\n```markdown\n## [0.3.1] - 2026-10-31\n[x]: y\n```\n');
  assert.equal(releaseNotes(fenced, '0.3.1'), '### Changed\n\n- Releases are immutable from this one on.\n\n```markdown\n## [0.3.1] - 2026-10-31\n[x]: y\n```\n');
});

test('releaseNotes closes a fence only with its own marker, at least as long', () => {
  const block = '```\n~~~\n```markdown\n## [0.3.0] - 2026-10-31\n``\n````\n';
  const fenced = changelog.replace('- Releases are immutable from this one on.\n', `- Releases are immutable from this one on.\n\n${block}`);
  assert.equal(releaseNotes(fenced, '0.3.1'), `### Changed\n\n- Releases are immutable from this one on.\n\n${block.trimEnd()}\n`);
  const tilde = changelog.replace('- Releases are immutable from this one on.\n', '- Releases are immutable from this one on.\n\n~~~~\n```\n## [0.1.0] - 2026-10-30\n~~~~\n');
  assert.match(releaseNotes(tilde, '0.3.1'), /~~~~\n```\n## \[0\.1\.0\] - 2026-10-30\n~~~~\n$/);
  assert.equal(releaseNotes(tilde, '0.1.0'), '### Added\n\n- The first release.\n');
});

test('releaseNotes reads a backtick line whose info string holds a backtick as inline code, not a fence', () => {
  const inline = changelog.replace('- Something not released yet.\n', '- Something not released yet.\n\n```a`b```\n');
  assert.equal(releaseNotes(inline, '0.3.1'), releaseNotes(changelog, '0.3.1'));
});

test('releaseNotes says when a fence that is never closed hides the version\'s heading', () => {
  const unclosed = changelog.replace('- Something not released yet.\n', '- Something not released yet.\n\n```\n');
  assert.throws(() => releaseNotes(unclosed, '0.3.1'), /no '## \[0\.3\.1\] - YYYY-MM-DD' section; .* A code fence opened on line 11 is never closed/);
});

test('releaseNotes fails on a section with a fence that is never closed', () => {
  const unclosed = `${changelog.slice(0, changelog.indexOf('[unreleased]:'))}\`\`\`text\n`.replace('- The first release.\n', '- The first release.\n\n~~~\n');
  assert.throws(() => releaseNotes(unclosed, '0.1.0'), /section for 0\.1\.0 has a code fence on line 33 that is never closed/);
});

test('releaseNotes takes numbered entries as changes', () => {
  const numbered = changelog.replace('- Releases are immutable from this one on.', '1. Releases are immutable from this one on.\n2) And signed.');
  assert.equal(releaseNotes(numbered, '0.3.1'), '### Changed\n\n1. Releases are immutable from this one on.\n2) And signed.\n');
});

test('releaseNotes refuses a version that isn\'t MAJOR.MINOR.PATCH', () => {
  for (const version of ['', 'v0.3.1', '0.3', '0.3.1-rc.1', '.*']) {
    assert.throws(() => releaseNotes(changelog, version), /isn't MAJOR\.MINOR\.PATCH/, version);
  }
});

const made: string[] = [];
after(() => {
  for (const dir of made) rmSync(dir, { recursive: true, force: true });
});

// The Release workflow relies on the script's exit code and output, so these run it as a process.
const script = fileURLToPath(new URL('../tools/release-notes.ts', import.meta.url));
function scratch() {
  const dir = mkdtempSync(path.join(tmpdir(), 'release-notes-'));
  made.push(dir);
  return dir;
}
function spawn(args: string[], cwd: string) {
  return spawnSync(process.execPath, [script, ...args], { cwd, encoding: 'utf8' });
}
function run(...args: string[]) {
  const dir = scratch();
  const file = path.join(dir, 'CHANGELOG.md');
  writeFileSync(file, changelog);
  return spawn([...args, file], dir);
}

test('the script prints the section and exits 0', () => {
  const result = run('0.3.1');
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, '### Changed\n\n- Releases are immutable from this one on.\n');
});

test('the script runs when called by a relative path, as the workflow calls it', () => {
  const dir = scratch();
  const file = path.join(dir, 'CHANGELOG.md');
  writeFileSync(file, changelog);
  const root = fileURLToPath(new URL('..', import.meta.url));
  const result = spawnSync(process.execPath, [path.join('tools', 'release-notes.ts'), '0.3.1', file], { cwd: root, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, '### Changed\n\n- Releases are immutable from this one on.\n');
});

test('the script prints an error annotation and exits 1 when the section is missing', () => {
  const result = run('0.4.0');
  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /^::error::CHANGELOG\.md has no '## \[0\.4\.0\] - YYYY-MM-DD' section/);
});

test('the script prints its usage and exits 1 without a version', () => {
  const result = spawn([], scratch());
  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /^::error::Usage: node tools\/release-notes\.ts <version> \[<changelog>\]/);
});

test('the script prints an error annotation and exits 1 when the changelog can\'t be read', () => {
  const dir = scratch();
  const result = spawn(['0.3.1', path.join(dir, 'missing.md')], dir);
  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /^::error::ENOENT/);
});

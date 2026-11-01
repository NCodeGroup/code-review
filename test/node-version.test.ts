// The workflows read the Node version from .node-version. The action keeps its own copy, because it runs in other
// repositories' workflows, where this repository's .node-version isn't checked out; it must name the same version.

import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const workflows = path.join(root, '.github', 'workflows');
const nodeVersion = readFileSync(path.join(root, '.node-version'), 'utf8').trim();

test('every workflow that sets up Node reads its version from .node-version', () => {
  for (const name of readdirSync(workflows).filter((n) => /\.ya?ml$/.test(n))) {
    const text = readFileSync(path.join(workflows, name), 'utf8');
    assert.doesNotMatch(text, /^\s*node-version:/m, name);
    const setups = text.match(/uses: actions\/setup-node@/g)?.length ?? 0;
    const files = text.match(/^\s*node-version-file: \.node-version\s*$/gm)?.length ?? 0;
    assert.equal(files, setups, name);
  }
});

test("the action's own Node version is the one .node-version names", () => {
  const action = readFileSync(path.join(root, 'action.yml'), 'utf8');
  assert.equal(/^\s*node-version: (\S+)\s*$/m.exec(action)?.[1], nodeVersion);
});

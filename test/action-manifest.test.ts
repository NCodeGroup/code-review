// Copyright © NCode Group
// SPDX-License-Identifier: Apache-2.0

// GitHub loads action.yml before a caller's job runs a step, and a manifest that isn't valid YAML fails every job that
// uses the action in "Set up job". The other action.yml tests read it line by line, so they can't see such an error.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { parseDocument } from 'yaml';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('action.yml is valid YAML with a string description for every input', () => {
  const document = parseDocument(readFileSync(path.join(root, 'action.yml'), 'utf8'));
  assert.deepEqual(
    document.errors.map((e) => `${e.code} at ${e.linePos?.[0]?.line}:${e.linePos?.[0]?.col}`),
    [],
  );
  const inputs = document.toJS().inputs as Record<string, { description?: unknown }>;
  for (const [name, input] of Object.entries(inputs)) {
    assert.equal(typeof input.description, 'string', name);
  }
});

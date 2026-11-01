// Times each test file: it runs every test file in a node process of its own, one at a time, and prints how long each
// took, slowest first, to find what sets `npm test`'s wall time.
//
//   node tools/time-tests.ts [--file test/log.test.ts] [--max-ms 5000]
//
// Each line is the file's wall time in milliseconds, its test count and its path, followed by the total. It exits 1
// when a file's process exits non-zero, or when --max-ms is given and any file took longer.
import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';

/** The `*.test.ts` files in a folder, sorted, as `<folder>/<name>` paths. */
export function testFiles(folder: string): string[] {
  return readdirSync(folder)
    .filter((name) => name.endsWith('.test.ts'))
    .sort()
    .map((name) => `${folder}/${name}`);
}

/** The number in the TAP line `# tests <n>`, or 0 when the output has none. */
export function tapTestCount(output: string): number {
  const match = /^# tests (\d+)\s*$/m.exec(output);
  return match ? Number(match[1]) : 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const { values } = parseArgs({ options: { file: { type: 'string' }, 'max-ms': { type: 'string' } } });
  const files = values.file ? [values.file] : testFiles('test');
  const maxMs = values['max-ms'] === undefined ? undefined : Number(values['max-ms']);
  const timed: { file: string; ms: number; tests: number }[] = [];
  let failed = false;
  const start = performance.now();
  for (const file of files) {
    const began = performance.now();
    const result = spawnSync(process.execPath, ['--test', '--test-reporter=tap', file], {
      encoding: 'utf8',
      maxBuffer: 1 << 26,
    });
    const ms = Math.round(performance.now() - began);
    timed.push({ file, ms, tests: tapTestCount(result.stdout ?? '') });
    if (result.status !== 0) {
      console.error(`::error::${file} exited with ${result.status ?? result.signal}.`);
      failed = true;
    }
  }
  timed.sort((a, b) => b.ms - a.ms);
  for (const { file, ms, tests } of timed) {
    console.log(`${String(ms).padStart(7)} ${String(tests).padStart(4)} ${file}`);
    if (maxMs !== undefined && ms > maxMs) {
      console.error(`::error::${file} took ${ms} ms, over ${maxMs} ms.`);
      failed = true;
    }
  }
  console.log(`total ${Math.round(performance.now() - start)}`);
  if (failed) process.exitCode = 1;
}

// The engine's log. Every line it writes goes through writeLog or writeErrorLog, made one printable line first, so text
// from a pull request in it, such as a file name, can't break the line, start a workflow command or forge another line.

import { printable } from './outputs.ts';

// A line break becomes a space, so a message over several lines stays readable; printable drops every other control
// character.
export function logText(text: string): string {
  return printable(text.replace(/\r\n|[\n\r\u0085\u2028\u2029]/g, ' '));
}

export function writeLog(line: string): void {
  console.log(logText(line));
}

export function writeErrorLog(line: string): void {
  console.error(logText(line));
}

// The frames of error's stack, each without its indent; empty for a value that isn't an Error or has no stack.
export function stackFrames(error: unknown): string[] {
  if (!(error instanceof Error) || !error.stack) return [];
  return error.stack.split('\n').filter((line) => /^\s+at /.test(line)).map((line) => line.trim());
}

// Reports what stopped a step: its message as an ::error:: line, then each frame of its stack on a line of its own,
// so the run's log shows where it was thrown.
export function writeFailure(error: unknown): void {
  writeErrorLog(`::error::${error instanceof Error ? error.message : String(error)}`);
  for (const frame of stackFrames(error)) writeErrorLog(frame);
}

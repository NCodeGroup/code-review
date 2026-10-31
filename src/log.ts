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

// Everything the run publishes is scanned for secrets first: comments, check run text and the trace artifact are public
// on public repositories.

const secretPatterns: RegExp[] = [
  /sk-ant-[A-Za-z0-9_-]{8,}/,
  /\bgh[pousr]_[A-Za-z0-9]{20,}/,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/,
  /\bABSK[A-Za-z0-9+/=]{20,}/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\./,
];

export class SecretFoundError extends Error {}

// Throws when the text holds one of the run's own secret values or anything shaped like a credential. The message never
// includes the match.
export function assertNoSecrets(text: string, knownSecrets: Iterable<string>, where: string): void {
  for (const secret of knownSecrets) {
    if (secret.length >= 8 && text.includes(secret)) throw new SecretFoundError(`${where} contains one of this run's secrets.`);
  }
  for (const pattern of secretPatterns) {
    if (pattern.test(text)) throw new SecretFoundError(`${where} contains something shaped like a credential (${pattern.source.slice(0, 12)}…).`);
  }
}

// Text from a pull request, such as a file name, made safe for one log line: without control characters it can't break
// the line, so it can't start a workflow command or forge another line.
export function printable(text: string): string {
  return text.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, '');
}

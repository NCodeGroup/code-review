import { afterEach, beforeEach } from 'node:test';

const names = ['GITHUB_API_URL', 'GITHUB_GRAPHQL_URL'];

// For a test file that expects github.com's addresses: clears the runner's own GitHub addresses, such as a GitHub
// Enterprise Server's, while each test runs, and puts them back after it.
export function useGitHubDotCom(): void {
  let saved: (string | undefined)[] = [];
  beforeEach(() => {
    saved = names.map((name) => process.env[name]);
    for (const name of names) delete process.env[name];
  });
  afterEach(() => {
    names.forEach((name, i) => {
      const value = saved[i];
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    });
  });
}

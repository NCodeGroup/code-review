// Reading the action's environment variables. Nothing here imports an npm package: the acknowledgement runs it with the
// runner's own node, before npm ci.

export function required(name: string, env: NodeJS.ProcessEnv = process.env): string {
  const value = env[name];
  if (!value) throw new Error(`${name} isn't set.`);
  return value;
}

// Reads a variable and removes it from the environment, so nothing started later inherits it.
export function take(name: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  const value = env[name];
  delete env[name];
  return value || undefined;
}

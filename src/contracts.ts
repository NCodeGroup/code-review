// What the selection floor needs to know about each changed C# file: whether the default branch packs its project, and
// whether its diff touches a public member or a serialized contract. It reads files and text; it never builds or runs
// anything.

import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

const isPackableElement = /<IsPackable(?:\s[^>]*)?>\s*(true|false)\s*<\/IsPackable>/gi;

// What one MSBuild file sets IsPackable to: true when any IsPackable element in it says true, a conditional one
// included, so the floor fails closed; false when each says false; undefined when it has none or doesn't exist; and
// 'unreadable' when it exists but can't be read.
function packableIn(file: string): boolean | undefined | 'unreadable' {
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT' ? undefined : 'unreadable';
  }
  const values = [...text.matchAll(isPackableElement)].map((m) => m[1]!.toLowerCase() === 'true');
  return values.length ? values.includes(true) : undefined;
}

// Whether a project packs, as MSBuild reads IsPackable: each Directory.Build.props from the repository root down to the
// project's folder, then the .csproj, then each Directory.Build.targets from the root down; the last file that sets it
// wins. Reading every props file, outer first, stands in for the usual pattern of each one importing its parent's. A
// file that exists but can't be read makes the project packed, so the floor fails closed.
function projectPacks(basePath: string, folder: string, project: string): boolean {
  const parts = folder ? folder.split('/') : [];
  const folders = ['', ...parts.map((_, i) => parts.slice(0, i + 1).join('/'))];
  const files = [
    ...folders.map((f) => path.join(basePath, f, 'Directory.Build.props')),
    path.join(basePath, folder, project),
    ...folders.map((f) => path.join(basePath, f, 'Directory.Build.targets')),
  ];
  let packs = false;
  for (const file of files) {
    const value = packableIn(file);
    if (value === 'unreadable') return true;
    if (value !== undefined) packs = value;
  }
  return packs;
}

// Whether the .csproj nearest above a file packs it, by PublicAPI.Shipped.txt beside it or IsPackable in it or in the
// Directory.Build.props and .targets above it, read from the default branch's checkout only, so a pull request can't
// make its own project count as packed.
export function isPackableProject(basePath: string, file: string, cache = new Map<string, boolean>()): boolean {
  const parts = file.split('/');
  if (parts.some((p) => p === '' || p === '.' || p === '..')) return false;
  // Every folder the walk passes has no project of its own, so it gets the answer of the one it stops at.
  const visited: string[] = [];
  const answer = (packable: boolean) => {
    for (const folder of visited) cache.set(folder, packable);
    return packable;
  };
  for (let depth = parts.length - 1; depth >= 0; depth--) {
    const folder = parts.slice(0, depth).join('/');
    const known = cache.get(folder);
    if (known !== undefined) return answer(known);
    visited.push(folder);
    let names: string[];
    try {
      names = readdirSync(path.join(basePath, folder));
    } catch {
      continue;
    }
    const projects = names.filter((n) => n.endsWith('.csproj'));
    if (!projects.length) continue;
    return answer(names.includes('PublicAPI.Shipped.txt') || projects.some((p) => projectPacks(basePath, folder, p)));
  }
  return answer(false);
}

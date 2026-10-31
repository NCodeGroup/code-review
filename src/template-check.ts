// Checks a template adoption or update against the template itself: a changed file the template would own is left to
// it only when it is the template's own copy at the _commit the head's answers name, and that commit is on the template's
// default branch or a tag. Otherwise a writer could change _commit and edit the template's files by hand in the same
// pull request, and the edits' findings would go upstream. The template is read through GitHub's API with the run's
// read-only token, and anything that can't be read or confirmed is the project's, so the check fails closed.

import { errorText } from './comments.ts';
import { git, readBlobs } from './gather.ts';
import type { ReadApi } from './github.ts';
import { answersFile, answerValues, matchesTemplateSource, renderedTemplatePaths, templateRef, type TemplateCandidate } from './template.ts';

const sha = /^[0-9a-f]{40}$/;

// The blob SHA of every file at the checkout's HEAD, by path.
function headBlobShas(checkout: string): Map<string, string> {
  const shas = new Map<string, string>();
  for (const entry of git(checkout, ['ls-tree', '-r', '-z', 'HEAD']).split('\0')) {
    const match = /^\d+ blob ([0-9a-f]+)\t([\s\S]+)$/.exec(entry);
    if (match) shas.set(match[2]!, match[1]!);
  }
  return shas;
}

// How many of the template's tags are compared with a commit its default branch doesn't reach, so a template with many
// tags can't make every adoption cost a long run of reads.
const tagsCompared = 3;

// Why a commit isn't the template's own, or undefined when it is: reachable from its default branch or one of its tags.
// GitHub reads a commit from any fork in the template's network at the template's own address, so without this a writer
// could fork the template, edit its files there and name that commit in _commit. A compare whose status is behind or
// identical has the commit as an ancestor of its base. A read that fails throws, and the caller reads that as unread.
async function notTemplateCommit(repository: string, commit: string, ref: string, read: ReadApi): Promise<string | undefined> {
  const branch = ((await read(`/repos/${repository}`)) as { default_branch?: unknown } | undefined)?.default_branch;
  if (typeof branch !== 'string' || !branch) return "its default branch can't be read";
  const reaches = async (base: string) => {
    const comparison = (await read(`/repos/${repository}/compare/${encodeURIComponent(base)}...${commit}`)) as { status?: unknown } | undefined;
    return comparison?.status === 'behind' || comparison?.status === 'identical';
  };
  if (await reaches(branch)) return undefined;
  const refs = await read(`/repos/${repository}/git/matching-refs/tags`);
  if (!Array.isArray(refs)) return `it isn't on ${JSON.stringify(branch)}, and the tags can't be read`;
  const tags: { name: string; sha: unknown; type: unknown }[] = [];
  for (const entry of refs as { ref?: unknown; object?: { sha?: unknown; type?: unknown } }[]) {
    if (typeof entry?.ref === 'string' && entry.ref.startsWith('refs/tags/')) tags.push({ name: entry.ref.slice('refs/tags/'.length), sha: entry.object?.sha, type: entry.object?.type });
  }
  if (tags.some((t) => t.type === 'commit' && t.sha === commit)) return undefined;
  // The tag _commit names is the likeliest to reach it; after it, the newest tags are.
  const newest = tags.map((t) => t.name).filter((n) => n !== ref).sort((a, b) => b.localeCompare(a, 'en', { numeric: true }));
  const tried = [...(tags.some((t) => t.name === ref) ? [ref] : []), ...newest].slice(0, tagsCompared);
  for (const tag of tried) if (await reaches(tag)) return undefined;
  return `it isn't on ${JSON.stringify(branch)} or the ${tried.length} newest tag(s), as a commit from a fork wouldn't be`;
}

// The candidate's files that match the template's own copies. A file the template renders from a .jinja source must be
// its exact rendering with the head's answers, as matchesTemplateSource reads it; any other must be the same blob. A
// file neither has, such as one the template removed and the pull request deleted, matches.
export async function confirmTemplateFiles(candidate: TemplateCandidate, checkout: string, read: ReadApi, log: (line: string) => void = () => {}): Promise<Set<string>> {
  const confirmed = new Set<string>();
  const { files, template } = candidate;
  if (!files.length) return confirmed;
  const repository = template.repository;
  const at = JSON.stringify(candidate.commit);
  const unread = (reason: string) => {
    log(`::warning::Couldn't read ${repository} at ${at} (${reason}), so ${files.length} changed file(s) the template would own are reviewed as the project's.`);
    return confirmed;
  };
  const ref = templateRef(candidate.commit);
  if (!ref) return unread("it isn't a tag or a commit");
  let rendered: ReturnType<typeof renderedTemplatePaths>;
  try {
    const commit = (await read(`/repos/${repository}/commits/${encodeURIComponent(ref)}`)) as { sha?: unknown; commit?: { tree?: { sha?: unknown } } } | undefined;
    const tree = commit?.commit?.tree?.sha;
    if (typeof tree !== 'string' || !sha.test(tree) || typeof commit?.sha !== 'string' || !sha.test(commit.sha)) return unread('no such commit');
    const foreign = await notTemplateCommit(repository, commit.sha, ref, read);
    if (foreign) {
      log(`::warning::Couldn't confirm that ${at} is ${repository}'s own commit (${foreign}), so ${files.length} changed file(s) the template would own are reviewed as the project's.`);
      return confirmed;
    }
    const listing = (await read(`/repos/${repository}/git/trees/${tree}?recursive=1`)) as { truncated?: boolean; tree?: unknown } | undefined;
    if (!listing || listing.truncated || !Array.isArray(listing.tree)) return unread('its file list is missing or truncated');
    rendered = renderedTemplatePaths(listing.tree);
  } catch (error) {
    return unread(errorText(error));
  }
  const heads = headBlobShas(checkout);
  const jinjaFiles = files.filter((f) => rendered.get(f)?.jinja && heads.has(f));
  const headTexts = readBlobs(checkout, 'HEAD', jinjaFiles.length ? [...jinjaFiles, answersFile] : []);
  const answers = answerValues(headTexts.get(answersFile) ?? '');
  for (const file of files) {
    const source = rendered.get(file);
    const head = heads.get(file);
    if (!source || !head) {
      if (!source && !head) confirmed.add(file);
      continue;
    }
    if (!source.jinja) {
      if (source.sha === head) confirmed.add(file);
      continue;
    }
    const text = headTexts.get(file);
    if (text === undefined || !sha.test(source.sha)) continue;
    try {
      const blob = (await read(`/repos/${repository}/git/blobs/${source.sha}`)) as { content?: unknown; encoding?: unknown } | undefined;
      if (blob?.encoding !== 'base64' || typeof blob.content !== 'string') continue;
      if (matchesTemplateSource(Buffer.from(blob.content, 'base64').toString('utf8'), text, answers)) confirmed.add(file);
    } catch {
      // A source that can't be read leaves the file the project's.
    }
  }
  const differ = files.filter((f) => !confirmed.has(f));
  // JSON quoting keeps a path with a line break from starting a workflow command of its own.
  if (differ.length) log(`${differ.length} changed file(s) the template would own differ from ${repository} at ${at}, so they're reviewed as the project's: ${differ.slice(0, 5).map((p) => JSON.stringify(p)).join(', ')}`);
  return confirmed;
}

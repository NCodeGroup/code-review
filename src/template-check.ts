// Checks a template adoption or update against the template itself: a changed file the template would own is left to
// it only when it is the template's own copy at the _commit the head's answers name. Otherwise a writer could change
// _commit and edit the template's files by hand in the same pull request, and the edits' findings would go upstream. The
// template is read through GitHub's API with the run's read-only token, and anything that can't be read is the
// project's, so the check fails closed.

import { errorText } from './comments.ts';
import type { ReadApi } from './explain.ts';
import { git, readBlobs } from './gather.ts';
import { matchesTemplateSource, renderedTemplatePaths, templateRef, type TemplateCandidate } from './template.ts';

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

// The candidate's files that match the template's own copies. A file the template renders from a .jinja source is
// compared with matchesTemplateSource; any other must be the same blob. A file neither has, such as one the template
// removed and the pull request deleted, matches.
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
    const commit = (await read(`/repos/${repository}/commits/${encodeURIComponent(ref)}`)) as { commit?: { tree?: { sha?: unknown } } } | undefined;
    const tree = commit?.commit?.tree?.sha;
    if (typeof tree !== 'string' || !sha.test(tree)) return unread('no such commit');
    const listing = (await read(`/repos/${repository}/git/trees/${tree}?recursive=1`)) as { truncated?: boolean; tree?: unknown } | undefined;
    if (!listing || listing.truncated || !Array.isArray(listing.tree)) return unread('its file list is missing or truncated');
    rendered = renderedTemplatePaths(listing.tree);
  } catch (error) {
    return unread(errorText(error));
  }
  const heads = headBlobShas(checkout);
  const headTexts = readBlobs(checkout, 'HEAD', files.filter((f) => rendered.get(f)?.jinja && heads.has(f)));
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
      if (matchesTemplateSource(Buffer.from(blob.content, 'base64').toString('utf8'), text)) confirmed.add(file);
    } catch {
      // A source that can't be read leaves the file the project's.
    }
  }
  const differ = files.filter((f) => !confirmed.has(f));
  // JSON quoting keeps a path with a line break from starting a workflow command of its own.
  if (differ.length) log(`${differ.length} changed file(s) the template would own differ from ${repository} at ${at}, so they're reviewed as the project's: ${differ.slice(0, 5).map((p) => JSON.stringify(p)).join(', ')}`);
  return confirmed;
}

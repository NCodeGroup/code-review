// A pull request's review threads, read through GraphQL a page at a time. Re-reviews (rereview.ts) and outcomes
// (outcomes.ts) both read them through this, each asking for its own fields of a thread.

import { githubGraphql, type Api } from './github.ts';

export interface ThreadPaging {
  // The GraphQL selection of each thread.
  fields: string;
  pageSize: number;
  maxPages: number;
}

export interface ThreadPages<T> {
  threads: T[];
  // False when there were more pages than maxPages.
  complete: boolean;
}

type ThreadsData = { repository?: { pullRequest?: { reviewThreads?: { pageInfo: { hasNextPage: boolean; endCursor: string | null }; nodes: unknown[] } } } };

// Reads the threads up to `paging.maxPages` pages. Throws when GitHub refuses a page or answers without the threads.
export async function readThreadPages<T>(api: Api, repository: string, number: number, paging: ThreadPaging): Promise<ThreadPages<T>> {
  const query = `query($owner: String!, $name: String!, $number: Int!, $cursor: String) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      reviewThreads(first: ${paging.pageSize}, after: $cursor) {
        pageInfo { hasNextPage endCursor }
        nodes { ${paging.fields} }
      }
    }
  }
}`;
  const [owner, name] = repository.split('/');
  const threads: T[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < paging.maxPages; page++) {
    const data = (await githubGraphql(api, query, { owner, name, number, cursor }, 'the review threads')) as ThreadsData | undefined;
    const connection = data?.repository?.pullRequest?.reviewThreads;
    if (!connection) throw new Error(`Couldn't read the review threads of #${number}.`);
    threads.push(...(connection.nodes as T[]));
    if (!connection.pageInfo.hasNextPage) return { threads, complete: true };
    cursor = connection.pageInfo.endCursor;
  }
  return { threads, complete: false };
}

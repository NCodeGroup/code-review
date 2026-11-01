// Runs fn over items with at most limit calls in flight, keeping the results in the items' order.
export async function mapWithConcurrency<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index]!);
    }
  });
  await Promise.all(workers);
  return results;
}

// Runs each group's first item, its leader, before the rest of the group, which may start once the leader calls
// `started` or finishes, whichever comes first, with at most limit items in flight across all groups. Waiting leaders
// start first, in order; then the released group items, longest-expected first; the items in `after` start only once
// every group has been released.
export async function runLeadersFirst<T>(
  groups: T[][],
  after: T[],
  limit: number,
  expected: (item: T) => number,
  fn: (item: T, started: () => void) => Promise<void>,
): Promise<void> {
  const byLongest = (items: T[]) =>
    items
      .map((item, i) => ({ item, i }))
      .sort((a, b) => expected(b.item) - expected(a.item) || a.i - b.i)
      .map((e) => e.item);
  const leaders = groups.filter((g) => g.length).map((g) => ({ item: g[0]!, rest: g.slice(1) }));
  let unreleased = leaders.length;
  let waiting: T[] = [];
  let tail = unreleased ? [] : byLongest(after);
  let running = 0;
  return new Promise<void>((resolve, reject) => {
    const pump = () => {
      while (running < limit) {
        const leader = leaders.shift();
        const item = leader ? leader.item : (waiting.shift() ?? (unreleased ? undefined : tail.shift()));
        if (item === undefined) break;
        let released = !leader;
        const release = () => {
          if (released) return;
          released = true;
          waiting = byLongest([...waiting, ...leader!.rest]);
          if (--unreleased === 0) tail = byLongest(after);
          pump();
        };
        running++;
        fn(item, release).then(
          () => {
            running--;
            release();
            pump();
          },
          reject,
        );
      }
      if (!running && !leaders.length && !waiting.length && !tail.length) resolve();
    };
    pump();
  });
}

// A finding's severity. It has its own module, imports nothing, so the results and comments code that the
// acknowledgement and finish scripts load doesn't load the review and its npm packages.

export type Severity = 'blocker' | 'should-fix' | 'nit';
// Most severe first.
export const severityRank: Record<Severity, number> = { blocker: 0, 'should-fix': 1, nit: 2 };

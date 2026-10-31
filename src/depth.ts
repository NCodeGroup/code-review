// How deep a review goes. It has its own module, imports nothing, so the results and comments code that the
// acknowledgement and finish scripts load doesn't load the review and its npm packages.

// Deep for a change to a sensitive path, light for one to documentation only.
export type ReviewDepth = 'standard' | 'deep' | 'light';

// How the summary and the check run name a review that isn't standard.
export const depthLabel: Record<ReviewDepth, string> = {
  standard: 'Standard review',
  deep: 'Deep review (sensitive paths)',
  light: 'Light review (documentation only)',
};

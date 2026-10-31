// Why a run moved to Bedrock partway: the refused call's trace outcome and the check run's "Switched to Bedrock" note.
// It has its own module, imports nothing, so the results code that the acknowledgement and finish scripts load doesn't
// load the provider and its configuration.
export const creditsRanOutReason = 'credits ran out';

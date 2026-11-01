// Its own module, importing nothing, so checks.ts, which the acknowledgement and finish scripts load before npm ci, can
// recognize the error without loading the provider and its configuration.

// Neither provider can pay for the review: the credits are used up or the login failed, and the Bedrock key is missing
// or refused. Nothing has been charged. The run reports it as a used-up budget rather than a failure.
export class NoProviderError extends Error {
  readonly reason: string;
  constructor(reason: string) {
    super(`No provider available: ${reason}.`);
    this.reason = reason;
  }
}

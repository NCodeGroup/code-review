# correctness

Does the changed code do what it's meant to do, for every input and order of events it can meet?

Look for: logic errors and off-by-one boundaries; null and default handling, including nullable annotations that lie; error paths that swallow, mistranslate or leak exceptions; async mistakes (sync-over-async, unobserved tasks, missing cancellation propagation, `ConfigureAwait` misuse in library code); races and shared mutable state; disposal (an `IDisposable` or `IAsyncDisposable` that isn't disposed, disposed twice, or used after disposal); culture- and encoding-sensitive string handling; integer overflow; and a change that breaks an invariant other code relies on.

Leave to others: security, public API shape, performance, test coverage and style.
